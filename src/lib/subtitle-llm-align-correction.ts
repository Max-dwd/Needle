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
  transcribeDurationMs?: number;
  alignerDurationMs?: number;
  missingTimingUtteranceCount?: number;
  collapsedTimingUtteranceCount?: number;
  localInterpolatedUtteranceCount?: number;
  matchedCharRatio?: number;
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
    '2. 按自然语句和字幕阅读节奏切段；即使同一说话人连续发言，也要拆成多个短句段。',
    speakerRule,
    '4. 单段尽量是一句完整短句，避免整段独白；不要为了说话人一致而合并长段。',
    '5. 不输出时间戳，不输出解释，只输出 JSON。',
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
      return nested.flatMap((entry) => normalizeUtteranceItem(entry, speaker));
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
      ...(options.llmConfig.verbatimCoveragePrompt
        ? [
            '必须从音频开头到结尾完整覆盖，不能跳过任何句子、重复、口头禅、转折词或列举项。',
            '按听到的原话逐字转写；不要总结、改写、润色、合并相邻观点或用同义词替换。',
            '英文产品名、公司名、缩写、数字、金额、百分比和专有名词要尽量保留原文；听不清时写最接近的音译或拼写，不要删除。',
          ]
        : []),
      `每个 utterance 是最终字幕候选段，尽量控制在 ${options.llmConfig.maxSegmentSeconds} 秒左右的自然短句；同一说话人连续讲话也要拆短，不要合成长段。`,
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

interface NormalizedCharMapping {
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
    // Speaker labels are metadata. Sending them to the aligner shifts the
    // char-based mapping because the aligned tokens include labels that are not
    // part of the subtitle text.
    lines.push(utterance.text);
    // Push actual text chars into mapping, skipping whitespace tracking.
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

function normalizeMatchChars(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  return Array.from(normalized).filter((char) => isMatchableChar(char));
}

function isMatchableChar(char: string): boolean {
  if (!char || /\s/u.test(char)) return false;
  return !/^[\p{P}\p{S}]$/u.test(char);
}

function normalizeCharMapping(
  charMapping: Array<{ char?: string; utteranceIndex: number }>,
): NormalizedCharMapping[] {
  const normalized: NormalizedCharMapping[] = [];
  for (const mapping of charMapping) {
    for (const char of normalizeMatchChars(mapping.char || '')) {
      normalized.push({ char, utteranceIndex: mapping.utteranceIndex });
    }
  }
  return normalized;
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
  charMapping: Array<{ char?: string; utteranceIndex: number }>,
): MapAlignedWordsResult {
  const accumulators: Array<UtteranceTimingAccumulator | null> = utterances.map(
    () => null,
  );
  const normalizedMapping = normalizeCharMapping(charMapping);
  let charPointer = 0;
  let matchedChars = 0;
  let totalProbSum = 0;
  let totalProbCount = 0;

  for (const word of words) {
    const wordChars = normalizeMatchChars(stripWhitespace(word.text));
    if (wordChars.length === 0) continue;
    const match = findLocalNormalizedMatch(
      normalizedMapping,
      wordChars,
      charPointer,
    );
    if (!match) continue;

    const utteranceCounts = new Map<number, number>();
    for (let i = match.start; i < match.end; i += 1) {
      const mapping = normalizedMapping[i];
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

    matchedChars += match.matchedCount;
    charPointer = match.end;
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
    matchedChars,
    sourceChars: normalizedMapping.length,
  };
}

function findLocalNormalizedMatch(
  source: NormalizedCharMapping[],
  wordChars: string[],
  cursor: number,
): { start: number; end: number; matchedCount: number } | null {
  if (source.length === 0 || wordChars.length === 0) return null;

  const searchStart = Math.max(0, cursor);
  const searchEnd = Math.min(source.length, cursor + 48);

  for (let start = searchStart; start < searchEnd; start += 1) {
    if (source[start]?.char !== wordChars[0]) continue;
    let matchedCount = 0;
    while (
      matchedCount < wordChars.length &&
      start + matchedCount < source.length &&
      source[start + matchedCount]?.char === wordChars[matchedCount]
    ) {
      matchedCount += 1;
    }
    if (matchedCount === wordChars.length) {
      return {
        start,
        end: start + matchedCount,
        matchedCount,
      };
    }
  }

  let best: { start: number; matchedCount: number } | null = null;
  for (let start = searchStart; start < searchEnd; start += 1) {
    let matchedCount = 0;
    while (
      matchedCount < wordChars.length &&
      start + matchedCount < source.length &&
      source[start + matchedCount]?.char === wordChars[matchedCount]
    ) {
      matchedCount += 1;
    }
    if (!best || matchedCount > best.matchedCount) {
      best = { start, matchedCount };
    }
  }

  const minPartialMatch = Math.min(wordChars.length, 2);
  if (!best || best.matchedCount < minPartialMatch) return null;
  return {
    start: best.start,
    end: best.start + best.matchedCount,
    matchedCount: best.matchedCount,
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
  maxSegmentSeconds?: number;
  speaker?: string;
  text?: string;
  transcribeDurationMs?: number;
}): AlignedChunkResult {
  const speaker = input.speaker?.trim() || 'S1';
  const text = input.text?.trim() || '[转写失败]';
  const durationSec = Math.max(0.1, input.durationSec);
  const maxSegmentSeconds =
    Number.isFinite(input.maxSegmentSeconds) &&
    Number(input.maxSegmentSeconds) > 0
      ? Number(input.maxSegmentSeconds)
      : durationSec;
  const partCount = Math.max(1, Math.ceil(durationSec / maxSegmentSeconds));
  const partDuration = durationSec / partCount;
  return {
    offsetSec: input.chunkOffsetSec,
    durationSec,
    utterances: Array.from({ length: partCount }, (_, index) => {
      const start = partDuration * index;
      const end =
        index === partCount - 1 ? durationSec : partDuration * (index + 1);
      return {
        speaker,
        text: partCount > 1 ? `${text} ${index + 1}/${partCount}` : text,
        start,
        end: Math.max(start + 0.05, end),
        avgProb: null,
      };
    }),
    alignFallback: 'interpolated',
    transcribeFailed: true,
    avgProb: null,
    wordCount: 0,
    ...(typeof input.transcribeDurationMs === 'number'
      ? { transcribeDurationMs: input.transcribeDurationMs }
      : {}),
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
  const alignerStartedMs = Date.now();
  let alignerDurationMs = 0;
  try {
    alignerResult = await aligner(chunk.audioPath, transcriptWritePath, {
      modelId: alignerConfig.modelId,
      outputDir: alignerOutputDir,
      audioDurationSeconds: chunk.durationSec,
      signal,
    });
    alignerDurationMs = Date.now() - alignerStartedMs;
  } catch (error) {
    alignerDurationMs = Date.now() - alignerStartedMs;
    log.warn('subtitle', 'llm_aligner_chunk_failed', {
      chunk_index: chunk.chunkIndex,
      aligner_duration_ms: alignerDurationMs,
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
      null,
      0,
      alignerDurationMs,
    );
  }

  const mapping = mapAlignedWordsToUtterances(
    alignerResult.words,
    utterances,
    charMapping,
  );

  const wordCharRatio =
    mapping.sourceChars === 0 ? 0 : mapping.matchedChars / mapping.sourceChars;
  const matchedCharRatio = Number(wordCharRatio.toFixed(4));

  if (mapping.avgProb !== null && mapping.avgProb < minAvgProb) {
    return buildInterpolatedChunk(
      chunk,
      utterances,
      'low-prob',
      mapping.avgProb,
      mapping.matchedChars,
      alignerDurationMs,
    );
  }

  if (wordCharRatio < minWordRatio) {
    return buildInterpolatedChunk(
      chunk,
      utterances,
      'low-word-ratio',
      mapping.avgProb,
      mapping.matchedChars,
      alignerDurationMs,
    );
  }

  const aligned = buildAlignedUtterancesWithInterpolation(
    utterances,
    mapping.utteranceTimings,
    chunk.durationSec,
  );

  if (aligned.utterances.length === 0) {
    return buildInterpolatedChunk(
      chunk,
      utterances,
      'no-utterance-timings',
      mapping.avgProb,
      mapping.matchedChars,
      alignerDurationMs,
    );
  }

  return {
    offsetSec: chunk.chunkOffsetSec,
    durationSec: chunk.durationSec,
    utterances: aligned.utterances,
    alignFallback: 'none',
    transcribeFailed: false,
    avgProb: mapping.avgProb,
    wordCount: alignerResult.words.length,
    alignerDurationMs,
    missingTimingUtteranceCount: aligned.missingTimingCount,
    collapsedTimingUtteranceCount: aligned.collapsedTimingCount,
    localInterpolatedUtteranceCount: aligned.localInterpolatedCount,
    matchedCharRatio,
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
  const clampedEnd = Math.max(clampedStart + 0.05, Math.min(safeDuration, end));
  return { start: clampedStart, end: clampedEnd };
}

function buildAlignedUtterancesWithInterpolation(
  utterances: TranscribedUtterance[],
  timings: MapAlignedWordsResult['utteranceTimings'],
  durationSec: number,
): {
  utterances: AlignedUtterance[];
  missingTimingCount: number;
  collapsedTimingCount: number;
  localInterpolatedCount: number;
} {
  const safeDuration = Math.max(0.1, durationSec);
  let missingTimingCount = 0;
  let collapsedTimingCount = 0;
  let localInterpolatedCount = 0;
  const aligned: Array<AlignedUtterance | null> = utterances.map(
    (utterance, index) => {
      const timing = timings[index];
      if (!timing) {
        missingTimingCount += 1;
        return null;
      }
      if (isSuspiciouslyCollapsedTiming(timing, utterance.text)) {
        collapsedTimingCount += 1;
        return null;
      }
      const bounded = boundTiming(timing.start, timing.end, safeDuration);
      return {
        speaker: utterance.speaker,
        text: utterance.text,
        start: bounded.start,
        end: bounded.end,
        avgProb: timing.avgProb,
      };
    },
  );

  let index = 0;
  while (index < utterances.length) {
    if (aligned[index]) {
      index += 1;
      continue;
    }

    const runStart = index;
    while (index < utterances.length && !aligned[index]) index += 1;
    const runEnd = index;
    const previous = runStart > 0 ? aligned[runStart - 1] : null;
    const next = runEnd < aligned.length ? aligned[runEnd] : null;
    const window = buildInterpolationWindow(
      previous,
      next,
      runEnd - runStart,
      safeDuration,
    );
    const interpolated = interpolateUtteranceRun(
      utterances.slice(runStart, runEnd),
      window.start,
      window.end,
    );
    localInterpolatedCount += interpolated.length;
    interpolated.forEach((utterance, offset) => {
      aligned[runStart + offset] = utterance;
    });
  }

  return {
    utterances: aligned.filter(
      (value): value is AlignedUtterance => value !== null,
    ),
    missingTimingCount,
    collapsedTimingCount,
    localInterpolatedCount,
  };
}

function isSuspiciouslyCollapsedTiming(
  timing: NonNullable<MapAlignedWordsResult['utteranceTimings'][number]>,
  text: string,
): boolean {
  const duration = timing.end - timing.start;
  if (duration >= 0.2) return false;

  const matchableChars = normalizeMatchChars(text).length;
  if (matchableChars < 8) return false;

  return duration <= 0.05 || matchableChars / Math.max(duration, 0.01) > 40;
}

function buildInterpolationWindow(
  previous: AlignedUtterance | null,
  next: AlignedUtterance | null,
  count: number,
  durationSec: number,
): { start: number; end: number } {
  const minDuration = Math.max(1, count) * 0.05;
  const start = previous ? previous.end : 0;
  const end = next ? next.start : durationSec;
  if (end > start) return { start, end };

  if (next) {
    return {
      start: Math.max(0, end - minDuration),
      end: Math.max(0, end),
    };
  }

  return {
    start: Math.max(0, Math.min(start, durationSec - minDuration)),
    end: durationSec,
  };
}

function interpolateUtteranceRun(
  utterances: TranscribedUtterance[],
  startSec: number,
  endSec: number,
): AlignedUtterance[] {
  if (utterances.length === 0) return [];
  const safeEnd = Math.max(startSec + 0.05 * utterances.length, endSec);
  const totalChars = utterances.reduce(
    (sum, utterance) => sum + Math.max(1, Array.from(utterance.text).length),
    0,
  );
  let cursor = startSec;
  return utterances.map((utterance, index) => {
    const isLast = index === utterances.length - 1;
    const share =
      (Math.max(1, Array.from(utterance.text).length) / totalChars) *
      (safeEnd - startSec);
    const end = isLast ? safeEnd : cursor + share;
    const aligned = {
      speaker: utterance.speaker,
      text: utterance.text,
      start: cursor,
      end: Math.max(cursor + 0.05, end),
      avgProb: null,
    };
    cursor = aligned.end;
    return aligned;
  });
}

function buildInterpolatedChunk(
  chunk: TranscribeChunkInput & { durationSec: number },
  utterances: TranscribedUtterance[],
  reason: string,
  avgProb: number | null = null,
  matchedChars = 0,
  alignerDurationMs?: number,
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
    alignerDurationMs,
  };
}

// ---------------------------------------------------------------------------
// Assemble chunks -> SubtitleSegment[]
// ---------------------------------------------------------------------------

export function assembleSegments(
  chunks: AlignedChunkResult[],
  options: { maxSegmentSeconds?: number } = {},
): AssembledSubtitleSegment[] {
  const segments: AssembledSubtitleSegment[] = [];
  const maxSegmentSeconds = Number.isFinite(options.maxSegmentSeconds)
    ? Math.max(0.5, Number(options.maxSegmentSeconds))
    : null;
  for (const chunk of chunks) {
    for (const utterance of chunk.utterances) {
      const text = utterance.text.trim();
      if (!text) continue;
      const start = chunk.offsetSec + utterance.start;
      const end = chunk.offsetSec + utterance.end;
      const segment = {
        start: Math.max(0, start),
        end: Math.max(start + 0.05, end),
        text,
        speaker: utterance.speaker || undefined,
      };
      segments.push(
        ...(maxSegmentSeconds
          ? splitLongSegment(segment, maxSegmentSeconds)
          : [segment]),
      );
    }
  }
  return segments;
}

function splitLongSegment(
  segment: AssembledSubtitleSegment,
  maxSegmentSeconds: number,
): AssembledSubtitleSegment[] {
  const duration = segment.end - segment.start;
  if (duration <= maxSegmentSeconds) return [segment];

  const partCount = Math.max(1, Math.ceil(duration / maxSegmentSeconds));
  const textParts = splitTextIntoParts(segment.text, partCount);
  if (textParts.length <= 1) return [segment];

  const partDuration = duration / textParts.length;
  return textParts.map((text, index) => {
    const start = segment.start + partDuration * index;
    const end =
      index === textParts.length - 1
        ? segment.end
        : segment.start + partDuration * (index + 1);
    return {
      start,
      end: Math.max(start + 0.05, end),
      text,
      speaker: segment.speaker,
    };
  });
}

function splitTextIntoParts(text: string, partCount: number): string[] {
  const chars = Array.from(text.trim());
  if (chars.length === 0 || partCount <= 1)
    return [text.trim()].filter(Boolean);

  const parts: string[] = [];
  let start = 0;
  for (let partIndex = 1; partIndex < partCount; partIndex += 1) {
    const target = Math.round((chars.length * partIndex) / partCount);
    const boundary = findTextBoundary(chars, start, target);
    if (boundary <= start || boundary >= chars.length) continue;
    parts.push(chars.slice(start, boundary).join('').trim());
    start = boundary;
    while (start < chars.length && /\s/.test(chars[start])) start += 1;
  }
  parts.push(chars.slice(start).join('').trim());
  return parts.filter(Boolean);
}

function findTextBoundary(
  chars: string[],
  start: number,
  target: number,
): number {
  const boundedTarget = Math.max(start + 1, Math.min(chars.length - 1, target));
  const window = Math.max(6, Math.round(chars.length * 0.08));
  const min = Math.max(start + 1, boundedTarget - window);
  const max = Math.min(chars.length - 1, boundedTarget + window);
  const punctuation = /[。！？!?；;，,、\s]/;

  for (let distance = 0; distance <= window; distance += 1) {
    const right = boundedTarget + distance;
    if (right <= max && punctuation.test(chars[right])) return right + 1;
    const left = boundedTarget - distance;
    if (left >= min && punctuation.test(chars[left])) return left + 1;
  }
  return boundedTarget;
}

export interface LlmAlignerChunkSummary {
  chunkCount: number;
  interpolatedCount: number;
  transcribeFailedCount: number;
  totalUtteranceCount: number;
  totalWordCount: number;
  missingTimingUtteranceCount: number;
  collapsedTimingUtteranceCount: number;
  localInterpolatedUtteranceCount: number;
  avgMatchedCharRatio: number | null;
  avgProb: number | null;
  totalTranscribeDurationMs: number | undefined;
  totalAlignerDurationMs: number | undefined;
  avgTranscribeDurationMs: number | undefined;
  avgAlignerDurationMs: number | undefined;
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
  const transcribeDurations = chunks
    .map((chunk) => chunk.transcribeDurationMs)
    .filter((value): value is number => typeof value === 'number');
  const alignerDurations = chunks
    .map((chunk) => chunk.alignerDurationMs)
    .filter((value): value is number => typeof value === 'number');
  const totalTranscribeDurationMs =
    transcribeDurations.length === 0
      ? undefined
      : transcribeDurations.reduce((sum, value) => sum + value, 0);
  const totalAlignerDurationMs =
    alignerDurations.length === 0
      ? undefined
      : alignerDurations.reduce((sum, value) => sum + value, 0);
  const totalUtteranceCount = chunks.reduce(
    (sum, chunk) => sum + chunk.utterances.length,
    0,
  );
  const missingTimingUtteranceCount = chunks.reduce(
    (sum, chunk) => sum + (chunk.missingTimingUtteranceCount || 0),
    0,
  );
  const collapsedTimingUtteranceCount = chunks.reduce(
    (sum, chunk) => sum + (chunk.collapsedTimingUtteranceCount || 0),
    0,
  );
  const localInterpolatedUtteranceCount = chunks.reduce(
    (sum, chunk) => sum + (chunk.localInterpolatedUtteranceCount || 0),
    0,
  );
  const matchedRatios = chunks
    .map((chunk) => chunk.matchedCharRatio)
    .filter((value): value is number => typeof value === 'number');
  const avgMatchedCharRatio =
    matchedRatios.length === 0
      ? null
      : matchedRatios.reduce((sum, value) => sum + value, 0) /
        matchedRatios.length;
  const allInterpolated =
    chunks.length > 0 && interpolated.length === chunks.length;

  return {
    chunkCount: chunks.length,
    interpolatedCount: interpolated.length,
    transcribeFailedCount: transcribeFailed.length,
    totalUtteranceCount,
    totalWordCount,
    missingTimingUtteranceCount,
    collapsedTimingUtteranceCount,
    localInterpolatedUtteranceCount,
    avgMatchedCharRatio,
    avgProb,
    totalTranscribeDurationMs,
    totalAlignerDurationMs,
    avgTranscribeDurationMs:
      totalTranscribeDurationMs === undefined
        ? undefined
        : totalTranscribeDurationMs / transcribeDurations.length,
    avgAlignerDurationMs:
      totalAlignerDurationMs === undefined
        ? undefined
        : totalAlignerDurationMs / alignerDurations.length,
    totalTokens: options.totalTokens,
    firstChunkTtft: options.firstChunkTtft,
    allInterpolated,
  };
}
