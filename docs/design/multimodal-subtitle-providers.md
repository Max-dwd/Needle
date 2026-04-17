# 多模态字幕 Provider 抽象

把目前硬编码在 [subtitles.ts](../../src/lib/subtitles.ts) 里的 Gemini 字幕 fallback 拆成一个"协议无关"的抽象层,让未来加 OpenCode / 火山 / Groq / DeepInfra 等走 OpenAI-chat 或 Anthropic-messages 协议的多模态模型时,不用再碰 `subtitles.ts`,只需新增一个 provider 文件。

## 目标

- 在 `AiModelConfig` 上新增 `protocol` 字段,用户在 ModelsTab 里选协议类型。
- 抽一个 `MultimodalTranscriber` 接口,三个默认实现:`gemini` / `openai-chat` / `anthropic-messages`。
- `subtitles.ts` 里的分段、重试、预算调度、`AiGeneratedSubtitlePayload` 组装全部保留不动;只把"这一次请求要怎么发"替换为接口调用。
- OpenCode Zen 的两套端点(`/zen/go/v1/messages` 走 anthropic,`/zen/go/v1/chat/completions` 走 openai-chat)通过选不同的 `protocol` 即可接入,不需要为 OpenCode 单独写 provider。
- 保持向后兼容:旧配置没有 `protocol` 字段时,按当前的 "endpoint 包含 `generativelanguage`" 启发式 → `gemini`;其它情况默认 `openai-chat`。

## 非目标

- 不改摘要(text-only)和 AI 问答路径。它们已经走 `ai-summary-client.ts` 和 `ai-chat-client.ts`,调用 OpenAI 兼容接口,不需要 provider 抽象。本 spec 只管**多模态字幕抽取**。
- 不改 `shared-ai-budget.ts`、`async-pool`、字幕 backoff 状态机。它们对 provider 无感。
- 不改 `subtitle_pipeline_config` 的来源顺序(当前 `browser` → `gemini`)。后续把 `gemini` 这个来源 id 改名为 `ai-api` 是单独的小迁移,不在本 spec 范围。
- 不为 Bilibili 官方 AI 摘要 / 浏览器字幕路径引入 provider 概念。

## 前置事实

- 模型配置在 [ai-summary-settings.ts:132](../../src/lib/ai-summary-settings.ts#L132) 定义,每个 `AiSummaryModelConfig` 有 `id / name / endpoint / apiKey / model / isMultimodal`,无协议字段。`AiSummaryConfigDocument.version` 当前是 `5`。
- 字幕 fallback 的入口在 [subtitles.ts:1526](../../src/lib/subtitles.ts#L1526) 的 `fetchYoutubeSubtitleViaGemini` 和 `fetchBilibiliSubtitleViaGemini`,内部调用:
  - `deriveGeminiApiBase` / `normalizeGeminiModelName` — 从 `endpoint` 推出 `generateContent` / `files.upload` 两个子路径。
  - `uploadGeminiFile` — Google 的 resumable upload 协议(两步:`start` + `finalize`)。
  - `generateGeminiSubtitle` — 把 `contents: [{parts: [file_data|inline_data, text]}]` 发过去,解析 `candidates[0].content.parts[*].text`。
  - `generateGeminiSubtitleFromAudio` — 包装前两者,传本地 mp3 路径。
  - `fetchSubtitleViaGeminiSegmentedAudio` — 按 `AI_SUBTITLE_CHUNK_SECONDS = 15 * 60` 用 ffmpeg 切段,逐段调上面那个,最后 merge。
- YouTube 短视频(≤ 15 分钟)直接发 `file_data.file_uri = https://www.youtube.com/watch?v=...`,让 Gemini 自己去拉视频;长视频和所有 Bilibili 视频走本地 yt-dlp 提音频再上传。这是 Gemini 独有能力。

## 核心抽象

### `AiModelConfig.protocol`

```ts
export type AiModelProtocol = 'gemini' | 'openai-chat' | 'anthropic-messages';

export interface AiSummaryModelConfig {
  // ... 现有字段 ...
  protocol: AiModelProtocol;
}
```

`AiSummaryConfigDocument.version` 升到 `6`,迁移规则:

- 已有 `protocol` 字段 → 按用户设置。
- 没有 `protocol`,`endpoint` 含 `generativelanguage.googleapis.com` → `'gemini'`。
- 其它情况 → `'openai-chat'`(覆盖绝大多数现有用户用的 OpenAI 兼容 endpoint;对非多模态模型这个字段不生效,所以 false positive 无害)。

版本迁移写在 `normalizeAiSummaryConfigDocument` 内部,和现有 v4→v5 的迁移逻辑并列。

### `MultimodalTranscriber` 接口

新建 [src/lib/subtitle-providers/types.ts](../../src/lib/subtitle-providers/types.ts):

```ts
export interface TranscribeAudioInput {
  audioPath: string;           // 本地 mp3 绝对路径
  mediaType: 'audio/mpeg';     // 当前只有 mpeg,留字段给未来
  prompt: string;              // settings.subtitleSegmentPromptTemplate 或 subtitleApiPromptTemplate
  maxOutputTokens?: number;    // 由 shared-ai-budget 估算
  signal?: AbortSignal;
}

export interface TranscribeRemoteVideoInput {
  url: string;                 // https://www.youtube.com/watch?v=...
  prompt: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface TranscriberUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface TranscribeResult {
  text: string;
  usage?: TranscriberUsage;
  ttftSeconds?: number;
}

export interface MultimodalTranscriber {
  readonly protocol: AiModelProtocol;

  /** 本地音频文件 → 字幕文本。所有 provider 必须实现。 */
  transcribeAudio(
    model: AiSummaryModelConfig,
    input: TranscribeAudioInput,
  ): Promise<TranscribeResult>;

  /**
   * 直接喂视频 URL 给模型(Gemini 独有)。
   * 不支持的 provider 返回 null,调用方回退到"本地 yt-dlp 提音频 + transcribeAudio"。
   */
  transcribeRemoteVideo?(
    model: AiSummaryModelConfig,
    input: TranscribeRemoteVideoInput,
  ): Promise<TranscribeResult | null>;

  /** 单次请求能容纳的音频秒数上限。用于决定切多大段。 */
  readonly maxAudioChunkSeconds: number;
}
```

### Provider 实现

目录 `src/lib/subtitle-providers/`:

- `gemini.ts` — 把现有 `uploadGeminiFile` / `generateGeminiSubtitle` / `deriveGeminiApiBase` / `normalizeGeminiModelName` / `extractGeminiText` 从 `subtitles.ts` 原样搬过来,实现 `transcribeAudio`(走 resumable upload + `file_data`) 和 `transcribeRemoteVideo`(走 `file_data.file_uri = youtubeUrl`)。`maxAudioChunkSeconds = 15 * 60`。
- `openai-chat.ts` — POST `{endpoint}`,body:
  ```json
  {
    "model": "<model.model>",
    "max_tokens": 10240,
    "messages": [
      {"role": "system", "content": "<subtitle system prompt>"},
      {"role": "user", "content": [
        {"type": "text", "text": "<prompt>"},
        {"type": "input_audio", "input_audio": {"data": "<base64>", "format": "mp3"}}
      ]}
    ]
  }
  ```
  headers `Authorization: Bearer <apiKey>`。解析 `choices[0].message.content`(可能是 string 或数组,复用测试脚本里的 `extractText`)。`transcribeRemoteVideo` 不实现(返回 `null`)。`maxAudioChunkSeconds = 5 * 60`(base64 内联,单请求 payload 更紧)。
- `anthropic-messages.ts` — POST `{endpoint}`,body:
  ```json
  {
    "model": "<model.model>",
    "max_tokens": 10240,
    "system": "<subtitle system prompt>",
    "messages": [{"role": "user", "content": [
      {"type": "text", "text": "<prompt>"},
      {"type": "audio", "source": {"type": "base64", "media_type": "audio/mpeg", "data": "<base64>"}}
    ]}]
  }
  ```
  headers `x-api-key: <apiKey>` + `anthropic-version: 2023-06-01`。解析 `content[*].text`。`maxAudioChunkSeconds = 5 * 60`。

### Provider 注册表

[src/lib/subtitle-providers/index.ts](../../src/lib/subtitle-providers/index.ts):

```ts
const providers: Record<AiModelProtocol, MultimodalTranscriber> = {
  'gemini': geminiProvider,
  'openai-chat': openAiChatProvider,
  'anthropic-messages': anthropicMessagesProvider,
};

export function getTranscriber(model: AiSummaryModelConfig): MultimodalTranscriber {
  return providers[model.protocol];
}
```

## `subtitles.ts` 改造

重命名 + 去 Gemini 化,但保留函数形状:

| 现有                                         | 改后                                             |
| -------------------------------------------- | ------------------------------------------------ |
| `fetchYoutubeSubtitleViaGemini`              | `fetchYoutubeSubtitleViaAiApi`                   |
| `fetchBilibiliSubtitleViaGemini`             | `fetchBilibiliSubtitleViaAiApi`                  |
| `fetchSubtitleViaGeminiSegmentedAudio`       | `fetchSubtitleViaSegmentedAudio`                 |
| `generateGeminiSubtitleFromAudio`            | 调用 `transcriber.transcribeAudio` 替换          |
| `uploadGeminiFile` / `generateGeminiSubtitle`/ `deriveGeminiApiBase` / `normalizeGeminiModelName` / `extractGeminiText` / `GeminiUsageMetadata` | 搬到 `subtitle-providers/gemini.ts` 作为内部细节 |
| 常量 `AI_SUBTITLE_CHUNK_SECONDS = 15 * 60`   | 删除,改成 `transcriber.maxAudioChunkSeconds`    |
| `SubtitleMethod = 'browser' \| 'gemini'`     | 保留 `'gemini'` 字面量(作为 pipeline source id),但语义改成"AI 多模态 API";metadata 里的 `method` 值改为 `ai-url` / `ai-audio` / `ai-audio-segmented`(去掉 gemini- 前缀,保留可识别的形态) |

`fetchYoutubeSubtitleViaAiApi` 伪代码:

```ts
const transcriber = getTranscriber(selectedModel);
const durationSeconds = parseVideoDurationSeconds(video.duration);
const chunkSeconds = transcriber.maxAudioChunkSeconds;

// 1. 能直接喂 URL 且时长在限制内 → 最省的路径
if (transcriber.transcribeRemoteVideo && durationSeconds && durationSeconds <= chunkSeconds) {
  const raw = await transcriber.transcribeRemoteVideo(selectedModel, {
    url: getVideoUrl(video),
    prompt: settings.subtitleApiPromptTemplate,
  });
  if (raw) return buildPayload(raw, 'ai-url');
}

// 2. 走本地音频(带分段或不带)
const audioPath = await extractAudioViaYtDlp(...);
if (durationSeconds > chunkSeconds) {
  return fetchSubtitleViaSegmentedAudio(video, audioPath, ..., selectedModel, chunkSeconds);
}
const raw = await transcriber.transcribeAudio(selectedModel, {
  audioPath, mediaType: 'audio/mpeg', prompt: settings.subtitleApiPromptTemplate,
});
return buildPayload(raw, 'ai-audio');
```

`fetchSubtitleViaSegmentedAudio` 的变化:`splitAudioIntoChunks` 的 `chunkSeconds` 参数从常量换成 `transcriber.maxAudioChunkSeconds`,其它不动。每段调 `transcriber.transcribeAudio`。

Bilibili 分支同理,但没有 URL 快速路径(Bilibili 视频对外部 API 要鉴权),直接强制走音频 + 是否分段。

## 设置页改动

[ModelsTab.tsx](../../src/components/settings/ModelsTab.tsx):

- 每个模型卡片上加一个 `<Select>`,选项:`Gemini`(google 官方/兼容) / `OpenAI 兼容`(`chat/completions`) / `Anthropic 兼容`(`messages`)。
- 默认值由迁移逻辑推断,不强制用户现在就改。
- `isMultimodal = false` 的模型,该字段 disabled(存在但不用)。
- 没有新增"OpenCode" 这种供应商预设;OpenCode 用户用 `openai-chat` 协议 + `https://opencode.ai/zen/go/v1/chat/completions` + 模型名如 `mimo-v2-omni` 即可。

[SubtitlesTab.tsx](../../src/components/settings/SubtitlesTab.tsx) 不需要改。Source 列表里 `gemini` 这条的显示名建议文案上改为 "AI 多模态 API"(仅 UI 文案,id 不变,避免 pipeline config 迁移)。

[shared.ts](../../src/components/settings/shared.ts) 里给 model input 加 `protocol` 字段。

## 类型 / DB / 迁移

- [src/types/index.ts](../../src/types/index.ts):新增并导出 `AiModelProtocol`。
- `AiSummaryConfigDocument.version: 6`,`normalizeAiSummaryConfigDocument` 内部处理 v5→v6:给每个 `model` 填 `protocol`。
- 数据库无 schema 变化(模型配置存在 `app_settings` 的 JSON 里,不是列)。
- [ai-summary-settings.test.ts](../../src/lib/ai-summary-settings.test.ts) 加测试:(1) v5 配置读出来 Gemini endpoint 被标成 `gemini`,其它标成 `openai-chat`;(2) 用户显式写的 protocol 被保留。
- [subtitle-api-fallback-settings.test.ts](../../src/lib/subtitle-api-fallback-settings.test.ts) 无需改(它只关心 `modelId`,不关心 protocol)。

## 错误处理与可观测

- Provider 抛错时外层现有的 `classifySubtitleFailure` / 退避逻辑继续生效。
- Provider 内部统一把 HTTP 非 2xx 转成 `Error(`<protocol> subtitle failed: HTTP <status> <body片段>`)`,让日志里一眼看出是哪个协议炸了。
- `AiGeneratedSubtitlePayload.metadata` 新增 `protocol: AiModelProtocol`,便于事后 debug。

## Rollout

1. 落 provider 目录 + 接口 + 三个实现(gemini 是搬家,behavior 不变)。
2. 改 `subtitles.ts` 调用点,跑现有测试 + 本地对一个 YouTube 视频跑 gemini 路径,结果应与改前 byte-by-byte 一致。
3. 加 settings migration + ModelsTab UI。
4. 手动用 OpenCode Zen 的 key 跑一次 openai-chat 路径(mimo-v2-omni + 一个 < 5 分钟 mp3)做冒烟。
5. 后续想加新供应商(比如 Groq whisper-on-chat):如果走这三个协议之一,只需在 ModelsTab 里加模型条目,无需代码改动;如果走全新协议(比如某家自定义 RPC),新增 `subtitle-providers/xxx.ts` 一个文件并注册。

## 开放问题

- **`max_tokens` 上限**:不同协议、不同模型对 `max_tokens` 的默认和硬上限不一致。当前 Gemini 的 `generateGeminiSubtitle` 里没显式传,靠模型默认。openai-chat / anthropic 协议建议 provider 内部默认传 `10240`,后续如果用户反馈截断再做成设置项。
- **音频切段大小**:硬编码 `5 * 60` 给 openai/anthropic 是经验值(对应 base64 后 ~5-8MB)。如果未来某些 openai 兼容厂(比如有 50MB 上限的)觉得 5 分钟太碎,可以让 provider 暴露 `maxAudioChunkSeconds` 成 "建议值",再在 `AiSummaryModelConfig` 上加 `audioChunkSecondsOverride` 让用户手动覆盖。本 spec 先不引入,留给实测反馈后迭代。
- **Anthropic 的 audio block**:`{"type":"audio","source":{...}}` 是 Anthropic messages 最近才加的能力,并非所有走 `/messages` 的兼容网关都支持。如果测试发现 OpenCode 的 `/zen/go/v1/messages` 吞不了 audio block,就把 Anthropic 协议标注为"仅文本+图像",音频强制走 openai-chat 路径。这个结论等 rollout 第 4 步的冒烟再定。
