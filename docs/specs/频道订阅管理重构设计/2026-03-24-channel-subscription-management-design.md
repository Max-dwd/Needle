# 频道订阅管理重构设计

## 背景

Needle 当前的频道管理使用 `category`（单字符串主题）+ `category2`（单字符串副标签）模型。在 100-300 个频道的规模下，存在以下问题：

1. **分类体系混乱** — 两个字段语义不清，没有区分"频道是什么"和"我为什么关注它"
2. **侧边栏组织不佳** — 按主题平铺（10-20 组），category2 导致频道重复出现
3. **批量管理缺失** — 导入后全部"未分类"，没有批量分类工具
4. **频道管理页简陋** — 无搜索、排序、筛选，管理几十个频道就很费力

## 核心设计决策

### 双维度模型：意图 × 主题

将频道的组织拆为两个正交维度：

- **意图（intent）** — 用户的认知类目，描述"我为什么关注这个频道"。3-5 个固定值，单选。是日常导航的**一级维度**。
- **主题（topics）** — 频道的内容属性标签，描述"这个频道讲什么"。10-20 个自由标签，多选。是辅助识别的**二级维度**。

设计原则：**频道单意图，内容多路由。** 每个频道在用户认知中只有一个"家"，保持管理简单。未来 AI 日报系统基于主题标签做跨意图的内容路由和去重，不需要频道本身归属多个意图。

### 意图作为一等实体

意图不仅是标签，更是**配置档案**——每个意图自带处理策略（是否自动抓字幕、是否自动生成摘要）。这让常见的自动化行为通过简单开关即可配置，而非编写复杂的 automation rules。

---

## 1. 数据模型

### 1.1 新增 `intents` 表

```sql
CREATE TABLE intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  auto_subtitle INTEGER DEFAULT 1,
  auto_summary INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

默认数据：

| name   | auto_subtitle | auto_summary | sort_order |
|--------|:---:|:---:|:---:|
| 工作   | 1 | 1 | 0 |
| 娱乐   | 0 | 0 | 1 |
| 探索   | 1 | 0 | 2 |
| 新闻   | 1 | 1 | 3 |
| 未分类 | 0 | 0 | 99 |

### 1.2 `channels` 表新增字段

```sql
ALTER TABLE channels ADD COLUMN intent TEXT DEFAULT '未分类';
ALTER TABLE channels ADD COLUMN topics TEXT DEFAULT '[]';
```

- `intent` — 单选字符串，引用 `intents.name`（软引用，非 FK）
- `topics` — JSON 数组字符串，如 `'["AI", "前端"]'`

### 1.3 数据迁移

```sql
-- 旧 category 值迁移为 topics 数组
UPDATE channels
SET topics = '["' || category || '"]'
WHERE category IS NOT NULL AND category != '' AND category != '未分类';

-- intent 默认为 '未分类'（旧 category2 语义不同，不做映射）
-- 旧字段 category/category2 保留不删除
```

### 1.4 TypeScript 接口

```typescript
export interface Intent {
  id: number;
  name: string;
  auto_subtitle: number; // 0 | 1
  auto_summary: number;  // 0 | 1
  sort_order: number;
  created_at: string;
}

export interface Channel {
  id: number;
  platform: 'youtube' | 'bilibili';
  channel_id: string;
  name: string | null;
  avatar_url: string | null;
  intent: string;     // 单选
  topics: string[];   // 多选，API 层解析为数组
  crawl_error_count: number;
  crawl_backoff_until: string | null;
  created_at: string;
}
```

---

## 2. 侧边栏重构

### 2.1 结构

```
Needle                          [+] [⚙]
────────────────────────────────────
📹 全部视频                    (523)
▶  YouTube
🅱 B站
────────────────────────────────────
▸ 工作                         (187)
    channel-A                [AI] [前端]
    channel-B                [后端]
▸ 娱乐                         (142)
    channel-D                [游戏]
▸ 探索                          (89)
▸ 新闻                          (65)
▸ 未分类                        (40)
```

### 2.2 行为

- 一级分组按 `intents` 表的 `sort_order` 排列
- 点击意图名 → 首页过滤：`/?intent=工作`
- 展开后显示该意图下的频道，按 `video_count` 降序排列
- 频道旁显示 topics 小标签（灰底圆角，`font-size: 10px`，最多 2 个 + `+N` 溢出）
- 每个频道只出现一次（intent 单选，无重复）
- 平台筛选与意图筛选独立，不做交叉组合

---

## 3. 频道管理页改造

### 3.1 新增功能

**搜索：** 顶部搜索栏，实时客户端过滤频道名称。

**筛选栏：**
- 平台 pill 按钮：`[全部] [YouTube] [B站]`
- 意图 pill 按钮：`[全部] [工作] [娱乐] [探索] [新闻] [未分类]`

**排序：** 可切换按钮：`[视频数 ↓] [名称] [订阅时间]`

**分组展示：** 默认按意图分组，每组标题显示组名 + 频道数 + "全选本组"按钮。未分类组始终排在最后。

### 3.2 批量操作

每个频道卡片左侧加 checkbox。选中后显示批量操作栏：
- **设置意图** — 下拉选择器，一键应用到所有选中频道
- **添加主题** — 输入标签，追加到所有选中频道的 topics
- **批量删除** — 需二次确认

典型工作流：筛选"未分类" → 搜索关键词 → 全选 → 设置意图 → 添加主题

### 3.3 单频道编辑

- **意图：** 下拉选择器（数据源为 `intents` 表），替代旧的自由文本
- **主题：** Tag input 组件——显示为彩色小标签，点击编辑，支持 autocomplete（数据源为所有频道现有 topics 去重）

### 3.4 新增 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `PATCH /api/channels/[id]` | PATCH | 扩展支持 `{ intent, topics }` |
| `POST /api/channels/bulk-update` | POST | `{ ids: number[], intent?: string, addTopics?: string[], removeTopics?: string[] }` |
| `GET /api/channels` | GET | 返回中增加 `intent`、`topics`（已解析数组） |

---

## 4. 首页视频流适配

### 4.1 URL 参数

| 参数 | 说明 |
|------|------|
| `intent` | 按意图筛选（替代旧 `category`） |
| `topic` | 按主题筛选（新增，低频） |
| `platform` | 按平台筛选（不变） |
| `channel_id` | 按频道筛选（不变） |

### 4.2 查询逻辑

```sql
-- 按意图
WHERE c.intent = :intent

-- 按主题（JSON 数组包含匹配）
WHERE EXISTS (SELECT 1 FROM json_each(c.topics) WHERE json_each.value = :topic)

-- 未分类
WHERE c.intent IS NULL OR c.intent = '' OR c.intent = '未分类'
```

### 4.3 页面标题

- `/?intent=工作` → "工作"
- `/?intent=工作&platform=youtube` → "工作 · YouTube"
- `/?topic=AI` → "主题：AI"
- `/?channel_id=123` → 频道名

### 4.4 刷新范围

`/api/videos/refresh` 支持 `intent` 参数替代旧 `category`。

---

## 5. Markdown 导出/导入

### 5.1 新格式

```markdown
# Needle Subscriptions

## 工作
- [3Blue1Brown](https://youtube.com/channel/UC...) `youtube:UC...` #AI #数学
- [Fireship](https://youtube.com/channel/UC...) `youtube:UC...` #前端 #速报

## 娱乐
- [GamersNexus](https://youtube.com/channel/UC...) `youtube:UC...` #硬件 #评测

## 未分类
- [某频道](https://youtube.com/channel/UC...) `youtube:UC...`
```

- 一级标题（`##`）= intent
- `#tag` = topics
- backtick 中的前缀（`youtube:` / `bilibili:`）= 平台 + channel_id

### 5.2 向后兼容

导入时检测格式：如果一级标题为 "YouTube" / "Bilibili"，走旧解析逻辑，将 category 映射为 topics。

---

## 6. 意图管理设置页

### 6.1 位置

设置页（`/settings`）新增"意图管理"板块。

### 6.2 UI

表格形式，每行一个意图：

| 意图名称 | 自动抓字幕 | 自动AI摘要 | 排序 | 操作 |
|----------|:---:|:---:|:---:|------|
| 工作     | ✅ | ✅ | [↑][↓] | [✎][🗑] |
| 娱乐     | ❌ | ❌ | [↑][↓] | [✎][🗑] |
| 探索     | ✅ | ❌ | [↑][↓] | [✎][🗑] |
| 新闻     | ✅ | ✅ | [↑][↓] | [✎][🗑] |
| 未分类   | ❌ | ❌ | —     | [✎]    |

- 添加意图：输入名称 + 选择默认策略
- 编辑：改名、切换开关
- 删除：需确认，该意图下的频道回退到"未分类"
- 未分类不可删除，但可编辑策略
- 排序影响侧边栏显示顺序

### 6.3 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `GET /api/settings/intents` | GET | 获取全部意图（按 sort_order） |
| `POST /api/settings/intents` | POST | 创建意图 |
| `PATCH /api/settings/intents/[id]` | PATCH | 更新意图 |
| `DELETE /api/settings/intents/[id]` | DELETE | 删除意图（频道回退到未分类） |
| `POST /api/settings/intents/reorder` | POST | 批量更新 sort_order |

---

## 7. Pipeline 集成

### 7.1 意图策略与自动化规则的关系

- **意图策略** = 默认行为（简单开关）
- **automation_rules** = 覆盖/高级规则

执行顺序：先匹配 automation_rules（如果命中 skip 等动作，优先执行），再 fallback 到意图策略。

### 7.2 Pipeline 改造

```
new_video 阶段：
  1. 匹配 automation_rules → 如果命中，执行规则动作
  2. 否则，查 channel.intent → 查 intents 表 auto_subtitle
     → 开启则加入字幕抓取队列

subtitle_ready 阶段：
  1. 匹配 automation_rules → 如果命中，执行规则动作
  2. 否则，查 channel.intent → 查 intents 表 auto_summary
     → 开启则创建 summary_task
```

### 7.3 Automation Rules 适配

`rules.ts` 中条件字段变更：
- 旧 `category` 条件 → 拆为 `intent`（精确匹配）和 `topics`（数组包含匹配）

---

## 8. 受影响的文件清单

| 文件 | 改动类型 |
|------|----------|
| `src/lib/db.ts` | 新增 intents 表、channels 加字段、迁移逻辑、接口更新 |
| `src/components/AppSidebar.tsx` | 按 intent 分组、显示 topics 标签、读取 sort_order |
| `src/app/channels/page.tsx` | 搜索、筛选、排序、批量操作、新编辑器 |
| `src/app/api/channels/route.ts` | GET 返回 intent/topics；POST 支持新字段 |
| `src/app/api/channels/[id]/route.ts` | PATCH 支持 intent/topics |
| `src/app/api/channels/bulk-update/route.ts` | **新增** |
| `src/app/api/videos/route.ts` | 查询条件改为 intent/topic |
| `src/app/api/videos/refresh/route.ts` | 刷新范围改为 intent |
| `src/app/api/channels/markdown/route.ts` | 新导出/导入格式 |
| `src/app/api/channels/categories/route.ts` | 改为 intents + topics 聚合统计 |
| `src/lib/channel-markdown.ts` | 新格式解析/生成 |
| `src/lib/rules.ts` | 条件匹配改为 intent + topics |
| `src/lib/pipeline.ts` | 加入意图策略检查 |
| `src/app/page.tsx` | URL 参数改为 intent/topic |
| `src/app/settings/page.tsx` | 新增意图管理板块 |
| `src/app/api/settings/intents/route.ts` | **新增** 意图 CRUD API |
| `src/app/api/settings/intents/[id]/route.ts` | **新增** 单意图操作 |
| `src/app/api/settings/intents/reorder/route.ts` | **新增** 排序 API |

## 9. 不在本次范围

- AI 日报系统（本次建好数据基础，日报系统单独设计）
- 跨内容源扩展（推特、文章等未来内容类型）
- Topics 与日报的内容路由逻辑（属于日报系统的设计范畴）
