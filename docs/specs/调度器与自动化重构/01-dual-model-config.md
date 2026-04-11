# 01 — 双模型配置（自动/手动）

## 目标

区分"自动总结"和"手动总结"使用的 AI 模型。自动总结使用更便宜/更快的模型，手动总结使用更强的模型。意图可以覆盖自动总结模型。

## 当前状态

- `ai-summary-settings.ts` 管理 `AiSummaryConfigDocument`，包含 `models[]` 数组和 `defaultModelId`
- `specialRules[]` 按 channelId 匹配覆盖模型/prompt — 将随规则系统一起移除
- `resolveAiSummaryGenerationSettings()` 解析最终使用的模型，支持 channelId 和 modelIdOverride
- `intents` 表有 `auto_subtitle`、`auto_summary` 列，但没有模型相关列

## 数据模型变更

### `intents` 表新增列

```sql
ALTER TABLE intents ADD COLUMN auto_summary_model_id TEXT DEFAULT NULL;
```

- `NULL` 表示使用全局自动默认模型
- 非空值必须是 `AiSummaryConfigDocument.models[]` 中某个模型的 `id`

### `AiSummaryConfigDocument` 扩展

```typescript
interface AiSummaryConfigDocument {
  version: 3;  // 从 2 升级
  promptTemplates: AiSummaryPromptTemplates;
  // specialRules 移除（规则系统清理时删除）
  defaultModelId: string;        // 手动总结默认模型
  autoDefaultModelId: string;    // 自动总结默认模型（新增）
  models: AiSummaryModelConfig[];
}
```

- `defaultModelId` → 重命名语义为"手动总结默认模型"（代码变量名不变，减少 churn）
- `autoDefaultModelId` → 新增字段，自动总结的全局默认模型
- 迁移：首次加载 version=2 文档时，`autoDefaultModelId` 默认设为 `defaultModelId` 的值

## 模型解析逻辑

### 新增 `triggerSource` 参数

```typescript
type SummaryTriggerSource = 'manual' | 'auto';

interface ResolveAiSummaryGenerationOptions {
  channelId?: string | null;
  modelIdOverride?: string | null;
  triggerSource?: SummaryTriggerSource;  // 新增
  intentName?: string | null;           // 新增
}
```

### 解析优先级

**手动触发** (`triggerSource = 'manual'`):
1. `modelIdOverride` → 用户在 UI 中显式选择的模型
2. `defaultModelId` → 全局手动默认模型

**自动触发** (`triggerSource = 'auto'`):
1. 意图的 `auto_summary_model_id` → 该意图指定的自动模型
2. `autoDefaultModelId` → 全局自动默认模型
3. `defaultModelId` → 最终兜底

### `resolveSelectedModel` 修改

```typescript
function resolveSelectedModel(
  config: AiSummaryConfigDocument,
  options?: ResolveAiSummaryGenerationOptions,
): { model: AiSummaryModelConfig; source: string } {
  // 1. 显式覆盖（最高优先级）
  if (options?.modelIdOverride) {
    const m = findModel(config, options.modelIdOverride);
    if (m) return { model: m, source: 'override' };
  }

  // 2. 手动触发 → 使用手动默认模型
  if (!options?.triggerSource || options.triggerSource === 'manual') {
    return {
      model: findModel(config, config.defaultModelId) || config.models[0],
      source: 'default',
    };
  }

  // 3. 自动触发 → 优先意图模型 → 全局自动模型 → 兜底
  if (options.intentName) {
    const intentModelId = getIntentAutoModelId(options.intentName);
    if (intentModelId) {
      const m = findModel(config, intentModelId);
      if (m) return { model: m, source: 'intent' };
    }
  }

  const autoModel = findModel(config, config.autoDefaultModelId);
  if (autoModel) return { model: autoModel, source: 'auto-default' };

  return {
    model: findModel(config, config.defaultModelId) || config.models[0],
    source: 'fallback',
  };
}
```

## API 变更

### `GET/PUT /api/settings/ai-summary/`

响应和请求体增加 `autoDefaultModelId` 字段：

```json
{
  "models": [...],
  "defaultModelId": "model-strong",
  "autoDefaultModelId": "model-fast",
  "promptTemplates": { "default": "..." }
}
```

### `PATCH /api/settings/intents/[id]/`

请求体支持 `auto_summary_model_id`：

```json
{
  "auto_summary_model_id": "model-fast"
}
```

`null` 或空字符串表示清除，使用全局自动默认模型。

## 前端变更

### AI 设置页

- 现有"默认模型"下拉框 → 标签改为"手动总结模型"
- 新增"自动总结模型"下拉框，从同一个 `models[]` 列表选择
- 移除 `specialRules` 配置 UI（随规则移除）

### 意图管理页

- 每个意图行增加可选的"自动总结模型"下拉框（`auto_summary` 开关开启时显示）
- 选项：["使用全局自动模型（默认）", ...models[].map(m => m.name)]

## `GenerateSummaryOptions` 扩展

`ai-summary-client.ts` 的 `GenerateSummaryOptions` 需要新增字段以传递触发来源：

```typescript
interface GenerateSummaryOptions {
  modelIdOverride?: string | null;
  abortSignal?: AbortSignal;
  triggerSource?: SummaryTriggerSource;  // 新增
  intentName?: string | null;           // 新增
}
```

`generateSummaryViaApi` 和 `generateSummaryStream` 需要将这两个字段透传给 `resolveSummaryGenerationContext`，再传给 `resolveAiSummaryGenerationSettings`。

## 调用方适配

### `summary-queue.ts`（自动总结）

```typescript
const result = await generateSummaryViaApi(task.video_id, task.platform, {
  triggerSource: 'auto',
  intentName: channelIntent,  // 从 channel 表查询
});
```

### `POST /api/videos/[id]/summary/generate`（手动总结）

```typescript
const result = await generateSummaryViaApi(videoId, platform, {
  triggerSource: 'manual',
  modelIdOverride: body.modelId,  // 用户可选
});
```

## 迁移

- version 2 → 3 迁移在 `normalizeConfigDocument` 中处理
- `autoDefaultModelId` 未设置时取 `defaultModelId` 的值
- `specialRules` 字段在 version 3 中忽略（spec 05 中物理删除）
- `intents` 表的 `ALTER TABLE ADD COLUMN` 在 `db.ts` 的 schema 初始化中执行

## 验收标准

1. AI 设置页可以分别配置手动模型和自动模型
2. 意图管理页可以为每个意图指定自动总结模型（可选）
3. 手动点击视频的"生成总结"按钮使用手动模型
4. 调度器自动总结使用自动模型，优先级：意图模型 > 全局自动模型 > 兜底
5. 模型解析结果在 summary 文件的 YAML frontmatter 中正确记录 `trigger_source` 和 `model_source`
6. 现有 `specialRules` 在本 spec 中不删除代码，但不再影响解析逻辑（被 triggerSource 路径取代）
7. `AiSummaryConfigDocument.version` 升级为 3（spec 05 不再重复升级）
