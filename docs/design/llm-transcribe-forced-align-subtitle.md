# 多模态 LLM 转写 + Forced Aligner 对齐的字幕抽取

在现有 `browser` → `whisper-ai` → `gemini` 字幕链基础上，再加一条**并列**的 source：多模态 LLM 负责完整转写（可带说话人分离），再由本地 MLX forced aligner 把转写文本对齐到音频，产出词级时间戳。目标是拿到比 mlx_whisper tiny/base/small 量化更高的文本质量（专有名词、代码切换、中英混杂、说话人分段），同时保留精准时间戳。

本 spec 参考并沿用 [whisper-anchored-ai-subtitle.md](./whisper-anchored-ai-subtitle.md) 建立的 pipeline 约定与 provider 抽象；不替换 `whisper-ai`，两条 source 并存，由用户在设置里选择优先级。

## 目标

- 新增 subtitle pipeline source `llm-aligner`，默认顺序建议 `browser` → `whisper-ai` → `llm-aligner` → `gemini`，但默认 `enabled=false`（灰度引入，不影响现有链路）。
- 多模态 LLM 分段监听音频，输出 **带说话人标签** 的纯文本段（不含时间戳，时间戳不可信）。
- 本地 `Qwen3-ForcedAligner-0.6B-8bit`（MLX）把每段文本对齐回原始音频，输出词/短语级时间戳。
- 说话人标签作为 `SubtitleSegment.speaker` 字段落地，前端字幕行可选显示。
- Forced aligner 失败或置信度过低时，降级到"LLM 文本 + LLM 自报时间戳"（比 gemini 源更粗但仍可用），再失败才交给 pipeline 下一环。
- 不动 subtitle backoff / shared-ai-budget / async-pool / 字幕状态机；只在新 source 内部编排。

## 非目标

- 不做跨平台。本 spec 依赖 MLX，**仅 Apple Silicon**。其它平台 source 检测失败即跳过，与 `whisper-ai` 行为一致。
- 不做嵌入式 aligner。走外部二进制模式，新增 `MLX_FORCED_ALIGNER_BIN` 环境变量，参考 `MLX_WHISPER_BIN` 的约定。
- 不做章节感知切分；LLM 转写的分段由 LLM 自己决定（prompt 要求按说话人轮次换段），forced aligner 接受任意文本。
- 不替换 `whisper-ai`。两条 source 失败模式不同，保留用户按内容类型切换的能力。
- 不动摘要、AI 问答、播放器 UI（字幕行可选加说话人前缀，但不是本 spec 的硬依赖）。
- 不重复造 `MultimodalTranscriber` 抽象；复用 [subtitle-providers/types.ts](../../src/lib/subtitle-providers/types.ts)。

## 前置事实

- [pipeline-config.ts](../../src/lib/pipeline-config.ts) 的 `SUBTITLE_PIPELINE_DEFINITIONS` 已经支持 `browser` / `whisper-ai` / `gemini`，归一化时丢弃未知 id，新增 `llm-aligner` 必须加入枚举并迁移老配置。
- [subtitles.ts](../../src/lib/subtitles.ts:149) 的 `SubtitleMethod` 类型与分派 switch 需要新增分支；`fetchSubtitleViaWhisperAi` 是现成对齐样板（见 [subtitles.ts:1527](../../src/lib/subtitles.ts:1527)），新函数按同构写法落地。
- [whisper-runtime.ts](../../src/lib/whisper-runtime.ts) 的 CLI 包装模式（可用性探测 + `globalThis` TTL 缓存 + `AbortSignal` 下推 + JSON 产物解析）可直接套用到 forced aligner runtime。
- [subtitle-whisper-ai-settings.ts](../../src/lib/subtitle-whisper-ai-settings.ts) 的 get/normalize/set 三段式结构是 `app_settings` 一条新 key 的标准写法，本 spec 新增的 `subtitle_llm_aligner_config` 按同构实现。
- [shared-ai-budget.ts](../../src/lib/shared-ai-budget.ts) 的 `manual-subtitle` / `auto-subtitle` 优先级已足够，**不**新增优先级。Forced aligner 是本地计算，不占共享预算。
- Qwen3-ForcedAligner-0.6B-8bit 是 MLX 量化的"文本-音频强制对齐"模型；输入音频 + 转写文本，输出带词级时间戳的对齐结果。HuggingFace 仓库 `mlx-community/Qwen3-ForcedAligner-0.6B-8bit`。本 spec 假设其 CLI 支持 `--audio <path> --text <path> --output-format json`（待 POC 阶段核实，见"开放问题"）。

## 方案概览

### 数据流

```
[视频]
  │ yt-dlp 提音频 (复用 extractAudioViaYtDlp)
  ▼
[video.m4a]
  │ ① 按固定时长切片 (默认 15 分钟，与 Gemini fallback 的 AI_SUBTITLE_CHUNK_SECONDS 同源)
  ▼
[chunk-N.m4a]
  │ ② MultimodalTranscriber.transcribeAudio(...)
  │    prompt: 标题/频道/描述 + 输出 schema (utterances: [{speaker, text}])
  ▼
[Utterances[]]  { speaker: 'S1', text: '...' }  每 chunk 十到几百条
  │ ③ 拼接成 chunk 级纯文本（"S1: ...\nS2: ..."），保留说话人映射
  ▼
[ChunkText]
  │ ④ MLX forced aligner CLI (Qwen3-ForcedAligner-0.6B-8bit)
  │    输入 (audio=chunk-N.m4a, text=ChunkText)
  │    输出 words: [{text, start, end, prob}]
  ▼
[AlignedWords[]]
  │ ⑤ 回拼成 SubtitleSegment[]：按 utterance 边界聚合 word 时间戳；加回说话人
  │    chunk 间的时间戳 + 全局 offsetSec 还原到绝对值
  ▼
[SubtitleSegment[]]  { start, end, text, speaker }
  │ 写 data/subtitles/<platform>/<videoId>/
  ▼
[events.emit('subtitle:ready')]
```

### 关键不变量

- **LLM 只写文本与说话人，绝不写时间戳**。对齐 100% 来自 forced aligner。
- **Chunk 级隔离**。一个 chunk 的 LLM 转写只需要对齐到这个 chunk 的音频；chunk 间不做跨段对齐，错一个 chunk 不污染其它 chunk。
- **降级永远可恢复**。Forced aligner 崩溃或置信度过低时，退回到 chunk 级粗粒度时间戳（LLM 自报或 chunk 线性插值），不把整个视频打回 pipeline 下一环。

## 组件详设

### 1. Forced Aligner runtime 包装

新建 [src/lib/forced-aligner-runtime.ts](../../src/lib/forced-aligner-runtime.ts)，与 [whisper-runtime.ts](../../src/lib/whisper-runtime.ts) 结构同构。

职责：
- `getForcedAlignerStatus()`：探测 `${MLX_FORCED_ALIGNER_BIN ?? 'mlx_forced_aligner'} --help`，结果缓存到 `globalThis[Symbol.for('needle.forcedAlignerAvailabilityCache')]`，TTL 60s。
- `runForcedAligner(audioPath, textPath, options)`：spawn CLI，参数大致：
  ```
  mlx_forced_aligner \
    --audio <chunk.m4a> \
    --text <transcript.txt> \
    --model mlx-community/Qwen3-ForcedAligner-0.6B-8bit \
    --output-format json \
    --output <out.json>
  ```
- 解析 JSON：
  ```ts
  type AlignedWord = {
    text: string;
    start: number;  // 秒，相对 chunk 起点
    end: number;
    prob?: number;  // 对齐置信度，可选
  };
  type AlignerResult = { words: AlignedWord[]; warnings?: string[] };
  ```
- 超时：按音频时长 × 3（forced aligner 比 whisper 轻量但批处理首次加载模型有开销）。
- `AbortSignal` 下推，spawn 进程跟着 kill。

环境变量：
- `MLX_FORCED_ALIGNER_BIN`：默认 `mlx_forced_aligner`。
- `FORCED_ALIGNER_MODEL_ID`：默认 `mlx-community/Qwen3-ForcedAligner-0.6B-8bit`。写进 `.env.example`。

### 2. LLM 转写调用

在 [src/lib/subtitle-llm-align-correction.ts](../../src/lib/subtitle-llm-align-correction.ts)（新建）里实现 `transcribeChunk(chunk, audioPath, model, transcriber, videoContext, signal)`。

Prompt 组装：

```ts
const systemPrompt = [
  '你是精准的多人对话听写助手。',
  `视频标题：${video.title}`,
  `频道：${video.channel_name}`,
  `描述摘要：${description.slice(0, 500)}`,
  '规则：',
  '1. 严格按原话转写，不改写、不意译、不删减语气词。',
  '2. 按说话人轮次切段；同一说话人连续说话算一段。',
  '3. speaker 字段用 S1/S2/S3…，全片保持一致编号（优先用视频标题/描述里出现的名字）。',
  '4. 不输出时间戳，不输出解释，只输出 JSON。',
  '5. 音频前后各有 0.5 秒边界余量，属于上下文，忽略即可。',
].join('\n');

const userPrompt = '请听音频并输出 JSON。';

const responseSchema = {
  type: 'object',
  properties: {
    utterances: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          speaker: { type: 'string' },
          text:    { type: 'string' },
        },
        required: ['speaker', 'text'],
      },
    },
  },
  required: ['utterances'],
};
```

调用 `MultimodalTranscriber.transcribeAudio` 时传 `systemPrompt` + `responseSchema`。**这要求 `TranscribeAudioInput` 接口已经扩展过（由 `whisper-ai` spec 负责落地）**；若该接口尚未扩展，本 spec 的落地需连带推进，不在本 spec 额外阐述。

解析：`JSON.parse(raw.text)` → 按 schema 校验 → 失败即 chunk 级校对失败（见降级阶梯）。

### 3. 对齐驱动

在 `subtitle-llm-align-correction.ts` 里实现 `alignChunk(utterances, audioPath, signal)`：

1. 把 utterances 拼成纯文本：
   ```
   S1: 大家好，今天我们来聊聊...
   S2: 对，这个话题...
   ```
   同时记下每个字符对应的 utterance index，用于对齐后反查。
2. 写临时文件 `transcript.txt`，调 `runForcedAligner(chunkAudio, transcriptPath, { signal })`。
3. 读 `words[]`，遍历时维护一个 "当前 char offset" 指针与 `utterances[i]` 映射，聚合成 utterance 级时间戳：
   ```ts
   type AlignedUtterance = {
     speaker: string;
     text: string;
     start: number;  // chunk 内相对秒
     end: number;
     avgProb: number | null;
   };
   ```
4. 若对齐置信度均值 `avgProb < 0.3`（阈值可配），或 aligner 返回的 word 数 / 输入字符数比例过低（比如 <0.3），视为 chunk 对齐失败。

### 4. 全局聚合

```ts
function assembleSegments(
  chunks: Array<{ offsetSec: number; utterances: AlignedUtterance[] }>,
): SubtitleSegment[] {
  return chunks.flatMap(chunk =>
    chunk.utterances.map(u => ({
      start: chunk.offsetSec + u.start,
      end:   chunk.offsetSec + u.end,
      text:  u.text.trim(),
      speaker: u.speaker,
    })),
  ).filter(s => s.text.length > 0);
}
```

合并规则：
- 跨 chunk 边界的同一说话人相邻两段**不合并**。合并在前端渲染阶段按需做（保持数据粒度可逆）。
- 每条 `SubtitleSegment` 的 `start/end` 保证在 `[chunkOffset, chunkOffset + chunkDuration]` 内，不跨段。

### 5. 降级阶梯（chunk 粒度）

| chunk 阶段失败 | 降级行为 |
|---|---|
| LLM 调用失败 / JSON 解析失败 | 该 chunk 的 utterances 用空文本占位，前端显示"[转写失败]"，不阻塞其它 chunk |
| LLM 输出 0 条 utterance | 该 chunk 跳过，无字幕（静音/音乐 chunk 合理） |
| Forced aligner 失败 / 超时 | 退回 **均匀插值**：把 chunk 时长平均分给 N 条 utterance；打 metadata 标 `align_fallback: 'interpolated'` |
| Forced aligner 输出置信度过低 | 同上，走均匀插值 |

若**所有 chunk 都退化为 interpolated**，整个视频依然记为 `llm-aligner` method，但 payload metadata 里加 `fallback: 'all-interpolated'`，可据此在 UI 上标警告。

## Pipeline 集成

### 新增 source id

[pipeline-config.ts](../../src/lib/pipeline-config.ts) 的 `SUBTITLE_PIPELINE_SOURCES` 新增：

```ts
{
  id: 'llm-aligner',
  label: 'LLM 转写 + 本地对齐',
  description: '多模态 AI 出完整文本和说话人，MLX forced aligner 出词级时间戳。',
}
```

默认顺序改为 `['browser', 'whisper-ai', 'llm-aligner', 'gemini']`，但 `llm-aligner` 的 `enabled` 默认 `false`（灰度）。迁移：老配置没有 `llm-aligner` 的，按上面的相对位置插入 + enabled=false。

### `subtitles.ts` 新增分派

伪代码：

```ts
case 'llm-aligner': {
  const status = await getForcedAlignerStatus();
  if (!status.available) {
    return { status: 'skipped', reason: 'mlx forced aligner not installed' };
  }
  const llmAlignConfig = getSubtitleLlmAlignerConfig();
  if (!llmAlignConfig.enabled) {
    return { status: 'skipped', reason: 'llm-aligner disabled' };
  }
  const model = resolveSubtitleFallbackModel(settings);
  if (!model || model.isMultimodal === false) {
    throw new Error('llm-aligner requires a multimodal AI subtitle model');
  }

  const audioPath = await extractAudioViaYtDlp(video, ytDlpBin, tempDir);
  const chunks = await sliceAudioIntoChunks(audioPath, {
    chunkSeconds: llmAlignConfig.chunkSeconds,
    paddingSeconds: 0.5,
    outputDir: sliceOutputDir,
  });

  const chunkResults = await runWithAsyncPool(chunks, async (chunk) => {
    const utterances = await transcribeChunk(chunk, model, transcriber, videoCtx, { signal });
    const aligned = await alignChunk(utterances, chunk.audioPath, { signal })
      .catch(() => interpolateUtterances(utterances, chunk.durationSec));
    return { offsetSec: chunk.offsetSec, utterances: aligned };
  });

  const segments = assembleSegments(chunkResults);
  return buildPayload(segments, 'llm-aligner', extractMetadata(chunkResults));
}
```

注意复用 [subtitles.ts](../../src/lib/subtitles.ts) 现有的 `extractAudioViaYtDlp`、`sliceAudioIntoChunks`、`buildAiSubtitlePayloadFromSegments`、`buildAiSubtitleMetadata` 等工具函数；`SubtitleSegment` 类型扩 `speaker?: string`。

### `shared-ai-budget` 接入

每个 chunk 的 LLM 调用前走 `acquireSharedAiBudget({ kind: isManual ? 'manual-subtitle' : 'auto-subtitle', estimatedTokens })`。估算：

```
estimatedTokens ≈ chunkSeconds * 32 + 500  // 音频 token + system prompt + schema
```

Forced aligner 本地运行，**不**调 `acquireSharedAiBudget`。

### `MultimodalTranscriber` 接口依赖

本 spec 依赖 `TranscribeAudioInput` 支持 `systemPrompt` + `responseSchema` 可选字段。该扩展由 `whisper-ai` spec（[whisper-anchored-ai-subtitle.md:296](./whisper-anchored-ai-subtitle.md)）提出但未必已落地；本 spec 实施时若接口还没扩展，要**先扩展**再写新 source。扩展策略见该 spec，不在此重复。

## 数据模型变更

### `app_settings`

新增 key `subtitle_llm_aligner_config`，JSON：

```ts
{
  enabled: boolean;              // 总开关，默认 false（灰度）
  chunkSeconds: number;          // 默认 900（15 分钟，与 Gemini fallback 保持一致）
  aligner: {
    modelId: string;             // 默认 'mlx-community/Qwen3-ForcedAligner-0.6B-8bit'
    minAvgProb: number;          // 默认 0.3，低于此触发插值降级
    minWordRatio: number;        // 默认 0.3，aligner 返回 word 数 / 输入 char 数下限
  };
  llm: {
    expectSpeakerLabels: boolean;  // 默认 true，关闭则 speaker 全部写 'S1'
  };
}
```

读写走 [app-settings.ts](../../src/lib/app-settings.ts)；新建 [src/lib/subtitle-llm-aligner-settings.ts](../../src/lib/subtitle-llm-aligner-settings.ts)，和 [subtitle-whisper-ai-settings.ts](../../src/lib/subtitle-whisper-ai-settings.ts) 结构同构。

### `SubtitleMethod` 枚举

`subtitles.ts` 的 `SubtitleMethod` 新增 `'llm-aligner'` 字面量，字幕 frontmatter 的 `method` 相应支持。

### `SubtitleSegment` 字段扩展

字幕 JSON payload 的 segment 结构加可选 `speaker?: string` 字段。现有 `browser` / `whisper-ai` / `gemini` 输出不填即可，前端渲染默认不显示说话人前缀。

### 数据库

不动 `videos` 表。字幕格式用 JSON 承载，往 `subtitle_format='json'` 的既有通道走。

## UI 变更

在 [SubtitlesTab.tsx](../../src/components/settings/SubtitlesTab.tsx) 新增"LLM 转写 + 本地对齐"板块，位置在"Whisper 校对"下面：

- 总开关（对应 `enabled`）。
- 检测 forced aligner 安装按钮，点击调 `GET /api/settings/forced-aligner-status`（新增），返回 `{ available, binPath, version }`。
- Chunk 时长 slider，5-20 分钟，默认 15 分钟，步长 5 分钟。
- "显示说话人标签" 开关（对应 `llm.expectSpeakerLabels`）。
- 对齐置信度阈值（`minAvgProb`）数字输入，0-1，默认 0.3，**进阶选项**折叠。

新增 API 路由 [src/app/api/settings/forced-aligner-status/route.ts](../../src/app/api/settings/forced-aligner-status/route.ts)：
- `GET` → 调 `getForcedAlignerStatus()`，返回 `{ available, binPath, version }`。

保存后 dispatch `subtitle-pipeline-changed` window 事件（和 `whisper-ai` 保持一致）。

播放器字幕行渲染：如果 `segment.speaker` 存在且 `expectSpeakerLabels=true`，在文本前加灰色前缀 `[S1] `。渲染改动放进[ChatPanel.tsx](../../src/components/ChatPanel.tsx) 和字幕展示组件，不在本 spec 的范围内硬约束。

## 和 `whisper-ai` 的分工

两条 source 永久并存，用户按内容类型选：

| 内容类型 | 推荐 source | 理由 |
|---|---|---|
| 单人讲解 / 技术教程 | `whisper-ai` | Whisper 音频 grounded，幻觉窗口小；LLM 只 diff-style 改，token 便宜 |
| 多人访谈 / 播客 / 辩论 | `llm-aligner` | 原生说话人分段；LLM 对专有名词更强 |
| 无字幕且是长视频 (>1h) | `whisper-ai` 优先 | 分段 Whisper 成本可控；LLM 全量转写成本放大 |
| 音乐 MV / 广告片 | 都绕过（走 `gemini` 或 `browser`） | 两者都不适合非人声内容 |

默认链 `browser → whisper-ai → llm-aligner → gemini` 体现这个分工：`whisper-ai` 是稳健默认，`llm-aligner` 是 opt-in 升级路径，`gemini` 是最后兜底。

## 失败模式对比

| 失败模式 | `whisper-ai` | `llm-aligner` |
|---|---|---|
| LLM 幻觉出原音频没有的句子 | Whisper 已经切好 segment，LLM 只能在每个 id 里改字，幻觉被框死 | LLM 全量转写，**幻觉文本会被 aligner 强行对齐到某段音频**——失败模式更严重 |
| 模型没听清专有名词 | Whisper 粗词 + LLM 改，两次机会 | LLM 一次机会，但 LLM 侧质量比 Whisper 好 |
| Forced aligner / Whisper 本身崩溃 | Whisper 崩 → 整 source 失败 | Aligner 崩 → 降级到插值，source 仍成功 |
| 长音频成本 | Whisper 本地 + LLM 校对（低）→ 总成本可控 | LLM 全量转写（高）→ 总 token 放大 ~3-5x |
| 说话人区分 | ❌ 不支持 | ✅ 原生支持 |

工程师视角的核心差异：**`whisper-ai` 用 Whisper 给 LLM 装上护栏，`llm-aligner` 把护栏去掉换取更高上限**。

## 成本与性能估算

对 1 小时视频（假设中文访谈，3 人对话）：

| 指标 | 值 |
|---|---|
| Chunk 数 (15 分钟默认) | 4 |
| 每 chunk 音频 token (Gemini Flash 32 tok/s) | ~28,800 |
| 每 chunk 输出 text token | ~6,000 |
| 全视频 LLM token | ~140k |
| Forced aligner 本地耗时 (M 系列, 0.6B-8bit) | 估 ~5-8 分钟（需 POC 核实） |
| 串行延迟估算 | ~8-12 分钟 |
| 并发 2 chunk 延迟估算 | ~5-7 分钟 |

与 `whisper-ai` 对比（~160k token + 5 分钟 Whisper）：**token 量级接近，本地耗时略高，但赢在文本质量 + 说话人分段**。

## 验证计划

### 自动化

- `forced-aligner-runtime.test.ts`：mock spawn，校验 CLI 参数组装与 JSON 解析、超时、取消信号。
- `subtitle-llm-align-correction.test.ts`：
  - `transcribeChunk` 在 schema 错误 / JSON 失败时的降级路径。
  - `alignChunk` 插值降级触发条件（低 avgProb、低 word ratio）。
  - `assembleSegments` 的 offset 加法、跨 chunk 说话人处理。
- `pipeline-config.test.ts`：旧配置迁移（没有 `llm-aligner` 时的插入位置与默认 enabled）。
- `subtitle-llm-aligner-settings.test.ts`：get/set/normalize 往返。

### 手动

Mac + `mlx_forced_aligner` 已安装环境下，选 3 类视频对比 `llm-aligner` vs `whisper-ai`：

- **多人访谈**（最适合 `llm-aligner`）：看说话人切换准确率、专有名词错词数。
- **单人技术讲解**：看文本质量是否真的高过 `whisper-ai` 足以抵消成本。
- **纯音乐 / 广告混合 1h**：看降级路径是否触发、有没有把整视频跑崩。

主观评分写进 PR 描述。

### 生产观测

日志（[logger.ts](../../src/lib/logger.ts)）新增：
- `llm_transcribe_duration_ms` / `llm_transcribe_utterance_count`
- `aligner_duration_ms` / `aligner_word_count` / `aligner_avg_prob`
- `chunk_interpolated_count` / `chunk_transcribe_failed_count`
- `llm_aligner_total_tokens`（汇总）
- `llm_aligner_fallback_ratio` = interpolated chunk 占比

Rollout 一周后，按视频统计 `llm_aligner_fallback_ratio`；目标 <10%，超标即考虑调 `minAvgProb` 或回滚默认链。

## Rollout

- Stage 1：代码落地，`llm-aligner` 在 `pipeline-config` 里注册但 `enabled=false`；CI 通过。
- Stage 2：个人开发环境启用，跑 10-20 个典型视频，测成本与质量。
- Stage 3：设置页把它标记为"实验性"选项放出，用户可手动启用；收集两周反馈。
- Stage 4：根据数据决定默认顺序是否调整（是否把 `llm-aligner` 挪到 `whisper-ai` 前）。

## 开放问题

- **Qwen3-ForcedAligner-0.6B-8bit 的实际 CLI 参数？** HuggingFace 页面的用法未在本仓库核实。POC 第一步就是跑通 `mlx_forced_aligner --audio ... --text ... --output-format json`；如果官方脚本只给 Python API，需要包一层 shell 入口或直接在 `forced-aligner-runtime.ts` 里用 `execFile` 调 `python -m ...`，以避免 `better-sqlite3` 同步服务端进程被长任务阻塞。
- **并发度。** LLM chunk 并发可以走现有 `async-pool`，但 forced aligner 本地并发受限于 MPS 显存；本地并发默认设 1，LLM 并发设 3。
- **说话人跨 chunk 一致性。** chunk 内 LLM 能保持 `S1/S2/S3` 一致，跨 chunk 没法保证（每个 chunk prompt 独立）。v1 接受这个缺陷，前端只展示 chunk 内相对标签；v2 再考虑把"上一 chunk 说话人信息"作为下一 chunk 的 prompt context 塞进去。
- **chunk 边界跨词问题。** 固定时长切片可能切到词中间，导致 LLM 在边界处听不全。现有 0.5s padding 的做法（`whisper-ai` spec）可复用，或用 ffmpeg 的静音检测找软切点。v1 先用固定 padding，v2 可做静音切。
- **是否允许 `llm-aligner` 在 `whisper-ai` 失败时用 whisper segments 作为"带时间戳的参考稿"跳过 LLM 转写、直接做 word 级对齐？** 这是两者的融合路径，值得单独评估；本 spec 不处理，算 v2 方向。
