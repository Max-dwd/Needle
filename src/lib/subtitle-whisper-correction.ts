import type { AiSummaryModelConfig } from '@/types';
import { log } from './logger';
import { sliceAudioByRange } from './audio-slicer';
import type {
  MultimodalTranscriber,
  TranscribePriority,
} from './subtitle-providers';
import type {
  SubtitleWhisperAiBatchConfig,
  SubtitleWhisperAiHallucinationConfig,
} from './subtitle-whisper-ai-settings';
import type { WhisperSegment } from './whisper-runtime';

export interface WhisperBatch {
  index: number;
  offsetSec: number;
  endSec: number;
  segments: WhisperSegment[];
}

export interface AnchoredSubtitleSegment {
  start: number;
  end: number;
  text: string;
}

export interface WhisperCorrectionVideoContext {
  platform: string;
  video_id: string;
  title?: string | null;
  channel_name?: string | null;
  description?: string | null;
}

export interface WhisperCorrectionRunResult {
  segments: AnchoredSubtitleSegment[];
  rawText: string;
  metadata: Record<string, string | number>;
}

export interface WhisperCorrection {
  id: number;
  text: string;
  drop: boolean;
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    corrections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          text: { type: 'string' },
          drop: { type: 'boolean' },
        },
        required: ['id', 'text', 'drop'],
      },
    },
  },
  required: ['corrections'],
} as const;

export function isLikelyHallucination(
  segment: WhisperSegment,
  config: SubtitleWhisperAiHallucinationConfig,
): boolean {
  if (
    segment.noSpeechProb !== undefined &&
    segment.noSpeechProb > config.noSpeechProbThreshold
  ) {
    return true;
  }
  if (
    segment.avgLogprob !== undefined &&
    segment.avgLogprob < config.avgLogprobThreshold
  ) {
    return true;
  }
  return false;
}

function durationOf(segments: WhisperSegment[]): number {
  if (segments.length === 0) return 0;
  return segments[segments.length - 1].end - segments[0].start;
}

function createBatch(index: number, segments: WhisperSegment[]): WhisperBatch {
  return {
    index,
    offsetSec: segments[0]?.start ?? 0,
    endSec: segments[segments.length - 1]?.end ?? 0,
    segments,
  };
}

function findSilenceCutIndex(
  segments: WhisperSegment[],
  targetSeconds: number,
  silenceWindow: number,
): number | null {
  if (segments.length < 2) return null;
  const batchStart = segments[0].start;
  const targetAt = batchStart + targetSeconds;
  const minAt = targetAt - silenceWindow;
  const maxAt = targetAt + silenceWindow;
  let bestIndex: number | null = null;
  let bestGap = -Infinity;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const current = segments[index];
    const next = segments[index + 1];
    const cutAt = (current.end + next.start) / 2;
    if (cutAt < minAt || cutAt > maxAt) continue;
    const gap = next.start - current.end;
    if (gap > bestGap) {
      bestGap = gap;
      bestIndex = index + 1;
    }
  }

  return bestIndex;
}

export function splitIntoBatches(
  segments: WhisperSegment[],
  options: SubtitleWhisperAiBatchConfig,
): WhisperBatch[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const batches: WhisperBatch[] = [];
  let pending: WhisperSegment[] = [];
  let index = 0;

  const flush = (items: WhisperSegment[]) => {
    if (items.length === 0) return;
    batches.push(createBatch(index, items));
    index += 1;
  };

  for (const segment of sorted) {
    pending.push(segment);
    const currentDuration = durationOf(pending);
    const hitHardLimit =
      currentDuration >= options.maxSeconds ||
      pending.length >= options.maxSegments;
    const hitTarget = currentDuration >= options.targetSeconds;

    if (!hitHardLimit && !hitTarget) continue;

    let cutIndex = pending.length;
    if (!hitHardLimit) {
      cutIndex =
        findSilenceCutIndex(
          pending,
          options.targetSeconds,
          options.silenceWindow,
        ) ?? pending.length;
    }

    flush(pending.slice(0, cutIndex));
    pending = pending.slice(cutIndex);
  }

  flush(pending);

  const tail = batches[batches.length - 1];
  const previous = batches[batches.length - 2];
  const tailDuration = tail ? tail.endSec - tail.offsetSec : 0;
  const previousWithTailDuration =
    tail && previous ? tail.endSec - previous.offsetSec : 0;
  const canMergeTail =
    tail &&
    previous &&
    previousWithTailDuration <= options.maxSeconds &&
    previous.segments.length + tail.segments.length <= options.maxSegments;
  if (
    canMergeTail &&
    tailDuration < Math.max(options.minSeconds, options.targetSeconds / 2)
  ) {
    previous.segments = [...previous.segments, ...tail.segments];
    previous.endSec = tail.endSec;
    batches.pop();
  }

  return batches.map((batch, batchIndex) => ({
    ...batch,
    index: batchIndex,
  }));
}

function rawSegmentsFromWhisper(
  segments: WhisperSegment[],
): AnchoredSubtitleSegment[] {
  return segments
    .map((segment) => {
      const text = segment.text.trim();
      if (!text) return null;
      return {
        start: segment.start,
        end: Math.max(segment.end, segment.start + 0.2),
        text,
      };
    })
    .filter((segment): segment is AnchoredSubtitleSegment => Boolean(segment));
}

export function mergeCorrections(
  whisper: WhisperSegment[],
  corrected: WhisperCorrection[],
): AnchoredSubtitleSegment[] {
  const byId = new Map(corrected.map((item) => [item.id, item]));
  return whisper
    .map((segment) => {
      const fix = byId.get(segment.id);
      if (!fix) {
        const fallbackText = segment.text.trim();
        if (!fallbackText) return null;
        return {
          start: segment.start,
          end: Math.max(segment.end, segment.start + 0.2),
          text: fallbackText,
        };
      }
      if (fix.drop) return null;
      const text = fix.text.trim();
      if (!text) return null;
      return {
        start: segment.start,
        end: Math.max(segment.end, segment.start + 0.2),
        text,
      };
    })
    .filter((segment): segment is AnchoredSubtitleSegment => Boolean(segment));
}

function parseCorrections(rawText: string): WhisperCorrection[] {
  const withoutFence = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const payload = JSON.parse(withoutFence) as unknown;
  const corrections = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? ((payload as Record<string, unknown>).corrections ??
        (payload as Record<string, unknown>).segments)
      : null;
  if (!Array.isArray(corrections)) {
    throw new Error('whisper-ai correction response missing corrections');
  }

  return corrections.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error('whisper-ai correction item is invalid');
    }
    const value = item as Record<string, unknown>;
    const id = Number(value.id);
    if (!Number.isInteger(id)) {
      throw new Error('whisper-ai correction id is invalid');
    }
    if (typeof value.text !== 'string' || typeof value.drop !== 'boolean') {
      throw new Error('whisper-ai correction fields are invalid');
    }
    return {
      id,
      text: value.text,
      drop: value.drop,
    };
  });
}

export function buildCorrectionPrompt(
  batch: WhisperBatch,
  video: WhisperCorrectionVideoContext,
): { systemPrompt: string; prompt: string } {
  const systemPrompt = [
    '你是精准字幕校对助手。',
    `视频标题:${video.title || video.video_id}`,
    `频道:${video.channel_name || '未知频道'}`,
    `描述摘要:${(video.description || '').slice(0, 500)}`,
    '规则:',
    '1. 你会收到音频片段和每个 segment 的 whisper_text 初稿。',
    '2. 听音频,对照 whisper_text 校正错字、漏字、专有名词和标点。',
    '3. 不要盲从 whisper_text；如果音频和初稿冲突,以音频为准。',
    '4. 严格保留 segment 数量和 id 一对一,不合并/不拆分/不新增。',
    '5. 静音/音乐/无人声段将 drop 设为 true,text 可留空。',
    '6. 出现专有名词优先参考视频标题和描述。',
    '7. 音频前后各有 0.5 秒边界余量,不在任何 segment 范围内,忽略即可。',
    '8. 只输出 JSON,不要任何解释。',
    '输出 JSON 结构: {"corrections":[{"id":1,"text":"校正后的文本","drop":false}]}',
  ].join('\n');

  const prompt = JSON.stringify({
    segments: batch.segments.map((segment) => ({
      id: segment.id,
      rel_start: +(segment.start - batch.offsetSec).toFixed(2),
      rel_end: +(segment.end - batch.offsetSec).toFixed(2),
      whisper_text: segment.text.trim(),
    })),
  });

  return { systemPrompt, prompt };
}

async function correctBatch(
  batch: WhisperBatch,
  audioPath: string,
  model: AiSummaryModelConfig,
  transcriber: MultimodalTranscriber,
  video: WhisperCorrectionVideoContext,
  priority: TranscribePriority,
  signal?: AbortSignal,
): Promise<{
  segments: AnchoredSubtitleSegment[];
  rawFallback: boolean;
  totalTokens?: number;
  ttftSeconds?: number;
}> {
  const { systemPrompt, prompt } = buildCorrectionPrompt(batch, video);
  const estimatedTokens = Math.ceil(
    (batch.endSec - batch.offsetSec) * 32 +
      batch.segments.length * 30 +
      batch.segments.reduce(
        (sum, segment) => sum + Math.ceil(segment.text.length / 2),
        0,
      ) +
      400,
  );
  const raw = await transcriber.transcribeAudio(model, {
    audioPath,
    mediaType: 'audio/mpeg',
    prompt,
    systemPrompt,
    responseSchema: RESPONSE_SCHEMA,
    maxOutputTokens: Math.max(2048, batch.segments.length * 80),
    priority,
    label: `whisper-ai:${video.platform}:${video.video_id}:batch-${batch.index + 1}`,
    estimatedTokens,
    signal,
  });
  const corrections = parseCorrections(raw.text);
  if (corrections.length === 0) {
    return {
      segments: rawSegmentsFromWhisper(batch.segments),
      rawFallback: true,
      totalTokens: raw.usage?.totalTokens,
      ttftSeconds: raw.ttftSeconds,
    };
  }

  const presentIds = new Set(corrections.map((item) => item.id));
  const missingCount = batch.segments.filter(
    (segment) => !presentIds.has(segment.id),
  ).length;
  if (missingCount / Math.max(1, batch.segments.length) > 0.2) {
    return {
      segments: rawSegmentsFromWhisper(batch.segments),
      rawFallback: true,
      totalTokens: raw.usage?.totalTokens,
      ttftSeconds: raw.ttftSeconds,
    };
  }

  return {
    segments: mergeCorrections(batch.segments, corrections),
    rawFallback: false,
    totalTokens: raw.usage?.totalTokens,
    ttftSeconds: raw.ttftSeconds,
  };
}

async function runWithConcurrency<T>(
  items: WhisperBatch[],
  concurrency: number,
  worker: (item: WhisperBatch) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (cursor < items.length) {
        const current = cursor;
        cursor += 1;
        results[current] = await worker(items[current]);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

export async function runWhisperAiCorrection(input: {
  audioPath: string;
  sliceOutputDir: string;
  whisperSegments: WhisperSegment[];
  batchConfig: SubtitleWhisperAiBatchConfig;
  hallucinationConfig: SubtitleWhisperAiHallucinationConfig;
  model: AiSummaryModelConfig;
  transcriber: MultimodalTranscriber;
  video: WhisperCorrectionVideoContext;
  priority: TranscribePriority;
  signal?: AbortSignal;
  beforeBatch?: () => Promise<void>;
}): Promise<WhisperCorrectionRunResult> {
  const usableSegments = input.whisperSegments.filter(
    (segment) => !isLikelyHallucination(segment, input.hallucinationConfig),
  );
  const hallucinationFilteredCount =
    input.whisperSegments.length - usableSegments.length;
  if (usableSegments.length === 0) {
    throw new Error('whisper-ai produced no usable speech segments');
  }

  const batches = splitIntoBatches(usableSegments, input.batchConfig);
  let correctionFailedBatchCount = 0;
  let rawFallbackBatchCount = 0;
  let totalTokens = 0;
  let firstBatchTtft: number | undefined;
  const corrected = await runWithConcurrency(batches, 3, async (batch) => {
    await input.beforeBatch?.();
    try {
      const slicePath = await sliceAudioByRange(
        input.audioPath,
        input.sliceOutputDir,
        batch,
        { signal: input.signal },
      );
      const result = await correctBatch(
        batch,
        slicePath,
        input.model,
        input.transcriber,
        input.video,
        input.priority,
        input.signal,
      );
      totalTokens += result.totalTokens || 0;
      if (firstBatchTtft === undefined) {
        firstBatchTtft = result.ttftSeconds;
      }
      if (result.rawFallback) rawFallbackBatchCount += 1;
      return result.segments;
    } catch (error) {
      correctionFailedBatchCount += 1;
      rawFallbackBatchCount += 1;
      log.warn('subtitle', 'whisper_ai_batch_fallback', {
        platform: input.video.platform,
        target: input.video.video_id,
        batch_index: batch.index,
        error: error instanceof Error ? error.message : String(error),
      });
      return rawSegmentsFromWhisper(batch.segments);
    }
  });

  const segments = corrected
    .flat()
    .sort((a, b) => a.start - b.start)
    .filter((segment) => segment.text.trim());
  if (segments.length === 0) {
    throw new Error('whisper-ai produced no subtitle text');
  }
  const rawText = segments
    .map(
      (segment) =>
        `[${segment.start.toFixed(2)}-${segment.end.toFixed(2)}] ${segment.text}`,
    )
    .join('\n');
  const rawFallbackRatio =
    batches.length > 0 ? rawFallbackBatchCount / batches.length : 0;

  return {
    segments,
    rawText,
    metadata: {
      batch_count: batches.length,
      batch_avg_seconds:
        batches.reduce(
          (sum, batch) => sum + (batch.endSec - batch.offsetSec),
          0,
        ) / Math.max(1, batches.length),
      hallucination_filtered_count: hallucinationFilteredCount,
      correction_failed_batch_count: correctionFailedBatchCount,
      correction_raw_fallback_ratio: rawFallbackRatio,
      ...(rawFallbackBatchCount === batches.length
        ? { fallback: 'raw-whisper' }
        : {}),
      ...(totalTokens > 0 ? { total_tokens: totalTokens } : {}),
      ...(firstBatchTtft !== undefined ? { ttft_seconds: firstBatchTtft } : {}),
    },
  };
}

export const __subtitleWhisperCorrectionTestUtils = {
  parseCorrections,
  rawSegmentsFromWhisper,
};
