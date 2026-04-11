# 05 — 规则系统完全移除

## 目标

移除自动化规则引擎的全部代码、数据库表、API 路由和 UI 组件。意图系统已完全取代其功能。

## 依赖

- **02-event-driven-pipeline** — pipeline 已替代规则引擎的所有功能后，才能安全移除

## 前置条件

在执行本 spec 之前，确认以下已完成：
- `auto-pipeline.ts` 已接管 `video:discovered` 和 `subtitle:ready` 事件处理
- 意图的 `auto_subtitle` / `auto_summary` 已成为唯一的自动化开关
- `scheduler.ts` 不再调用 `pipeline.ts` 或 `rules.ts` 中的任何函数
- `summary-queue.ts` 不再调用 `getSummaryControlDecision`

## 移除清单

### 数据库表

在 `src/lib/db.ts` 的 schema 初始化中：

1. **移除 `automation_rules` 表的 CREATE TABLE 语句**
2. **移除 `rule_executions` 表的 CREATE TABLE 语句**
3. **移除 `output_plugins` 表的 CREATE TABLE 语句**
4. **新增迁移**：`DROP TABLE IF EXISTS automation_rules; DROP TABLE IF EXISTS rule_executions; DROP TABLE IF EXISTS output_plugins;`

### Lib 文件

| 文件 | 动作 |
|---|---|
| `src/lib/pipeline.ts` | **删除整个文件** |
| `src/lib/rules.ts` | **删除整个文件** |
| `src/lib/outputs.ts` | **删除整个文件** |

### API 路由

| 路由 | 动作 |
|---|---|
| `src/app/api/automation/rules/route.ts` | **删除** |
| `src/app/api/automation/rules/[id]/route.ts` | **删除** |
| `src/app/api/automation/executions/route.ts` | **删除** |
| `src/app/api/automation/outputs/route.ts` | **删除** |
| `src/app/api/automation/outputs/[id]/route.ts` | **删除** |

删除整个 `src/app/api/automation/` 目录。

### 组件

| 文件 | 动作 |
|---|---|
| `src/components/AutomationRulesSettings.tsx` | **删除整个文件** |

### 设置页面引用

在设置页面中移除自动化规则的 tab / section：
- 搜索所有引用 `AutomationRulesSettings` 的文件，移除 import 和渲染

### AI 设置中的 specialRules

在 `src/lib/ai-summary-settings.ts` 中：

1. **移除 `specialRules` 字段**（从 `AiSummaryConfigDocument` 接口中）
2. **移除 `normalizeSpecialRules` 函数**
3. **移除 `mergeLegacyChannelOverrides` 函数**
4. **移除 `findMatchingRule` 函数**
5. **从 `resolvePromptTemplate` 中移除 rule 匹配逻辑**，prompt 直接返回 `promptTemplates.default`
6. **从 `resolveSelectedModel` 中移除 channelId/rule 匹配路径**（已被 triggerSource 路径取代）
7. **移除 `SetAiSummarySettingsInput.specialRules` 字段**
8. **version 升级为 3**，迁移时丢弃 `specialRules` 数据

### Types 清理

在 `src/types/index.ts` 中移除：

```typescript
// 移除这些类型
AutomationStage
AutomationCondition
AutomationAction
AutomationRule
AutomationRuleMatch
AutomationVideoContext
RuleExecution
AiSummarySpecialRule
```

### Scheduler 清理

在 `src/lib/scheduler.ts` 中：

1. **移除** `import { ensureAutomationPipeline, processAutomationStage } from './pipeline'`
2. **移除** `import { getSummaryControlDecision, loadAutomationVideoContext, recordRuleExecution } from './rules'`
3. **移除** `runSummaryTick` 中所有规则相关逻辑（整个函数已在 spec 02 中移除）

### Summary Queue 清理

`summary-queue.ts` 的 `runQueueLoop()` 调用了 `ensureAutomationPipeline()`：

```typescript
// 移除这行：
ensureAutomationPipeline();
// 替换为（如果需要）：
// ensureAutoPipeline() 已在 scheduler 启动时调用，此处无需重复
```

### Summary Tasks 清理

确认 `summary-tasks.ts` 不再有规则相关引用（应该已经没有了）。

### `automation_tags` 列处理

`videos.automation_tags` 列仅由规则系统的 `tag` 动作写入。规则移除后该列成为死数据：
- **不移除列**（避免复杂的 SQLite 迁移），但移除所有读取该列的代码
- 从 `VideoWithMeta` 类型中移除 `automation_tags` 字段
- 从 `/api/videos/` 的 SQL 查询中移除该列

### 其他引用扫描

全局搜索以下关键词，确保无遗漏引用：

```
automation_rules
rule_executions
output_plugins
AutomationRulesSettings
processAutomationStage
ensureAutomationPipeline
getSummaryControlDecision
loadAutomationVideoContext
recordRuleExecution
getMatchingRulesForStage
evaluateAutomationRule
listAutomationRules
createAutomationRule
updateAutomationRule
deleteAutomationRule
listRuleExecutions
executeOutputPlugin
getOutputPlugin
specialRules
channelModelMap
```

## CLAUDE.md 更新

移除以下章节/内容：
- "自动化系统" 部分（`rules.ts`, `pipeline.ts`, `outputs.ts` 的描述）
- API 路由中的 "自动化" 部分
- `automation_rules`, `rule_executions`, `output_plugins` 表描述
- "自动化阶段" 注意事项
- `AutomationRulesSettings.tsx` 组件描述

新增：
- `auto-pipeline.ts` 的描述
- 事件驱动流水线架构说明

## 数据安全

**在执行 DROP TABLE 之前，备份数据库**：

```bash
cp data/folo.db data/folo.db.pre-rules-removal
```

或者使用 RENAME 代替 DROP 以支持回滚：

```sql
ALTER TABLE automation_rules RENAME TO _deprecated_automation_rules;
ALTER TABLE rule_executions RENAME TO _deprecated_rule_executions;
ALTER TABLE output_plugins RENAME TO _deprecated_output_plugins;
```

后续确认功能正常后可以手动 DROP 这些 `_deprecated_` 表。

## 验收标准

1. `npm run typecheck` 通过 — 无 TypeScript 引用错误
2. `npm run lint` 通过 — 无未使用的 import
3. `npm run build` 通过 — 无构建错误
4. 应用启动时不再创建 `automation_rules`、`rule_executions`、`output_plugins` 表
5. `/api/automation/*` 路由返回 404
6. 设置页面不再显示自动化规则配置
7. AI 设置页面不再显示 specialRules/频道特殊规则
8. 全局搜索无任何遗漏的规则系统引用
9. 意图驱动的自动字幕/总结功能不受影响
10. `summary-queue.ts` 不再 import `pipeline.ts`
