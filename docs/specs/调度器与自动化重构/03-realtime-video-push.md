# 03 — 实时视频 SSE 推送

## 目标

每发现一条新视频，通过 SSE 实时推送完整视频元数据到前端，前端直接插入到视频列表顶部，无需整体 refetch。

## 依赖

- **02-event-driven-pipeline** — 依赖增强后的 `video:discovered` 事件 payload

## 当前问题

1. SSE route 不监听 `video:discovered` 事件
2. `videos-updated` 事件只在整个 feed scope 从 running 变为非 running 时发送
3. 前端收到 `videos-updated` 后做整体 `refreshLoadedVideos()`（全量 refetch 当前页），无法实时逐条插入

## 新 SSE 事件

### `video-new`

当 `video:discovered` 触发且该视频是真正新增（`INSERT` 的 `changes > 0`）时推送。

**Payload**:

```typescript
interface VideoNewSsePayload {
  id: number;          // videos.id (DB 自增 ID)
  video_id: string;
  platform: 'youtube' | 'bilibili';
  title: string;
  thumbnail_url: string | null;
  published_at: string | null;
  duration: string | null;
  channel_name: string;
  avatar_url: string | null;
  channel_id: string;  // channels.channel_id (平台侧 ID)
  intent: string;      // 频道所属意图
  is_read: 0;
  is_members_only: 0;
  subtitle_status: null;
  summary_status: null;
  automation_tags: null;
}
```

**类型注意**：`VideoWithMeta` 需要扩展以包含 `channel_id` 和 `intent` 字段：

```typescript
export interface VideoWithMeta {
  // ...existing fields...
  channel_id: string;     // 新增：channels.channel_id（平台侧 ID），供前端筛选
  intent: string;         // 新增：频道所属意图，供前端筛选
}
```

对应的 `/api/videos/` SQL 查询也需要 JOIN `channels` 表返回这两个字段（已经 JOIN 了 channel_name，只需多选两列）。

### `subtitle-status`（新增）

字幕状态变更时推送，让前端实时更新视频卡片上的字幕徽章：

```typescript
interface SubtitleStatusSsePayload {
  videoId: string;
  platform: 'youtube' | 'bilibili';
  status: 'pending' | 'fetching' | 'fetched' | 'error' | 'missing' | 'empty' | 'cooldown';
}
```

## SSE Route 变更 (`/api/sse/route.ts`)

### 新增事件监听

```typescript
// 在 start() 中新增：

let onVideoNew: (data: VideoNewSsePayload) => void = () => {};
let onSubtitleStatus: (data: SubtitleStatusSsePayload) => void = () => {};

// Wire up:
onVideoNew = (data) => send('video-new', data);
onSubtitleStatus = (data) => send('subtitle-status', data);
appEvents.on('video:new-full', onVideoNew);
appEvents.on('subtitle:status-changed', onSubtitleStatus);

// cleanup 中新增：
appEvents.removeListener('video:new-full', onVideoNew);
appEvents.removeListener('subtitle:status-changed', onSubtitleStatus);
```

### 保留 `videos-updated` 事件

作为兜底刷新机制保留（处理重启后补偿、手动操作等场景），但不再是主要的视频列表更新途径。

### 移除轮询中的 feed→idle 检测

现有 `tick()` 中检测 feed/subtitle 状态变化来发送 `videos-updated` 的逻辑可以简化——`video-new` 事件已经覆盖了实时更新需求。保留 `crawler-status` 轮询用于状态栏。

## 后端事件发射

### `scheduler.ts` — `insertOrUpdateVideos`

修改现有的 `video:discovered` emit，同时发射一个携带完整数据的 `video:new-full` 事件：

```typescript
if (result.changes > 0) {
  added += 1;

  // 现有事件（供 auto-pipeline 使用）
  appEvents.emit('video:discovered', {
    videoId: video.video_id,
    platform: video.platform,
    channelId: channel.channel_id,
    at: nowIso(),
  });

  // 新事件（供 SSE 推送到前端）
  appEvents.emit('video:new-full', {
    id: getVideoDbId(video.video_id, video.platform),  // 查 DB 获取自增 ID
    video_id: video.video_id,
    platform: video.platform,
    title: video.title || '',
    thumbnail_url: video.thumbnail_url || null,
    published_at: video.published_at || null,
    duration: video.duration || null,
    channel_name: channel.name || channel.channel_id,
    avatar_url: channel.avatar_url || null,
    channel_id: channel.channel_id,
    intent: channel.intent || '未分类',
    is_read: 0,
    is_members_only: 0,
    subtitle_status: null,
    summary_status: null,
    automation_tags: null,
  });
}
```

### `subtitles.ts` — `ensureSubtitleForVideo`

在状态变更后发射 `subtitle:status-changed`：

```typescript
appEvents.emit('subtitle:status-changed', {
  videoId: video.video_id,
  platform: video.platform,
  status: newStatus,
});
```

## 前端变更 (`src/app/page.tsx`)

### 监听 `video-new` 事件

```typescript
es.addEventListener('video-new', (event) => {
  try {
    const newVideo = JSON.parse(event.data) as VideoWithMeta;

    // 检查是否匹配当前筛选条件
    if (platform && newVideo.platform !== platform) return;
    if (intent && newVideo.intent !== intent) return;
    if (channel_id && newVideo.channel_id !== channel_id) return;

    // 插入到列表顶部，避免重复
    setVideos((prev) => {
      if (prev.some((v) => v.video_id === newVideo.video_id)) return prev;
      return [newVideo, ...prev];
    });
  } catch {}
});
```

### 监听 `subtitle-status` 事件

```typescript
es.addEventListener('subtitle-status', (event) => {
  try {
    const { videoId, status } = JSON.parse(event.data);
    setVideos((prev) =>
      prev.map((v) =>
        v.video_id === videoId ? { ...v, subtitle_status: status } : v,
      ),
    );
  } catch {}
});
```

### 移除频繁的 `refreshLoadedVideos` 调用

- `videos-updated` 事件处理器中的 `refreshLoadedVideos()` 保留为兜底
- 添加防抖/节流：至少 5 秒内不重复 refetch
- `summary-complete` 和 `summary-error` 的处理保留（精准更新单条视频状态）

### 新视频插入动画（可选增强）

新插入的视频卡片可以添加 CSS 动画标记：

```typescript
// 为新插入的视频设置 isNew 标记，3 秒后清除
setVideos((prev) => {
  if (prev.some((v) => v.video_id === newVideo.video_id)) return prev;
  return [{ ...newVideo, _isNew: true }, ...prev];
});

// 3 秒后清除标记
setTimeout(() => {
  setVideos((prev) =>
    prev.map((v) =>
      v.video_id === newVideo.video_id ? { ...v, _isNew: false } : v,
    ),
  );
}, 3000);
```

```css
.video-card.is-new {
  animation: slideIn 0.3s ease-out;
}

@keyframes slideIn {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}
```

## 辅助函数

### `getVideoDbId`

```typescript
function getVideoDbId(videoId: string, platform: string): number | null {
  const row = getDb()
    .prepare('SELECT id FROM videos WHERE video_id = ? AND platform = ?')
    .get(videoId, platform) as { id: number } | undefined;
  return row?.id ?? null;
}
```

注意：此函数在 `INSERT OR IGNORE` 之后同步调用，由于 `better-sqlite3` 是同步的，行必然已存在。返回 `null` 作为防御性处理，调用方在 `id === null` 时跳过 SSE 推送。
```

## 验收标准

1. 爬取过程中，每发现一个新视频，前端列表顶部实时出现该视频卡片
2. 新视频卡片包含完整信息（标题、封面、频道名、发布时间）
3. 新视频如果不匹配当前筛选条件（平台/意图/频道），则不插入
4. 字幕状态变更时，对应视频卡片上的字幕徽章实时更新
5. 不会因为 SSE 推送导致列表闪烁或重复项
6. 页面失去焦点/SSE 断开重连后，兜底 `videos-updated` 机制仍然正常
7. 新视频插入时有平滑的入场动画
