# 04 — 任务面板 UI 重设计

## 目标

将状态栏从当前的三段式文字标签（📡 订阅 / 💬 字幕 / 🤖 自动）重设计为：
1. **紧凑态**：一行显示核心状态 + "X 分钟前更新"相对时间
2. **展开态**：可点击展开的 mini 任务面板，显示各队列详情

## 依赖

- **02-event-driven-pipeline** — `getAutoPipelineStatus()` 提供字幕/总结队列状态
- **03-realtime-video-push** — SSE 事件推送供面板实时更新

## 当前组件

`CrawlerCompactBar.tsx` — 接收 `CrawlerRuntimeStatus` + `SummaryQueueState`，渲染三段式状态。

## 新组件：`TaskStatusBar.tsx`

替代 `CrawlerCompactBar.tsx`。

### 紧凑态设计

```
┌──────────────────────────────────────────────────────────────┐
│ 🔄 爬取中 5/23  │  💬 字幕 2 处理中  │  📝 总结 1 待处理  │  ⏱ 3 分钟前  │  ⏸ ▾ │
└──────────────────────────────────────────────────────────────┘
```

四个信息区域 + 操作按钮：

| 区域 | 数据源 | 状态文案 |
|---|---|---|
| 爬取 🔄 | `CrawlerScopeStatus.feed` | 空闲 / 爬取中 N/M / 错误 |
| 字幕 💬 | `AutoPipelineStatus.subtitle` | 空闲 / N 处理中 / N 失败 |
| 总结 📝 | `AutoPipelineStatus.summary` | 空闲 / N 待处理 / 处理中 "视频标题..." |
| 上次更新 ⏱ | `lastCrawlAt` | "刚刚" / "X 分钟前" / "X 小时前" / "从未" |

操作按钮：
- ⏸ 暂停/继续
- ▾ 展开面板

### 相对时间逻辑

```typescript
function formatRelativeTime(isoString: string | null): string {
  if (!isoString) return '从未';
  const diffMs = Date.now() - Date.parse(isoString);
  if (diffMs < 60_000) return '刚刚';
  if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)} 分钟前`;
  if (diffMs < 86400_000) return `${Math.floor(diffMs / 3600_000)} 小时前`;
  return `${Math.floor(diffMs / 86400_000)} 天前`;
}
```

`lastCrawlAt` 来源：`SchedulerStatus.lastCrawl`。每 30 秒重新计算一次显示文本。

### 展开态设计

点击 ▾ 按钮或整个状态栏，展开下方面板：

```
┌──────────────────────────────────────────────────────────────┐
│  紧凑态状态栏（同上）                                          │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  📡 爬取                                    3 分钟前完成      │
│  ├ 下次爬取：14:30（11 分钟后）                                │
│  └ 今日新增：12 个视频                                        │
│                                                              │
│  💬 字幕队列                                   2 / 5 完成     │
│  ├ 正在处理：如何看待2025年经济趋势                              │
│  ├ 等待中：3 个                                               │
│  └ 今日完成：8 条                                             │
│                                                              │
│  📝 总结队列                                   处理中          │
│  ├ 正在处理：Best Partners TV - 最新一期                       │
│  │  模型：gemini-2.5-flash-lite · 已接收 2,400 字              │
│  ├ 待处理：1 个                                               │
│  └ 今日完成：3 条                                             │
│                                                              │
│  ⚙️ 调度器设置                                                │
│  ├ 状态：运行中                                               │
│  ├ 爬取间隔：2 小时                                           │
│  └ [关闭调度器]                                               │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 数据源映射

| UI 元素 | 数据源 | SSE 事件 |
|---|---|---|
| 爬取进度 N/M | `CrawlerRuntimeStatus.feed.progress/total` | `crawler-status` |
| 爬取当前频道 | `CrawlerRuntimeStatus.feed.targetLabel` | `crawler-status` |
| 字幕队列深度 | `AutoPipelineStatus.subtitle.queueLength` | `pipeline-status` |
| 字幕当前视频 | `AutoPipelineStatus.subtitle.currentVideoId` | `pipeline-status` |
| 总结待处理数 | `AutoPipelineStatus.summary.queueLength` | `pipeline-status` |
| 总结当前视频 | `SummaryQueueState.currentTitle` | `summary-stats` |
| 总结模型/字数 | `SummaryProgressEvent.modelName/receivedChars` | `summary-progress` |
| 上次更新时间 | `SchedulerStatus.lastCrawl` | `crawler-status` (from scheduler) |
| 下次爬取时间 | `SchedulerStatus.nextCrawl` | `crawler-status` (from scheduler) |
| 今日统计 | `SchedulerStatus.todayStats` | `crawler-status` (from scheduler) |

注意：总结详情（模型名、已接收字数）来自 `summary-progress` SSE 事件，需要在前端状态中额外维护一个 `currentSummaryProgress` 状态。

### 组件结构

```typescript
interface TaskStatusBarProps {
  crawlerStatus: CrawlerRuntimeStatus | null;
  pipelineStatus: AutoPipelineStatus | null;  // 来自 pipeline-status SSE
  schedulerStatus: SchedulerStatus | null;
  summaryQueueState: SummaryQueueState | null;  // 来自 summary-stats SSE
  summaryProgress: SummaryProgressEvent | null;  // 来自 summary-progress SSE
  onTogglePause: () => void;
  pausePending: boolean;
}

function TaskStatusBar(props: TaskStatusBarProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="task-status-bar">
      <CompactRow ... onClick={() => setExpanded(!expanded)} />
      {expanded && <TaskPanel ... />}
    </div>
  );
}
```

### 子组件

- `CompactRow` — 紧凑态一行
- `TaskPanel` — 展开面板
- `CrawlSection` — 爬取区域
- `SubtitleSection` — 字幕队列区域
- `SummarySection` — 总结队列区域
- `SchedulerSettings` — 调度器设置区域
- `RelativeTime` — 相对时间显示组件（自动每 30s 更新）

## SSE 数据需求

### 新增 SSE 事件：`pipeline-status`

在现有 SSE route 的 `tick()` 中，除了 `crawler-status` 外，同时推送 pipeline 状态：

```typescript
// 在 tick() 中新增：
const pipelineStatus = getAutoPipelineStatus();
const pipelineSerialized = JSON.stringify(pipelineStatus);
if (pipelineSerialized !== previousPipelineStatus) {
  send('pipeline-status', pipelineStatus);
  previousPipelineStatus = pipelineSerialized;
}
```

### 前端 SSE 监听

```typescript
es.addEventListener('pipeline-status', (event) => {
  try {
    setPipelineStatus(JSON.parse(event.data));
  } catch {}
});
```

## API 变更

### `GET /api/scheduler/` 响应扩展

新增 `pipeline` 字段：

```json
{
  "config": { "enabled": true, "crawlInterval": 7200 },
  "status": { ... },
  "pipeline": {
    "subtitle": { "queueLength": 3, "processing": true, "currentVideoId": "xxx", "stats": { "completed": 8, "failed": 1 } },
    "summary": { "queueLength": 1, "processing": true, "currentVideoId": "yyy" }
  }
}
```

## 样式

### 紧凑态

- 固定在内容区顶部，与现有 toolbar 同行
- 高度 36px，字号 13px
- 使用现有 CSS 变量：`--text-secondary`, `--text-muted`, `--accent-bili`, `--accent-yt`, `--border`
- 运行中的项目使用 `status-pulse` 动画（已有 CSS class）
- 相对时间使用 `--text-muted` 色

### 展开态

- 从紧凑态下方滑出，最大高度 400px，超出滚动
- 背景 `var(--bg-card)`，圆角 8px，阴影 `0 4px 12px rgba(0,0,0,0.1)`
- 各区域用分隔线隔开
- 树状缩进使用 `├` `└` 字符或 CSS 左边距
- 动画：展开 `max-height` transition 0.2s

### 交互

- 点击紧凑态任意位置展开/收起
- 点击面板外部收起
- ⏸ 暂停按钮在面板外保留，不被展开遮挡
- 键盘 Escape 收起

## 类型导出

`AutoPipelineStatus` 需要导出到 `src/types/index.ts`：

```typescript
export interface AutoPipelineStatus {
  subtitle: {
    queueLength: number;
    processing: boolean;
    currentVideoId: string | null;
    stats: { completed: number; failed: number };
  };
  summary: {
    queueLength: number;
    processing: boolean;
    currentVideoId: string | null;
  };
}
```

## 移除内容

- `CrawlerCompactBar.tsx` — 被 `TaskStatusBar.tsx` 替代
- `page.tsx` 中对 `CrawlerCompactBar` 的引用替换为 `TaskStatusBar`

## 验收标准

1. 紧凑态显示爬取/字幕/总结三个区域的当前状态和"X 分钟前更新"
2. 爬取中时显示进度 N/M 和当前频道名
3. 字幕/总结队列有任务时显示队列深度
4. 总结处理中时显示当前视频标题和模型名
5. 点击可展开任务面板，显示各队列详细信息
6. 展开面板中可以看到下次爬取时间、今日统计
7. 展开面板中有调度器开关和爬取间隔设置
8. 相对时间每 30 秒自动更新（不闪烁）
9. 面板展开/收起有平滑动画
10. 面板外点击或 Escape 可收起
