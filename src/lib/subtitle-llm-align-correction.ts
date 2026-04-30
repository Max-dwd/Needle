import fs from 'fs';
import path from 'path';
import type { AiSummaryModelConfig } from '@/types';
import { log } from './logger';
import type {
  MultimodalTranscriber,
  TranscribePriority,
} from './subtitle-providers';
import type { JsonSchema } from './subtitle-providers/types';
import {
  runForcedAligner,
  type AlignedWord,
  type AlignerResult,
} from './forced-aligner-runtime';
import type {
  SubtitleLlmAlignerAlignerConfig,
  SubtitleLlmAlignerLlmConfig,
} from './subtitle-llm-aligner-settings';

const UTTERANCE_RESPONSE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    utterances: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          speaker: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['speaker', 'text'],
      },
    },
  },
  required: ['utterances'],
};

export interface LlmAlignVideoContext {
  platform: string;
  video_id: string;
  title?: string | null;
  channel_name?: string | null;
  description?: string | null;
}

export interface TranscribedUtterance {
  speaker: string;
  text: string;
}

export interface AlignedUtterance {
  speaker: string;
  text: string;
  /** Chunk 内相对秒 */
  start: number;
  end: number;
  avgProb: number | null;
}

export type ChunkAlignFallback = 'none' | 'interpolated';

export interface AlignedChunkResult {
  offsetSec: number;
  durationSec: number;
  utterances: AlignedUtterance[];
  alignFallback: ChunkAlignFallback;
  transcribeFailed: boolean;
  avgProb: number | null;
  wordCount: number;
}

export interface AssembledSubtitleSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

interface TranscribeChunkInput {
  chunkIndex: number;
  chunkOffsetSec: number;
  chunkEndSec: number;
  audioPath: string;
}

const MIN_AVG_PROB_DEFAULT = 0.3;
const MIN_WORD_RATIO_DEFAULT = 0.3;
const LLM_AUDIO_TOKENS_PER_SECOND = 32;
const LLM_PROMPT_TOKEN_OVERHEAD = 500;
const UTTERANCE_ARRAY_KEYS = [
  'utterances',
  'segments',
  'captions',
  'subtitles',
  'dialogue',
  'dialogues',
  'items',
  'results',
];
const UTTERANCE_TEXT_KEYS = [
  'text',
  'content',
  'utterance',
  'transcript',
  'transcription',
  'sentence',
  'line',
];
const UTTERANCE_SPEAKER_KEYS = [
  'speaker',
  'speaker_id',
  'speakerId',
  'speaker_label',
  'speakerLabel',
  'role',
  'label',
  'name',
];

export function buildLlmTranscribeSystemPrompt(
  video: LlmAlignVideoContext,
  expectSpeakerLabels: boolean,
): string {
  const title = (video.title || '').trim();
  const channel = (video.channel_name || '').trim();
  const description = (video.description || '').trim();
  const speakerRule = expectSpeakerLabels
    ? '3. speaker 字段用 S1/S2/S3…，全片保持一致编号（优先用视频标题/描述里出现的名字）。'
    : '3. speaker 字段全部写 S1，不做说话人区分。';

  return [
    '你是精准的多人对话听写助手。',
    `视频标题：${title || '未知'}`,
    `频道：${channel || '未知'}`,
    `描述摘要：${description.slice(0, 500)}`,
    '规则：',
    '1. 严格按原话转写，不改写、不意译、不删减语气词。',
    '2. 按说话人轮次切段；同一说话人连续说话算一段。',
    speakerRule,
    '4. 不输出时间戳，不输出解释，只输出 JSON。',
    '5. 音频前后各有 0.5 秒边界余量，属于上下文，忽略即可。',
  ].join('\n');
}

function estimateTranscribeTokens(chunkSeconds: number): number {
  return (
    Math.max(1, Math.ceil(chunkSeconds)) * LLM_AUDIO_TOKENS_PER_SECOND +
    LLM_PROMPT_TOKEN_OVERHEAD
  );
}

function extractJsonCandidate(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const firstObject = trimmed.indexOf('{');
  const firstArray = trimmed.indexOf('[');
  const starts = [firstObject, firstArray].filter((index) => index >= 0);
  if (starts.length === 0) return trimmed;

  const start = Math.min(...starts);
  const endChar = trimmed[start] === '[' ? ']' : '}';
  const end = trimmed.lastIndexOf(endChar);
  if (end <= start) return trimmed.slice(start);
  return trimmed.slice(start, end + 1);
}

function pickString(
  value: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  }
  return null;
}

function normalizeSpeaker(value: string | null, fallback = 'S1'): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  const numeric = trimmed.match(/^(?:speaker|spk|说话人)\s*([0-9]+)$/i);
  if (numeric?.[1]) return `S${numeric[1]}`;
  return trimmed.replace(/^\[|\]$/g, '').trim() || fallback;
}

function parseSpeakerLineTranscript(
  text: string,
  fallbackSpeaker = 'S1',
): TranscribedUtterance[] {
  const utterances: TranscribedUtterance[] = [];
  const speakerLinePattern =
    /^(?:\[?((?:S|Speaker|spk)\s*\d{1,3}|说话人\s*\d{1,3})\]?|(?:speaker|spk|说话人)\s*([0-9A-Za-z_-]+))\s*[：:]\s*(.+)$/i;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(speakerLinePattern);
    if (!match) continue;
    const speaker = normalizeSpeaker(match[1] || match[2] || null);
    const content = (match[3] || '').trim();
    if (content) utterances.push({ speaker, text: content });
  }

  if (utterances.length > 0) return utterances;

  const trimmed = text.trim();
  return trimmed ? [{ speaker: fallbackSpeaker, text: trimmed }] : [];
}

function normalizeUtteranceItem(
  item: unknown,
  fallbackSpeaker = 'S1',
): TranscribedUtterance[] {
  if (typeof item === 'string') {
    return parseSpeakerLineTranscript(item, fallbackSpeaker);
  }
  if (!item || typeof item !== 'object') return [];

  const value = item as Record<string, unknown>;
  const speaker = normalizeSpeaker(
    pickString(value, UTTERANCE_SPEAKER_KEYS),
    fallbackSpeaker,
  );
  const text = pickString(value, UTTERANCE_TEXT_KEYS);
  if (text) return [{ speaker, text }];

  for (const key of UTTERANCE_ARRAY_KEYS) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      return nested.flatMap((entry) =>
        normalizeUtteranceItem(entry, speaker),
      );
    }
  }

  return [];
}

function looksLikeSpeakerKey(key: string): boolean {
  return /^(?:S\d{1,3}|Speaker\s*\d{1,3}|spk\s*\d{1,3}|说话人\s*\d{1,3})$/i.test(
    key.trim(),
  );
}

function normalizeUtterancePayload(payload: unknown): TranscribedUtterance[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((entry) => normalizeUtteranceItem(entry));
  }
  if (typeof payload === 'string') {
    return parseSpeakerLineTranscript(payload);
  }
  if (!payload || typeof payload !== 'object') return [];

  const value = payload as Record<string, unknown>;
  if (pickString(value, UTTERANCE_TEXT_KEYS)) {
    return normalizeUtteranceItem(value);
  }

  for (const key of UTTERANCE_ARRAY_KEYS) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      return nested.flatMap((entry) => normalizeUtteranceItem(entry));
    }
    if (typeof nested === 'string' && nested.trim()) {
      return parseSpeakerLineTranscript(nested);
    }
  }

  const mappedBySpeaker: TranscribedUtterance[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (!looksLikeSpeakerKey(key)) continue;
    const speaker = normalizeSpeaker(key);
    if (typeof raw === 'string' && raw.trim()) {
      mappedBySpeaker.push({ speaker, text: raw.trim() });
    } else if (Array.isArray(raw)) {
      for (const entry of raw) {
        mappedBySpeaker.push(...normalizeUtteranceItem(entry, speaker));
      }
    }
  }
  return mappedBySpeaker;
}

function describePayloadShape(payload: unknown): string {
  if (Array.isArray(payload)) return `array(${payload.length})`;
  if (!payload || typeof payload !== 'object') return typeof payload;
  const keys = Object.keys(payload as Record<string, unknown>);
  return keys.length > 0
    ? `object keys: ${keys.slice(0, 8).join(', ')}`
    : 'empty object';
}

export function parseUtterancesJson(rawText: string): TranscribedUtterance[] {
  const candidate = extractJsonCandidate(rawText).trim();
  if (!candidate) {
    throw new Error('llm-aligner empty transcription output');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(candidate) as unknown;
  } catch (error) {
    const speakerLines = parseSpeakerLineTranscript(rawText);
    if (speakerLines.length > 0 && speakerLines[0]?.text !== rawText.trim()) {
      return speakerLines;
    }
    throw error;
  }

  const utterances = normalizeUtterancePayload(payload).filter((utterance) =>
    utterance.text.trim(),
  );
  if (utterances.length === 0) {
    throw new Error(
      `llm-aligner utterances missing from response (${describePayloadShape(payload)})`,
    );
  }
  return utterances;
}

export interface TranscribeChunkOptions {
  chunk: TranscribeChunkInput;
  video: LlmAlignVideoContext;
  model: AiSummaryModelConfig;
  transcriber: MultimodalTranscriber;
  llmConfig: SubtitleLlmAlignerLlmConfig;
  priority: TranscribePriority;
  chunkSeconds: number;
  signal?: AbortSignal;
}

export interface TranscribeChunkResult {
  utterances: TranscribedUtterance[];
  totalTokens?: number;
  ttftSeconds?: number;
}

export async function transcribeChunk(
  options: TranscribeChunkOptions,
): Promise<TranscribeChunkResult> {
  const systemPrompt = buildLlmTranscribeSystemPrompt(
    options.video,
    options.llmConfig.expectSpeakerLabels,
  );
  const raw = await options.transcriber.transcribeAudio(options.model, {
    audioPath: options.chunk.audioPath,
    mediaType: 'audio/mpeg',
    prompt: [
      '请听音频并只输出严格 JSON，不要 Markdown，不要解释。',
      'JSON 形状必须是：{"utterances":[{"speaker":"S1","text":"逐字转写内容"}]}',
      options.llmConfig.expectSpeakerLabels
        ? 'speaker 用 S1/S2/S3 等编号；如果无法区分说话人，全部用 S1。'
        : 'speaker 全部写 S1。',
      'text 只放原话正文，不要包含时间戳或 speaker 前缀。',
    ].join('\n'),
    systemPrompt,
    responseSchema: UTTERANCE_RESPONSE_SCHEMA,
    priority: options.priority,
    label: `llm-aligner:${options.video.video_id}:chunk-${options.chunk.chunkIndex + 1}`,
    estimatedTokens: estimateTranscribeTokens(options.chunkSeconds),
    signal: options.signal,
  });

  const utterances = parseUtterancesJson(raw.text);
  return {
    utterances,
    totalTokens: raw.usage?.totalTokens,
    ttftSeconds: raw.ttftSeconds,
  };
}

// ---------------------------------------------------------------------------
// Forced alignment char-based mapping
// ---------------------------------------------------------------------------

interface CharMapping {
  char: string;
  utteranceIndex: number;
}

export function buildTranscriptText(
  utterances: TranscribedUtterance[],
  expectSpeakerLabels: boolean,
): { text: string; charMapping: CharMapping[] } {
  const lines: string[] = [];
  const charMapping: CharMapping[] = [];

  utterances.forEach((utterance, index) => {
    // The speaker prefix is cosmetic for the aligner; we only count text chars
    // towards the utterance mapping to make alignment robust to prefix tokens.
    const prefix = expectSpeakerLabels ? `${utterance.speaker}: ` : '';
    lines.push(`${prefix}${utterance.text}`);
    // Push actual text chars into mapping, skipping whitespace tracking for
    // start-of-line (which we treat as utterance boundary separator).
    for (const char of utterance.text) {
      if (/\s/.test(char)) continue;
      charMapping.push({ char, utteranceIndex: index });
    }
  });

  return { text: lines.join('\n'), charMapping };
}

function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}

interface UtteranceTimingAccumulator {
  start: number;
  end: number;
  probSum: number;
  probCount: number;
  wordCount: number;
}

export interface MapAlignedWordsResult {
  utteranceTimings: Array<{
    start: number;
    end: number;
    avgProb: number | null;
    wordCount: number;
  } | null>;
  avgProb: number | null;
  matchedChars: number;
  sourceChars: number;
}

export function mapAlignedWordsToUtterances(
  words: AlignedWord[],
  utterances: TranscribedUtterance[],
  charMapping: Array<{ utteranceIndex: number }>,
): MapAlignedWordsResult {
  const accumulators: Array<UtteranceTimingAccumulator | null> = utterances.map(
    () => null,
  );
  let charPointer = 0;
  let totalProbSum = 0;
  let totalProbCount = 0;

  for (const word of words) {
    const stripped = stripWhitespace(word.text);
    if (!stripped) continue;
    const consumeCount = stripped.length;
    const endPointer = Math.min(
      charMapping.length,
      charPointer + consumeCount,
    );
    if (endPointer <= charPointer) continue;

    const utteranceCounts = new Map<number, number>();
    for (let i = charPointer; i < endPointer; i += 1) {
      const mapping = charMapping[i];
      if (!mapping) continue;
      utteranceCounts.set(
        mapping.utteranceIndex,
        (utteranceCounts.get(mapping.utteranceIndex) || 0) + 1,
      );
    }

    // Attribute the whole word to the dominant utterance for timing.
    let dominantIndex = -1;
    let dominantCount = -1;
    for (const [utteranceIndex, count] of utteranceCounts) {
      if (count > dominantCount) {
        dominantCount = count;
        dominantIndex = utteranceIndex;
      }
    }

    if (dominantIndex >= 0) {
      const current = accumulators[dominantIndex];
      if (!current) {
        accumulators[dominantIndex] = {
          start: word.start,
          end: word.end,
          probSum: typeof word.prob === 'number' ? word.prob : 0,
          probCount: typeof word.prob === 'number' ? 1 : 0,
          wordCount: 1,
        };
      } else {
        current.start = Math.min(current.start, word.start);
        current.end = Math.max(current.end, word.end);
        if (typeof word.prob === 'number') {
          current.probSum += word.prob;
          current.probCount += 1;
        }
        current.wordCount += 1;
      }
      if (typeof word.prob === 'number') {
        totalProbSum += word.prob;
        totalProbCount += 1;
      }
    }

    charPointer = endPointer;
  }

  return {
    utteranceTimings: accumulators.map((entry) =>
      entry
        ? {
            start: entry.start,
            end: Math.max(entry.end, entry.start + 0.05),
            avgProb:
              entry.probCount > 0 ? entry.probSum / entry.probCount : null,
            wordCount: entry.wordCount,
          }
        : null,
    ),
    avgProb: totalProbCount > 0 ? totalProbSum / totalProbCount : null,
    matchedChars: charPointer,
    sourceChars: charMapping.length,
  };
}

export function interpolateUtterances(
  utterances: TranscribedUtterance[],
  chunkDurationSec: number,
): AlignedUtterance[] {
  if (utterances.length === 0) return [];
  const safeDuration = Math.max(0.1, chunkDurationSec);
  const totalChars = utterances.reduce((sum, u) => sum + u.text.length, 0);
  if (totalChars === 0) {
    const per = safeDuration / utterances.length;
    return utterances.map((u, index) => ({
      speaker: u.speaker,
      text: u.text,
      start: index * per,
      end: Math.min(safeDuration, (index + 1) * per),
      avgProb: null,
    }));
  }

  let cursor = 0;
  return utterances.map((u) => {
    const share = (u.text.length / totalChars) * safeDuration;
    const start = cursor;
    const end = Math.min(safeDuration, cursor + share);
    cursor = end;
    return {
      speaker: u.speaker,
      text: u.text,
      start,
      end: Math.max(end, start + 0.05),
      avgProb: null,
    };
  });
}

export function buildTranscribeFailedChunk(input: {
  chunkIndex: number;
  chunkOffsetSec: number;
  durationSec: number;
  speaker?: string;
  text?: string;
}): AlignedChunkResult {
  const speaker = input.speaker?.trim() || 'S1';
  const text = input.text?.trim() || '[转写失败]';
  return {
    offsetSec: input.chunkOffsetSec,
    durationSec: Math.max(0.1, input.durationSec),
    utterances: [
      {
        speaker,
        text,
        start: 0,
        end: Math.max(0.1, input.durationSec),
        avgProb: null,
      },
    ],
    alignFallback: 'interpolated',
    transcribeFailed: true,
    avgProb: null,
    wordCount: 0,
  };
}

export interface AlignChunkOptions {
  chunk: TranscribeChunkInput & { durationSec: number };
  utterances: TranscribedUtterance[];
  alignerConfig: SubtitleLlmAlignerAlignerConfig;
  llmConfig: SubtitleLlmAlignerLlmConfig;
  transcriptWritePath: string;
  alignerOutputDir: string;
  signal?: AbortSignal;
  runAligner?: (
    audioPath: string,
    textPath: string,
    options: Parameters<typeof runForcedAligner>[2],
  ) => Promise<AlignerResult>;
  writeTranscript?: (path: string, text: string) => void;
}

export async function alignChunk(
  options: AlignChunkOptions,
): Promise<AlignedChunkResult> {
  const {
    chunk,
    utterances,
    alignerConfig,
    llmConfig,
    transcriptWritePath,
    alignerOutputDir,
    signal,
  } = options;

  if (utterances.length === 0) {
    return {
      offsetSec: chunk.chunkOffsetSec,
      durationSec: chunk.durationSec,
      utterances: [],
      alignFallback: 'none',
      transcribeFailed: false,
      avgProb: null,
      wordCount: 0,
    };
  }

  const { text, charMapping } = buildTranscriptText(
    utterances,
    llmConfig.expectSpeakerLabels,
  );
  const write = options.writeTranscript || defaultWriteTranscript;
  const aligner = options.runAligner || runForcedAligner;

  write(transcriptWritePath, text);

  let alignerResult: AlignerResult | null = null;
  try {
    alignerResult = await aligner(chunk.audioPath, transcriptWritePath, {
      modelId: alignerConfig.modelId,
      outputDir: alignerOutputDir,
      audioDurationSeconds: chunk.durationSec,
      signal,
    });
  } catch (error) {
    log.warn('subtitle', 'llm_aligner_chunk_failed', {
      chunk_index: chunk.chunkIndex,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const minAvgProb = Number.isFinite(alignerConfig.minAvgProb)
    ? alignerConfig.minAvgProb
    : MIN_AVG_PROB_DEFAULT;
  const minWordRatio = Number.isFinite(alignerConfig.minWordRatio)
    ? alignerConfig.minWordRatio
    : MIN_WORD_RATIO_DEFAULT;

  if (!alignerResult) {
    return buildInterpolatedChunk(
      chunk,
      utterances,
      'aligner-error',
    );
  }

  const mapping = mapAlignedWordsToUtterances(
    alignerResult.words,
    utterances,
    charMapping,
  );

  const wordCharRatio =
    charMapping.length === 0 ? 0 : mapping.matchedChars / charMapping.length;

  if (
    mapping.avgProb !== null &&
    mapping.avgProb < minAvgProb
  ) {
    return buildInterpolatedChunk(
      chunk,
      utterances,
      'low-prob',
      mapping.avgProb,
      mapping.matchedChars,
    );
  }

  if (wordCharRatio < minWordRatio) {
    return buildInterpolatedChunk(
      chunk,
      utterances,
      'low-word-ratio',
      mapping.avgProb,
      mapping.matchedChars,
    );
  }

  const alignedUtterances: AlignedUtterance[] = utterances.map(
    (utterance, index) => {
      const timing = mapping.utteranceTimings[index];
      if (!timing) {
        // Missing timing for this utterance — interpolate within neighbours
        return null;
      }
      const bounded = boundTiming(timing.start, timing.end, chunk.durationSec);
      return {
        speaker: utterance.speaker,
        text: utterance.text,
        start: bounded.start,
        end: bounded.end,
        avgProb: timing.avgProb,
      };
    },
  ).filter((value): value is AlignedUtterance => value !== null);

  if (alignedUtterances.length === 0) {
    return buildInterpolatedChunk(
      chunk,
      utterances,
      'no-utterance-timings',
      mapping.avgProb,
      mapping.matchedChars,
    );
  }

  return {
    offsetSec: chunk.chunkOffsetSec,
    durationSec: chunk.durationSec,
    utterances: alignedUtterances,
    alignFallback: 'none',
    transcribeFailed: false,
    avgProb: mapping.avgProb,
    wordCount: alignerResult.words.length,
  };
}

function defaultWriteTranscript(targetPath: string, text: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, text, 'utf8');
}

function boundTiming(
  start: number,
  end: number,
  durationSec: number,
): { start: number; end: number } {
  const safeDuration = Math.max(0.1, durationSec);
  const clampedStart = Math.max(0, Math.min(safeDuration, start));
  const clampedEnd = Math.max(
    clampedStart + 0.05,
    Math.min(safeDuration, end),
  );
  return { start: clampedStart, end: clampedEnd };
}

function buildInterpolatedChunk(
  chunk: TranscribeChunkInput & { durationSec: number },
  utterances: TranscribedUtterance[],
  reason: string,
  avgProb: number | null = null,
  matchedChars = 0,
): AlignedChunkResult {
  const interpolated = interpolateUtterances(utterances, chunk.durationSec);
  log.info('subtitle', 'llm_aligner_chunk_interpolated', {
    chunk_index: chunk.chunkIndex,
    reason,
    avg_prob: avgProb,
    matched_chars: matchedChars,
    utterance_count: utterances.length,
  });
  return {
    offsetSec: chunk.chunkOffsetSec,
    durationSec: chunk.durationSec,
    utterances: interpolated,
    alignFallback: 'interpolated',
    transcribeFailed: false,
    avgProb,
    wordCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Assemble chunks -> SubtitleSegment[]
// ---------------------------------------------------------------------------

export function assembleSegments(
  chunks: AlignedChunkResult[],
): AssembledSubtitleSegment[] {
  const segments: AssembledSubtitleSegment[] = [];
  for (const chunk of chunks) {
    for (const utterance of chunk.utterances) {
      const text = utterance.text.trim();
      if (!text) continue;
      const start = chunk.offsetSec + utterance.start;
      const end = chunk.offsetSec + utterance.end;
      segments.push({
        start: Math.max(0, start),
        end: Math.max(start + 0.05, end),
        text,
        speaker: utterance.speaker || undefined,
      });
    }
  }
  return segments;
}

export interface LlmAlignerChunkSummary {
  chunkCount: number;
  interpolatedCount: number;
  transcribeFailedCount: number;
  totalWordCount: number;
  avgProb: number | null;
  totalTokens: number | undefined;
  firstChunkTtft: number | undefined;
  allInterpolated: boolean;
}

export function summarizeChunkResults(
  chunks: AlignedChunkResult[],
  options: {
    totalTokens?: number;
    firstChunkTtft?: number;
  } = {},
): LlmAlignerChunkSummary {
  const interpolated = chunks.filter(
    (chunk) => chunk.alignFallback === 'interpolated',
  );
  const transcribeFailed = chunks.filter((chunk) => chunk.transcribeFailed);
  const probs = chunks
    .map((chunk) => chunk.avgProb)
    .filter((value): value is number => typeof value === 'number');
  const avgProb =
    probs.length === 0
      ? null
      : probs.reduce((sum, value) => sum + value, 0) / probs.length;
  const totalWordCount = chunks.reduce(
    (sum, chunk) => sum + chunk.wordCount,
    0,
  );
  const allInterpolated =
    chunks.length > 0 && interpolated.length === chunks.length;

  return {
    chunkCount: chunks.length,
    interpolatedCount: interpolated.length,
    transcribeFailedCount: transcribeFailed.length,
    totalWordCount,
    avgProb,
    totalTokens: options.totalTokens,
    firstChunkTtft: options.firstChunkTtft,
    allInterpolated,
  };
}
