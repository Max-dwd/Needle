# Whisper 时间戳锚定的多模态字幕抽取

在现有 `browser` → `gemini` 字幕链基础上插入一条新 source:**本地 mlx-whisper 负责时间戳切分,多模态 AI API 听音频重写文本**。目标是同时拿到"Whisper 的精准时间戳"和"多模态 LLM 的转录质量",在首页/播放器里实现真正可点跳转的高质量字幕。

依赖 [multimodal-subtitle-providers.md](./multimodal-subtitle-providers.md) 定义的 `MultimodalTranscriber` 抽象;本 spec 不碰 provider 层,只在它之上加一条新的字幕生产路径。

## 目标

- 新增 subtitle pipeline source `whisper-ai` (暂名),默认链改为 `browser` → `whisper-ai` → `gemini`。
- 本地 mlx-whisper 用 tiny/base 量化模型产出 segment 级时间戳;文本不可信,只做时间戳锚点。
- 音频按 Whisper 的静音间隙切成 batch,每 batch 上传多模态 LLM,LLM 听音频后按 segment id 输出文本。
- 用户只设一个"目标 batch 时长"slider,其他切分约束在代码里兜底。
- 校对失败时降级到"Whisper-only 原始字幕"(质量差但可搜索),再失败才走旧 `gemini` source 或回到 pipeline 的下一环。
- 不破坏现有 subtitle backoff / shared-ai-budget / async-pool / 字幕状态机;只在 provider 层上做新拼装。

## 非目标

- 不做跨平台 Whisper。本 spec 只支持 Apple Silicon + mlx-whisper。Linux/Windows 用户的这条 source 检测失败直接跳过,维持旧 gemini fallback。跨平台(whisper.cpp)是独立迁移,单开 spec。
- 不做嵌入式 Whisper。走外部二进制模式,参考 `PYTHON_BIN` / `YT_DLP_BIN` / `FFMPEG_BIN` 的现有约定,新增 `MLX_WHISPER_BIN`。
- 不做章节(YouTube chapters / B 站分段)感知切分。v2 再加。本 spec 只用 Whisper segment 级静音间隙。
- 不做 Whisper 字幕的"纯本地无 API"档位独立 source。这个档位用户设置里关掉多模态校对即可,不需要新 source id。
- 不动摘要、AI 问答路径。
- 不动 [subtitle-backoff.ts](../../src/lib/subtitle-backoff.ts) 的状态机(`none` → `pending` → `completed|error|missing|empty`)。

## 前置事实

- [pipeline-config.ts](../../src/lib/pipeline-config.ts) 归一化时会丢弃未知 source id,新增 `whisper-ai` 必须加进白名单。
- [subtitles.ts](../../src/lib/subtitles.ts) 里 `ensureSubtitleForVideo` 按 `subtitle_pipeline_config` 顺序分派,每个 source 对应一组 `fetch*` 函数。
- [subtitle-providers/types.ts](../../src/lib/subtitle-providers/types.ts) 定义了 `MultimodalTranscriber.transcribeAudio`,当前 gemini/openai-chat/anthropic-messages 三个实现都支持。本 spec 直接复用。
- [shared-ai-budget.ts](../../src/lib/shared-ai-budget.ts) 的 `acquireSharedAiBudget` 按请求 kind 优先级调度;当前有 `manual-summary` / `manual-subtitle` / `auto-summary` / `auto-subtitle` 四档。本 spec 的 LLM 校对调用复用 `*-subtitle` kind,不新增优先级。
- 环境变量约定见 [.env.example](../../.env.example):外部工具都是 `*_BIN`,路径根是 `DATA_ROOT` / `SUBTITLE_ROOT`。
- 音频提取已经在 [subtitles.ts](../../src/lib/subtitles.ts) 里通过 `yt-dlp` + `ffmpeg` 落地(走 Gemini 分段那一路),可以直接抽公共函数复用。

## 方案概览

### 数据流

```
[视频] 
  │ yt-dlp 提音频 (复用现有 extractAudioViaYtDlp)
  ▼
[video.m4a]
  │ ① mlx-whisper --word_timestamps True --output-format json
  │    (文本扔掉,只留 segments[].start/.end)
  ▼
[WhisperSegment[]]  { id, start, end }  ~数百到上千条
  │ ② batchSplitter: 目标时长 + 静音间隙对齐 + 硬上限
  ▼
[Batch[]]          { index, offsetSec, segments:[{id,start,end}...] }
  │ ③ ffmpeg 按 batch 时间范围切音频 (带 500ms padding)
  ▼
[batch-N.m4a]
  │ ④ MultimodalTranscriber.transcribeAudio(...)
  │    prompt 含视频标题/频道/描述 + segment 相对时间戳 + JSON schema
  ▼
[Corrections]      { corrections:[{id, text, drop}] }
  │ ⑤ mergeCorrections: 按 id 回填,时间戳从 Whisper 拿
  ▼
[SubtitleSegment[]]  { start, end, text }
  │ 写入 data/subtitles/<platform>/<videoId>/
  ▼
[events.emit('subtitle:ready')]
```

### 关键不变量

- **时间戳永不过 LLM 的手**。LLM 只收到 segment 的 `{id, rel_start, rel_end}` 作为参考,输出只含 `{id, text, drop}`;最终时间戳 100% 来自 Whisper。
- **batch 粒度是 segment,不是字**。一条 segment 要么整条在 batch N,要么整条在 batch N+1,不跨 batch。
- **降级总能给出可用字幕**。最坏情况下整套 LLM 流程全失败,也能从 Whisper 原始输出拼出一份字幕(文本错误很多,但时间戳正确)。

## 组件详设

### 1. Whisper runtime 包装

新建 [src/lib/whisper-runtime.ts](../../src/lib/whisper-runtime.ts)。

职责:
- 检测 mlx-whisper 是否可用 (`${MLX_WHISPER_BIN ?? 'mlx_whisper'} --help`),结果缓存到 `globalThis` 单例,TTL 60s。
- `runWhisper(audioPath, options)`:spawn mlx_whisper CLI,用 `--output-format json --word-timestamps True --model <modelId>`,通过 `--output-dir <tmp>` 输出,读取 json 产物,返回:
  ```ts
  type WhisperSegment = {
    id: number;
    start: number;   // 秒,float
    end: number;
    noSpeechProb?: number;  // 有就带,用于幻觉过滤
    avgLogprob?: number;
  };
  type WhisperResult = { language: string; segments: WhisperSegment[] };
  ```
- 超时保护:按音频时长 × 2 作为 kill 阈值(tiny-q4 在 M 系列实测 realtime ratio ~10x,2x 作为上限宽松但防卡死)。
- 取消信号:接 `AbortSignal`,spawn 进程跟着 kill。

环境变量:
- `MLX_WHISPER_BIN`:默认 `mlx_whisper`。
- `WHISPER_MODEL_ID`:默认 `mlx-community/whisper-base-mlx-q4`。写进 `.env.example`。

不要把模型路径硬编码进代码。

### 2. Batch splitter

在 [src/lib/subtitle-whisper-correction.ts](../../src/lib/subtitle-whisper-correction.ts) 内实现 `splitIntoBatches(segments, options)`。

算法:

```ts
interface SplitOptions {
  targetSeconds: number;      // 用户设置,默认 180
  maxSeconds: number;         // 硬上限,默认 300
  maxSegments: number;        // 硬上限,默认 60
  minSeconds: number;         // 默认 30,避免尾巴 batch 过短
  silenceWindow: number;      // 默认 30,在目标点附近 ±30s 找静音
  overlapSegments: 0;         // 本版本设为 0,不做 batch 间重叠(时间戳是锚,不需要)
}

interface Batch {
  index: number;
  offsetSec: number;          // batch 起点绝对秒
  endSec: number;             // batch 终点绝对秒
  segments: WhisperSegment[]; // 连续不跨,每条 start/end 原始绝对值
}
```

核心逻辑:
1. 累积 segment 直到 `(cur.end - batchStart.start) >= targetSeconds`,到达后向 `[target-silenceWindow, target+silenceWindow]` 窗口内找**间隙最大**的相邻 segment 对 `(seg[i], seg[i+1])` 作为切点(静音间隙 = `seg[i+1].start - seg[i].end`)。
2. 撞硬上限(maxSeconds 或 maxSegments)强制在当前位置切,不再找静音。
3. 尾巴 batch 如果 `<minSeconds`,合并到前一个 batch(允许略超 maxSeconds,比丢尾好)。

### 3. 音频切片

新建 [src/lib/audio-slicer.ts](../../src/lib/audio-slicer.ts) 或复用现有 `splitAudioIntoChunks`(`subtitles.ts` 里已有)。调整点:

- 不再按固定 `AI_SUBTITLE_CHUNK_SECONDS` 切,改成按 `Batch[]` 的 `offsetSec`/`endSec` 切。
- 每段前后各加 500ms padding(防止切到词中)。padding 段让 LLM 听到但不覆盖 segment 范围 —— segment 相对时间戳照原样传给 LLM,LLM prompt 里提示"音频前后有 0.5s 边界余量,忽略即可"。
- ffmpeg 命令和现有 `splitAudioIntoChunks` 一致(`-i in.m4a -ss <start> -to <end> -c copy` 或重编码为 mp3,跟现有一致)。
- 临时文件用 `DATA_ROOT/tmp/whisper-batches/<runId>/` 目录,finally 清理。

### 4. 多模态校对调用

在 [src/lib/subtitle-whisper-correction.ts](../../src/lib/subtitle-whisper-correction.ts) 里实现 `correctBatch(batch, audioPath, model, videoContext)`。

Prompt 组装(system + user):

```ts
const system = [
  '你是精准字幕校对助手。',
  `视频标题:${video.title}`,
  `频道:${video.channel_name}`,
  `描述摘要:${description.slice(0, 500)}`,
  '规则:',
  '1. 听音频,为每个 segment id 输出该时间段内的准确转录文本。',
  '2. 严格保留 segment 数量和 id 一对一,不合并/不拆分/不新增。',
  '3. 静音/音乐/无人声段将 drop 设为 true,text 可留空。',
  '4. 出现专有名词优先参考视频标题和描述。',
  '5. 音频前后各有 0.5 秒边界余量,不在任何 segment 范围内,忽略即可。',
  '6. 只输出 JSON,不要任何解释。',
].join('\n');

const userPayload = {
  segments: batch.segments.map(s => ({
    id: s.id,
    rel_start: +(s.start - batch.offsetSec).toFixed(2),
    rel_end:   +(s.end   - batch.offsetSec).toFixed(2),
  })),
};
```

通过 `MultimodalTranscriber.transcribeAudio(model, { audioPath, mediaType, prompt, systemPrompt?, responseSchema? })` 发送。
**注意**:`MultimodalTranscriber` 现在的接口只有 `prompt: string`,没有 `systemPrompt` 和 `responseSchema`。本 spec 需要扩接口(见下文"接口扩展")。

响应 schema (Gemini responseSchema / OpenAI json_schema 同构):

```json
{
  "type": "object",
  "properties": {
    "corrections": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id":   { "type": "integer" },
          "text": { "type": "string" },
          "drop": { "type": "boolean" }
        },
        "required": ["id", "text", "drop"]
      }
    }
  },
  "required": ["corrections"]
}
```

`transcribeAudio` 当前返回的是纯文本 `TranscribeResult.text`;本 spec 调用方负责 `JSON.parse(result.text)` 并按 schema 校验。如果解析失败视为 batch 校对失败。

### 5. Merger + 验证

```ts
function mergeCorrections(
  whisper: WhisperSegment[],
  corrected: Array<{ id: number; text: string; drop: boolean }>,
): SubtitleSegment[] {
  const byId = new Map(corrected.map(c => [c.id, c]));
  return whisper
    .map(seg => {
      const fix = byId.get(seg.id);
      if (!fix || fix.drop) return null;
      const text = fix.text.trim();
      if (!text) return null;
      return { start: seg.start, end: seg.end, text };
    })
    .filter((x): x is SubtitleSegment => x !== null);
}
```

校验:
- 如果 `corrected.length === 0` 或 `corrections` 缺失 → 整 batch 降级为 Whisper 原始文本。
- 如果缺 id 超过 20% → 整 batch 降级。
- 单条 id 缺失 → 单条用 Whisper 原文(但打 log 统计)。

### 6. 幻觉过滤

送 batch 给 LLM 之前,**按 Whisper 自带信号剔除可疑 segment**:

```ts
function isLikelyHallucination(seg: WhisperSegment): boolean {
  if (seg.noSpeechProb !== undefined && seg.noSpeechProb > 0.8) return true;
  if (seg.avgLogprob !== undefined && seg.avgLogprob < -1.0) return true;
  return false;
}
```

被标记的 segment 直接 `drop`,不送 LLM。如果整 batch 全被 drop,跳过该 batch。

## Pipeline 集成

### 新增 source id

[pipeline-config.ts](../../src/lib/pipeline-config.ts):

```ts
const KNOWN_SUBTITLE_SOURCES = ['browser', 'whisper-ai', 'gemini'] as const;
```

默认链(重写 `DEFAULT_SUBTITLE_PIPELINE`):
```ts
[
  { id: 'browser', enabled: true },
  { id: 'whisper-ai', enabled: true },
  { id: 'gemini', enabled: true },  // 旧 fallback,移到最后
]
```

迁移:旧配置中没有 `whisper-ai` 的,自动在 `browser` 后 `gemini` 前插入 `whisper-ai`,默认 enabled=true(Mac 用户直接享受;非 Mac 用户检测失败跳过,零损)。

### `subtitles.ts` 新增入口

伪代码(嵌入现有分派逻辑):

```ts
case 'whisper-ai': {
  if (!(await isMlxWhisperAvailable())) return { status: 'skipped', reason: 'mlx-whisper not installed' };
  const audioPath = await extractAudioViaYtDlp(video, runContext);
  const whisperResult = await runWhisper(audioPath, { signal });
  const filtered = whisperResult.segments.filter(s => !isLikelyHallucination(s));
  if (filtered.length === 0) return { status: 'empty' };
  
  const batches = splitIntoBatches(filtered, loadBatchOptions());
  const model = resolveSubtitleFallbackModel(settings);
  const transcriber = getTranscriber(model);
  
  const results = await runWithAsyncPool(batches, async (batch) => {
    const slice = await sliceAudio(audioPath, batch);
    try {
      return await correctBatch(batch, slice, model, transcriber, videoContext, { signal });
    } catch (err) {
      logger.warn('whisper-ai batch failed, fallback to raw whisper text', { err });
      return batch.segments.map(s => ({ start: s.start, end: s.end, text: '' }));  // Whisper 原文在合并阶段补
    }
  });
  
  const merged = flattenAndMerge(results, whisperResult.segments);
  return buildPayload(merged, 'whisper-ai');
}
```

### `shared-ai-budget` 接入

每个 batch 的 LLM 调用前走 `acquireSharedAiBudget({ kind: isManual ? 'manual-subtitle' : 'auto-subtitle', estimatedTokens })`。估算公式:

```
estimatedTokens ≈ audioSec * 32 + segmentCount * 30 + 400  // 音频 + 参考 JSON + 系统 prompt
```

不新增优先级,不新增 `subtitleFallbackTokenReserve` 参数。

### `MultimodalTranscriber` 接口扩展

在 [subtitle-providers/types.ts](../../src/lib/subtitle-providers/types.ts) 上加两个可选字段到 `TranscribeAudioInput`:

```ts
export interface TranscribeAudioInput {
  audioPath: string;
  mediaType: 'audio/mpeg';
  prompt: string;
  systemPrompt?: string;         // 新增
  responseSchema?: JsonSchema;    // 新增;provider 负责翻译到各家结构化输出 API
  maxOutputTokens?: number;
  signal?: AbortSignal;
}
```

三个 provider 翻译策略:
- `gemini`:`systemPrompt` → `systemInstruction.parts[0].text`;`responseSchema` → `generationConfig.responseSchema` + `generationConfig.responseMimeType = 'application/json'`。
- `openai-chat`:`systemPrompt` → messages 前面追加 `{role:'system', content:...}`;`responseSchema` → `response_format: { type: 'json_schema', json_schema: {name, strict:true, schema} }`。
- `anthropic-messages`:`systemPrompt` → 顶层 `system` 字段;`responseSchema` → 不支持,改用 prompt 约束 + 严格 parser(退化为软约束)。

所有三家都支持但退化等级不同;`correctBatch` 调用方永远传 `responseSchema`,provider 层负责无损/有损翻译。

## 数据模型变更

### `app_settings`

新增 key `subtitle_whisper_ai_config`,JSON:

```ts
{
  enabled: boolean;              // 总开关,默认 true
  whisperModelId: string;        // 默认 'mlx-community/whisper-base-mlx-q4'
  batch: {
    targetSeconds: number;       // 用户 slider,默认 180
    maxSeconds: number;          // 硬上限,默认 300,不暴露 UI
    maxSegments: number;         // 默认 60,不暴露 UI
    silenceWindow: number;       // 默认 30,不暴露 UI
    minSeconds: number;          // 默认 30,不暴露 UI
  };
  hallucination: {
    noSpeechProbThreshold: number;  // 默认 0.8
    avgLogprobThreshold: number;    // 默认 -1.0
  };
}
```

读写走 [app-settings.ts](../../src/lib/app-settings.ts)。新建 [src/lib/subtitle-whisper-ai-settings.ts](../../src/lib/subtitle-whisper-ai-settings.ts) 提供类型安全的 get/update 包装,和现有 `subtitle-api-fallback-settings.ts` / `subtitle-browser-fetch-settings.ts` 同构。

### `SubtitleMethod` 枚举

`subtitles.ts` 里的 metadata `method` 字段新增 `'whisper-ai'` 字面量,写入字幕文件 frontmatter,便于 Debug 和事后统计。

### 数据库

不动 `videos` 表。`subtitle_path` / `subtitle_language` / `subtitle_format` 保持语义。字幕 JSON 结构(见 [subtitles.ts](../../src/lib/subtitles.ts) 的 `SubtitleFilePayload`)不变。

## UI 变更

在 [SubtitlesTab.tsx](../../src/components/settings/SubtitlesTab.tsx) 新增"Whisper 校对"板块,位置紧跟在"字幕来源顺序"下面:

- 总开关(对应 `enabled`)。
- 检测 Whisper 安装按钮,点击调 `GET /api/settings/whisper-status`(新增),返回 `{ available, binPath, version }`。
- 目标 batch 时长 slider,1-5 分钟,步长 30 秒,默认 3 分钟。
- Whisper 模型 ID 下拉(tiny-q4 / base-q4 / small-q4 / turbo),默认 base-q4。每个选项旁注标记"极速 / 平衡 / 精准"档位。
- Prompt 展示:显示当前 system prompt 模板(只读,版本 1 不开放编辑,需要再开 v2)。

新增 API 路由 [`src/app/api/settings/whisper-status/route.ts`](../../src/app/api/settings/whisper-status/route.ts):
- `GET` → 调 `isMlxWhisperAvailable()`,返回 `{ available, binPath, version, modelList? }`。

用户设置保存后 dispatch `subtitle-pipeline-changed` window 事件(参考 `frontend-performance-changed` 的做法),不需要 reload。

## 失败与降级阶梯

按最外层 catch 算起:

| 失败阶段 | 降级行为 |
|---|---|
| `isMlxWhisperAvailable()` 返回 false | 整条 `whisper-ai` source 跳过,继续 pipeline 下一环(`gemini`) |
| `runWhisper` 超时 / 错退 | 整条 source 记为失败,继续 pipeline 下一环 |
| 全部 segment 被幻觉过滤器 drop | source 返回 `empty` 状态,走 subtitle-backoff |
| `sliceAudio` 某 batch 失败 | 该 batch 用 Whisper 原始 segment 文本,其他 batch 继续 |
| `correctBatch` LLM 调用失败 | 同上,batch 原文兜底 |
| `correctBatch` JSON 解析失败 | 同上 |
| `correctBatch` 返回 id 缺失超 20% | 同上 |
| 所有 batch 都降级为原文 | 输出依然记为 `whisper-ai` method,但 payload 里加 `metadata.fallback: 'raw-whisper'` 字段,前端可据此标警告 |

永远保证有字幕产出,除非 Whisper 本身就跑失败。

## 成本与性能估算

对 1 小时视频(假设中文播客,静音占比 20%):

| 指标 | 值 |
|---|---|
| Whisper 本地耗时 (base-q4, M2) | ~5 分钟(realtime ratio ~12x) |
| Whisper 原始 segment 数 | ~1200 条 |
| 幻觉过滤后 segment 数 | ~1000 条 |
| 默认 batch 数 (3 分钟目标) | ~20 个 |
| 每 batch 音频 token (Gemini Flash 32 tok/s) | ~5760 |
| 每 batch 输出 text token | ~2000 |
| 每 batch 总 token | ~8000 |
| 全视频总 token | ~160k |
| 串行延迟估算 (Gemini Flash) | ~3-5 分钟 |
| 并发 3 延迟估算 | ~2 分钟 |

对比当前 `gemini` source:
- token 量级相近(~115k vs ~160k,略高因为多了 segment 参考 JSON)
- 时间戳质量从"LLM 自报"提升到"word-level accurate"
- 本地 Whisper 额外 ~5 分钟 CPU/NPU 时间

对一小时视频,额外成本可接受;对更短视频(10 分钟以内),Whisper 侧开销占比极小。

## 验证计划

### 自动化

- `whisper-runtime.test.ts`:mock spawn,校验命令行参数和 json 解析。
- `subtitle-whisper-correction.test.ts`:
  - `splitIntoBatches` 针对多种 segment 分布的快照测试。
  - `mergeCorrections` 的 drop/缺失 id/空 text 行为。
  - 幻觉过滤阈值边界。
- `subtitle-providers/types.ts` 接口扩展不破坏现有 gemini/openai-chat/anthropic-messages provider 的单元测试。

### 手动

在 Mac + mlx-whisper 已安装环境下,选以下 3 个视频做主观对比,对比 `whisper-ai` vs `gemini` 的:
- 时间戳同步:点开播放器随机点 10 个 segment,看播放跳转是否准。
- 专有名词:选一个技术频道视频,人工数错词数。
- 音乐/静音处理:选一个音乐开头 15 秒的视频,看开头有没有被编造出文字。

三项各挑一个典型视频,结果写进 spec 评审的 PR 描述。

### 生产观测

日志新增指标(写入 [logger.ts](../../src/lib/logger.ts)):
- `whisper_duration_ms` / `whisper_segment_count`
- `batch_count` / `batch_avg_seconds`
- `hallucination_filtered_count`
- `correction_failed_batch_count`
- `correction_raw_fallback_ratio` = 降级为 Whisper 原文的 batch 占比

Rollout 一周后,按视频维度统计 `correction_raw_fallback_ratio`,目标 <5%。超标就回滚默认链顺序(把 `whisper-ai` 降到 `gemini` 后面)。

## Rollout

- Stage 1:代码落地,默认链保持 `browser` → `gemini`,`whisper-ai` 在 `pipeline-config` 里存在但默认 disabled。
- Stage 2:个人用户自测 1-2 周,收集成本和质量数据。
- Stage 3:默认链切到 `browser` → `whisper-ai` → `gemini`;新用户从 Stage 3 开始。
- Stage 4:`gemini` source 是否最终移除,另开 spec 讨论。

## 开放问题

- Whisper 模型的第一次下载怎么提示用户?目前 mlx-whisper CLI 首次用会自动从 HuggingFace 下载,但无进度提示。选项:(a) 发布前文档里说清楚 (b) 在 SubtitlesTab 的"检测安装"按钮里同时触发模型预热。倾向 (a),v1 不做自动预热。
- 并发度怎么定?`async-pool` 的 LLM 并发是全局的,和摘要共享。batch 并发数是否要意图级可配?v1 先写死 3,观察后再说。
- 如果用户模型没开 `isMultimodal`,提示什么?当前默认模型选择逻辑在 [ai-summary-settings.ts](../../src/lib/ai-summary-settings.ts);若 `resolveSubtitleFallbackModel` 返回的模型非多模态,整个 `whisper-ai` source 应跳过并在日志里警告一次。
