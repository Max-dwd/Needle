# Needle 调度器与自动化重构 — 总览

## 背景

当前调度器、自动化规则、SSE 推送和状态栏存在以下问题：

1. **爬取过程中前端不实时更新**：SSE `videos-updated` 仅在整个 feed scope 完成后触发，中途发现的新视频不推送
2. **状态栏含义模糊**："订阅 / 字幕 / 自动"标签不清晰，没有具体任务信息和时间上下文
3. **自动总结未生效**：`getSummaryControlDecision` 逻辑导致存在任何控制规则时，未命中规则的视频被错误跳过
4. **模型选择不区分触发来源**：自动总结和手动总结无法使用不同模型

## 设计决策

| 维度 | 决策 |
|---|---|
| 自动化驱动 | 意图（intent）是唯一驱动，规则系统完全移除 |
| 模型选择 | 全局"手动模型" + 全局"自动模型"；意图可覆盖自动模型 |
| 实时更新 | 逐视频 SSE 推送完整元数据，前端实时插入 |
| 调度模型 | 纯事件驱动流水线，只保留爬取定时器 |
| 状态栏 | 可展开 mini 任务面板 + "X 分钟前更新"相对时间 |
| 规则系统 | 完全移除（表、API、UI、代码） |

## Spec 列表与依赖顺序

```
01-dual-model-config.md      ← 无依赖，最先实现
02-event-driven-pipeline.md  ← 依赖 01（需要模型解析）
03-realtime-video-push.md    ← 依赖 02（pipeline 的事件）
04-task-panel-ui.md          ← 依赖 02 + 03（需要 pipeline 状态 + SSE 事件）
05-rules-removal.md          ← 依赖 02（pipeline 替代规则后再清理）
```

## 实现顺序

1. **01-dual-model-config** — 扩展 AI 设置，增加自动/手动模型槽和意图级覆盖
2. **02-event-driven-pipeline** — 核心重构：替换 subtitle/summary 定时器为事件驱动
3. **03-realtime-video-push** — SSE 增强 + 前端实时插入
4. **04-task-panel-ui** — 状态栏 + 可展开任务面板
5. **05-rules-removal** — 清理规则系统全部遗留代码

每份 spec 可独立交付和验证。
