import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AiSummaryModelConfig } from '@/types';
import { getAiSummarySettings } from '@/lib/ai-summary-settings';
import { sliceAudioByRange } from '@/lib/audio-slicer';
import { runForcedAligner } from '@/lib/forced-aligner-runtime';
import { getTranscriber } from '@/lib/subtitle-providers';
import type { TranscribePriority } from '@/lib/subtitle-providers';
import {
  alignChunk,
  assembleSegments,
  buildTranscribeFailedChunk,
  summarizeChunkResults,
  transcribeChunk,
  type AlignedChunkResult,
  type LlmAlignVideoContext,
  type TranscribedUtterance,
} from '@/lib/subtitle-llm-align-correction';
import {
  DEFAULT_FORCED_ALIGNER_MODEL_ID,
  DEFAULT_LLM_ALIGNER_CHUNK_SECONDS,
  type SubtitleLlmAlignerAlignerConfig,
  type SubtitleLlmAlignerLlmConfig,
} from '@/lib/subtitle-llm-aligner-settings';

const execFileAsync = promisify(execFile);

const DEFAULT_OUTPUT_ROOT = path.resolve(process.cwd(), 'eval', 'runs');
const FFMPEG_CANDIDATES = [
  process.env.FFMPEG_BIN,
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  'ffmpeg',
].filter((value): value is string => Boolean(value && value.trim()));
const FFPROBE_CANDIDATES = [
  process.env.FFPROBE_BIN,
  '/opt/homebrew/bin/ffprobe',
  '/usr/local/bin/ffprobe',
  'ffprobe',
].filter((value): value is string => Boolean(value && value.trim()));

export interface LlmAlignerEvalExperiment {
  id: string;
  audioPath: string;
  outputDir?: string;
  goldenJsonPath?: string;
  goldenSubtitlePath?: string;
  platform?: string;
  videoId?: string;
  title?: string;
  channelName?: string;
  description?: string;
  modelId?: string;
  providerModel?: string;
  model?: AiSummaryModelConfig;
  chunkSeconds?: number;
  chunkConcurrency?: number;
  priority?: TranscribePriority;
  aligner?: Partial<SubtitleLlmAlignerAlignerConfig>;
  llm?: Partial<SubtitleLlmAlignerLlmConfig>;
  keepAudioChunks?: boolean;
}

export interface LlmAlignerEvalDefaults extends Omit<
  LlmAlignerEvalExperiment,
  'id' | 'audioPath' | 'outputDir'
> {
  outputRoot?: string;
}

export interface LlmAlignerEvalRunOptions {
  outputRoot?: string;
  chunkConcurrency?: number;
  signal?: AbortSignal;
}

export interface LlmAlignerEvalChunkRecord {
  index: number;
  offsetSec: number;
  endSec: number;
  durationSec: number;
  audioPath: string;
  transcriptPath: string | null;
  alignerOutputDir: string | null;
  utteranceCount: number;
  segmentCount: number;
  transcribeFailed: boolean;
  alignFallback: AlignedChunkResult['alignFallback'];
  avgProb: number | null;
  wordCount: number;
  missingTimingUtteranceCount?: number;
  collapsedTimingUtteranceCount?: number;
  localInterpolatedUtteranceCount?: number;
  matchedCharRatio?: number;
  totalTokens?: number;
  ttftSeconds?: number;
  error?: string;
}

export interface LlmAlignerEvalResult {
  id: string;
  outputDir: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  audioPath: string;
  normalizedAudioPath: string;
  model: Pick<AiSummaryModelConfig, 'id' | 'name' | 'model' | 'protocol'>;
  config: {
    chunkSeconds: number;
    chunkConcurrency: number;
    aligner: SubtitleLlmAlignerAlignerConfig;
    llm: SubtitleLlmAlignerLlmConfig;
  };
  summary: ReturnType<typeof summarizeChunkResults> & {
    segmentCount: number;
    fallbackRatio: number;
  };
  quality?: LlmAlignerQualityMetrics;
  chunks: LlmAlignerEvalChunkRecord[];
  files: {
    subtitleJson: string;
    subtitleText: string;
    metrics: string;
  };
}

export interface LlmAlignerQualityMetrics {
  goldenPath: string;
  pairingMethod: 'lcs-anchor';
  text: {
    normalizedCharErrorRate: number;
    editDistance: number;
    coverage: number;
    referenceCharCount: number;
    hypothesisCharCount: number;
  };
  segments: {
    referenceCount: number;
    hypothesisCount: number;
    countRatio: number;
  };
  timing: {
    pairCount: number;
    startMaeSeconds: number | null;
    startP95Seconds: number | null;
    endMaeSeconds: number | null;
    endP95Seconds: number | null;
  };
  textPositionTiming: {
    pairCount: number;
    startMaeSeconds: number | null;
    startP95Seconds: number | null;
    endMaeSeconds: number | null;
    endP95Seconds: number | null;
  };
  fallbackRatio: number;
}

interface ChunkRange {
  index: number;
  offsetSec: number;
  endSec: number;
}

interface SubtitleSegmentLike {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

interface ChunkWorkResult {
  result: AlignedChunkResult;
  record: LlmAlignerEvalChunkRecord;
  totalTokens?: number;
  ttftSeconds?: number;
}

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function normalizeRatio(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(1, Math.max(0, numeric));
}

function sanitizeFileName(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'experiment'
  );
}

function pickExistingBinary(candidates: string[], label: string): string {
  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    return candidate;
  }
  throw new Error(`${label} binary not found`);
}

async function probeAudioDurationSeconds(
  audioPath: string,
  signal?: AbortSignal,
): Promise<number> {
  const result = await execFileAsync(
    pickExistingBinary(FFPROBE_CANDIDATES, 'ffprobe'),
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      audioPath,
    ],
    {
      signal,
      maxBuffer: 512 * 1024,
    } as Parameters<typeof execFileAsync>[2],
  );
  const duration = Number(String(result.stdout).trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`could not determine audio duration for ${audioPath}`);
  }
  return duration;
}

async function normalizeAudioToMp3(inputPath: string, outputDir: string) {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.mp3') return path.resolve(inputPath);

  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'source.mp3');
  await execFileAsync(
    pickExistingBinary(FFMPEG_CANDIDATES, 'ffmpeg'),
    [
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '96k',
      outputPath,
    ],
    {
      maxBuffer: 1024 * 1024,
    } as Parameters<typeof execFileAsync>[2],
  );
  return outputPath;
}

function buildChunkRanges(totalDurationSeconds: number, chunkSeconds: number) {
  const ranges: ChunkRange[] = [];
  const safeChunkSeconds = Math.max(60, chunkSeconds);
  for (
    let offsetSec = 0, index = 0;
    offsetSec < totalDurationSeconds;
    offsetSec += safeChunkSeconds, index += 1
  ) {
    ranges.push({
      index,
      offsetSec,
      endSec: Math.min(totalDurationSeconds, offsetSec + safeChunkSeconds),
    });
  }
  return ranges;
}

async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = clampInteger(concurrency, 1, 1, 64);
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex]!, currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runNext()),
  );
  return results;
}

function applyProviderModelOverride(
  model: AiSummaryModelConfig,
  providerModel: string | undefined,
): AiSummaryModelConfig {
  const override = providerModel?.trim();
  return override ? { ...model, model: override } : model;
}

function resolveModel(
  experiment: Pick<
    LlmAlignerEvalExperiment,
    'model' | 'modelId' | 'providerModel'
  >,
): AiSummaryModelConfig {
  if (experiment.model) {
    return applyProviderModelOverride(experiment.model, experiment.providerModel);
  }

  const settings = getAiSummarySettings();
  const models = settings.models.filter(
    (model) => model.isMultimodal !== false,
  );
  if (models.length === 0) {
    throw new Error('no multimodal AI model is configured');
  }

  if (experiment.modelId) {
    const requested = models.find((model) => model.id === experiment.modelId);
    if (!requested) {
      throw new Error(`multimodal model not found: ${experiment.modelId}`);
    }
    return applyProviderModelOverride(requested, experiment.providerModel);
  }

  return applyProviderModelOverride(
    models.find((model) => model.id === settings.defaultModelId) || models[0]!,
    experiment.providerModel,
  );
}

function normalizeAlignerConfig(
  input: Partial<SubtitleLlmAlignerAlignerConfig> | undefined,
): SubtitleLlmAlignerAlignerConfig {
  return {
    modelId:
      typeof input?.modelId === 'string' && input.modelId.trim()
        ? input.modelId.trim()
        : DEFAULT_FORCED_ALIGNER_MODEL_ID,
    minAvgProb: normalizeRatio(input?.minAvgProb, 0.3),
    minWordRatio: normalizeRatio(input?.minWordRatio, 0.3),
  };
}

function normalizeLlmConfig(
  input: Partial<SubtitleLlmAlignerLlmConfig> | undefined,
): SubtitleLlmAlignerLlmConfig {
  return {
    expectSpeakerLabels:
      input?.expectSpeakerLabels === undefined
        ? true
        : Boolean(input.expectSpeakerLabels),
    maxSegmentSeconds: clampInteger(input?.maxSegmentSeconds, 3, 3, 60),
  };
}

function buildSubtitleText(
  segments: Array<{
    start: number;
    end: number;
    speaker?: string;
    text: string;
  }>,
) {
  return segments
    .map((segment) => {
      const speaker = segment.speaker ? `[${segment.speaker}] ` : '';
      return `[${formatSeconds(segment.start)}-${formatSeconds(segment.end)}] ${speaker}${segment.text}`;
    })
    .join('\n\n');
}

function normalizeQualityText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function charEditDistance(reference: string, hypothesis: string): number {
  const source = Array.from(reference);
  const target = Array.from(hypothesis);
  if (source.length === 0) return target.length;
  if (target.length === 0) return source.length;

  let previous = new Uint32Array(target.length + 1);
  let current = new Uint32Array(target.length + 1);
  for (let index = 0; index <= target.length; index += 1) {
    previous[index] = index;
  }

  for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex += 1) {
    current[0] = sourceIndex;
    const sourceChar = source[sourceIndex - 1];
    for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
      const substitutionCost = sourceChar === target[targetIndex - 1] ? 0 : 1;
      current[targetIndex] = Math.min(
        previous[targetIndex]! + 1,
        current[targetIndex - 1]! + 1,
        previous[targetIndex - 1]! + substitutionCost,
      );
    }
    const nextPrevious = previous;
    previous = current;
    current = nextPrevious;
  }

  return previous[target.length]!;
}

function lcsTextCoverage(reference: string, hypothesis: string): number {
  const source = Array.from(reference);
  if (source.length === 0) return hypothesis.length === 0 ? 1 : 0;

  const target = Array.from(hypothesis);
  if (target.length === 0) return 0;

  let previous = new Uint32Array(target.length + 1);
  let current = new Uint32Array(target.length + 1);
  for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex += 1) {
    const sourceChar = source[sourceIndex - 1];
    for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
      current[targetIndex] =
        sourceChar === target[targetIndex - 1]
          ? previous[targetIndex - 1]! + 1
          : Math.max(previous[targetIndex]!, current[targetIndex - 1]!);
    }
    const nextPrevious = previous;
    previous = current;
    current = nextPrevious;
    current.fill(0);
  }
  return Number((previous[target.length]! / source.length).toFixed(4));
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Number(
    (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3),
  );
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return Number(sorted[index]!.toFixed(3));
}

function toSubtitleSegment(value: unknown): SubtitleSegmentLike | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const start = Number(entry.start);
  const end = Number(entry.end);
  const text = typeof entry.text === 'string' ? entry.text : '';
  if (!Number.isFinite(start) || !Number.isFinite(end) || !text.trim()) {
    return null;
  }
  const speaker = typeof entry.speaker === 'string' ? entry.speaker : undefined;
  return { start, end, text, ...(speaker ? { speaker } : {}) };
}

function extractSubtitleSegments(payload: unknown): SubtitleSegmentLike[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const candidates = [
    record.segments,
    (record.reference as Record<string, unknown> | undefined)?.segments,
    (record.subtitle as Record<string, unknown> | undefined)?.segments,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const segments = candidate
      .map((segment) => toSubtitleSegment(segment))
      .filter((segment): segment is SubtitleSegmentLike => Boolean(segment));
    if (segments.length > 0) return segments;
  }
  return [];
}

function extractSubtitleText(
  payload: unknown,
  segments: SubtitleSegmentLike[],
): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const reference = record.reference as Record<string, unknown> | undefined;
    const subtitle = record.subtitle as Record<string, unknown> | undefined;
    for (const value of [record.text, reference?.text, subtitle?.text]) {
      if (typeof value === 'string' && value.trim()) return value;
    }
  }
  return segments.map((segment) => segment.text).join('\n');
}

interface TextTimelineSpan {
  textStart: number;
  textEnd: number;
  timeStart: number;
  timeEnd: number;
}

interface TextTimeline {
  spans: TextTimelineSpan[];
  totalChars: number;
}

interface TextCharPoint {
  char: string;
  time: number;
}

interface TimingErrorCollection {
  pairCount: number;
  startErrors: number[];
  endErrors: number[];
}

function buildTextTimeline(segments: SubtitleSegmentLike[]): TextTimeline {
  const spans: TextTimelineSpan[] = [];
  let cursor = 0;
  for (const segment of segments) {
    const charCount = Array.from(normalizeQualityText(segment.text)).length;
    if (charCount <= 0) continue;
    const textStart = cursor;
    const textEnd = cursor + charCount;
    spans.push({
      textStart,
      textEnd,
      timeStart: segment.start,
      timeEnd: segment.end,
    });
    cursor = textEnd;
  }
  return { spans, totalChars: cursor };
}

function buildTextCharTimeline(
  segments: SubtitleSegmentLike[],
): TextCharPoint[] {
  const points: TextCharPoint[] = [];
  for (const segment of segments) {
    const chars = Array.from(normalizeQualityText(segment.text));
    if (chars.length === 0) continue;
    const denominator = Math.max(1, chars.length - 1);
    chars.forEach((char, index) => {
      const ratio = chars.length === 1 ? 0 : index / denominator;
      points.push({
        char,
        time: segment.start + (segment.end - segment.start) * ratio,
      });
    });
  }
  return points;
}

function mapTextPositionToTime(
  timeline: TextTimeline,
  position: number,
): number | null {
  if (timeline.totalChars <= 0 || timeline.spans.length === 0) return null;
  const safePosition = Math.min(
    timeline.totalChars,
    Math.max(0, Number.isFinite(position) ? position : 0),
  );

  for (const span of timeline.spans) {
    if (safePosition > span.textEnd) continue;
    const spanChars = Math.max(1, span.textEnd - span.textStart);
    const ratio = Math.min(
      1,
      Math.max(0, (safePosition - span.textStart) / spanChars),
    );
    return span.timeStart + (span.timeEnd - span.timeStart) * ratio;
  }

  const last = timeline.spans.at(-1);
  return last ? last.timeEnd : null;
}

function collectTextPositionTimingErrors(input: {
  referenceSegments: SubtitleSegmentLike[];
  hypothesisSegments: SubtitleSegmentLike[];
}): TimingErrorCollection {
  const referenceTimeline = buildTextTimeline(input.referenceSegments);
  const hypothesisTimeline = buildTextTimeline(input.hypothesisSegments);
  const startErrors: number[] = [];
  const endErrors: number[] = [];

  if (referenceTimeline.totalChars <= 0 || hypothesisTimeline.totalChars <= 0) {
    return { pairCount: 0, startErrors, endErrors };
  }

  let hypothesisCursor = 0;
  for (const segment of input.hypothesisSegments) {
    const charCount = Array.from(normalizeQualityText(segment.text)).length;
    if (charCount <= 0) continue;

    const textStart = hypothesisCursor;
    const textEnd = hypothesisCursor + charCount;
    hypothesisCursor = textEnd;

    const referenceStartPosition =
      (textStart / hypothesisTimeline.totalChars) *
      referenceTimeline.totalChars;
    const referenceEndPosition =
      (textEnd / hypothesisTimeline.totalChars) * referenceTimeline.totalChars;
    const referenceStart = mapTextPositionToTime(
      referenceTimeline,
      referenceStartPosition,
    );
    const referenceEnd = mapTextPositionToTime(
      referenceTimeline,
      referenceEndPosition,
    );
    if (referenceStart === null || referenceEnd === null) continue;

    startErrors.push(Math.abs(segment.start - referenceStart));
    endErrors.push(Math.abs(segment.end - referenceEnd));
  }

  return {
    pairCount: startErrors.length,
    startErrors,
    endErrors,
  };
}

function collectLcsAnchorTimingErrors(input: {
  referenceSegments: SubtitleSegmentLike[];
  hypothesisSegments: SubtitleSegmentLike[];
}): TimingErrorCollection {
  const referenceTimeline = buildTextCharTimeline(input.referenceSegments);
  const hypothesisTimeline = buildTextCharTimeline(input.hypothesisSegments);
  const anchorPairs = collectLcsAnchorPairs(referenceTimeline, hypothesisTimeline);
  const referenceTimeByHypothesisIndex = new Map<number, number>();
  for (const [referenceIndex, hypothesisIndex] of anchorPairs) {
    const reference = referenceTimeline[referenceIndex];
    if (reference) referenceTimeByHypothesisIndex.set(hypothesisIndex, reference.time);
  }

  const startErrors: number[] = [];
  const endErrors: number[] = [];
  let hypothesisCursor = 0;
  for (const segment of input.hypothesisSegments) {
    const charCount = Array.from(normalizeQualityText(segment.text)).length;
    if (charCount <= 0) continue;

    const startAnchor = findNearestAnchor(
      referenceTimeByHypothesisIndex,
      hypothesisCursor,
      1,
      Math.min(8, charCount),
    );
    const endAnchor = findNearestAnchor(
      referenceTimeByHypothesisIndex,
      hypothesisCursor + charCount - 1,
      -1,
      Math.min(8, charCount),
    );
    if (typeof startAnchor === 'number') {
      startErrors.push(Math.abs(segment.start - startAnchor));
    }
    if (typeof endAnchor === 'number') {
      endErrors.push(Math.abs(segment.end - endAnchor));
    }
    hypothesisCursor += charCount;
  }

  return {
    pairCount: Math.max(startErrors.length, endErrors.length),
    startErrors,
    endErrors,
  };
}

function findNearestAnchor(
  anchors: Map<number, number>,
  startIndex: number,
  direction: 1 | -1,
  maxDistance: number,
): number | null {
  for (let distance = 0; distance < maxDistance; distance += 1) {
    const value = anchors.get(startIndex + distance * direction);
    if (typeof value === 'number') return value;
  }
  return null;
}

function collectLcsAnchorPairs(
  reference: TextCharPoint[],
  hypothesis: TextCharPoint[],
): Array<[number, number]> {
  const rowCount = reference.length + 1;
  const columnCount = hypothesis.length + 1;
  if (rowCount <= 1 || columnCount <= 1) return [];
  if (Math.max(reference.length, hypothesis.length) > 65535) {
    throw new Error('lcs-anchor timing supports at most 65535 normalized chars');
  }

  const table = new Uint16Array(rowCount * columnCount);
  for (let referenceIndex = 1; referenceIndex < rowCount; referenceIndex += 1) {
    const referenceChar = reference[referenceIndex - 1]?.char;
    const rowOffset = referenceIndex * columnCount;
    const previousRowOffset = (referenceIndex - 1) * columnCount;
    for (
      let hypothesisIndex = 1;
      hypothesisIndex < columnCount;
      hypothesisIndex += 1
    ) {
      const tableIndex = rowOffset + hypothesisIndex;
      table[tableIndex] =
        referenceChar === hypothesis[hypothesisIndex - 1]?.char
          ? table[previousRowOffset + hypothesisIndex - 1]! + 1
          : Math.max(
              table[previousRowOffset + hypothesisIndex]!,
              table[rowOffset + hypothesisIndex - 1]!,
            );
    }
  }

  const pairs: Array<[number, number]> = [];
  let referenceIndex = reference.length;
  let hypothesisIndex = hypothesis.length;
  while (referenceIndex > 0 && hypothesisIndex > 0) {
    if (
      reference[referenceIndex - 1]?.char ===
      hypothesis[hypothesisIndex - 1]?.char
    ) {
      pairs.push([referenceIndex - 1, hypothesisIndex - 1]);
      referenceIndex -= 1;
      hypothesisIndex -= 1;
      continue;
    }

    if (
      table[(referenceIndex - 1) * columnCount + hypothesisIndex]! >=
      table[referenceIndex * columnCount + hypothesisIndex - 1]!
    ) {
      referenceIndex -= 1;
    } else {
      hypothesisIndex -= 1;
    }
  }
  return pairs.reverse();
}

function readGoldenSubtitle(input: {
  goldenJsonPath?: string;
  goldenSubtitlePath?: string;
}): {
  goldenPath: string;
  segments: SubtitleSegmentLike[];
  text: string;
} | null {
  const goldenPath = input.goldenJsonPath || input.goldenSubtitlePath;
  if (!goldenPath) return null;
  const resolvedPath = path.resolve(goldenPath);
  const payload = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as unknown;
  const segments = extractSubtitleSegments(payload);
  const text = extractSubtitleText(payload, segments);
  return { goldenPath: resolvedPath, segments, text };
}

export function scoreLlmAlignerQuality(input: {
  golden: {
    goldenPath: string;
    segments: SubtitleSegmentLike[];
    text: string;
  };
  hypothesisSegments: SubtitleSegmentLike[];
  hypothesisText?: string;
  fallbackRatio: number;
}): LlmAlignerQualityMetrics {
  const referenceText = normalizeQualityText(input.golden.text);
  const hypothesisText = normalizeQualityText(
    input.hypothesisText ||
      input.hypothesisSegments.map((segment) => segment.text).join('\n'),
  );
  const editDistance = charEditDistance(referenceText, hypothesisText);
  const referenceCharCount = Array.from(referenceText).length;
  const hypothesisCharCount = Array.from(hypothesisText).length;
  const timingErrors = collectLcsAnchorTimingErrors({
    referenceSegments: input.golden.segments,
    hypothesisSegments: input.hypothesisSegments,
  });
  const textPositionTimingErrors = collectTextPositionTimingErrors({
    referenceSegments: input.golden.segments,
    hypothesisSegments: input.hypothesisSegments,
  });

  return {
    goldenPath: input.golden.goldenPath,
    pairingMethod: 'lcs-anchor',
    text: {
      normalizedCharErrorRate:
        referenceCharCount > 0
          ? Number((editDistance / referenceCharCount).toFixed(4))
          : hypothesisCharCount === 0
            ? 0
            : 1,
      editDistance,
      coverage: lcsTextCoverage(referenceText, hypothesisText),
      referenceCharCount,
      hypothesisCharCount,
    },
    segments: {
      referenceCount: input.golden.segments.length,
      hypothesisCount: input.hypothesisSegments.length,
      countRatio:
        input.golden.segments.length > 0
          ? Number(
              (
                input.hypothesisSegments.length / input.golden.segments.length
              ).toFixed(4),
            )
          : input.hypothesisSegments.length === 0
            ? 1
            : 0,
    },
    timing: {
      pairCount: timingErrors.pairCount,
      startMaeSeconds: average(timingErrors.startErrors),
      startP95Seconds: percentile(timingErrors.startErrors, 95),
      endMaeSeconds: average(timingErrors.endErrors),
      endP95Seconds: percentile(timingErrors.endErrors, 95),
    },
    textPositionTiming: {
      pairCount: textPositionTimingErrors.pairCount,
      startMaeSeconds: average(textPositionTimingErrors.startErrors),
      startP95Seconds: percentile(textPositionTimingErrors.startErrors, 95),
      endMaeSeconds: average(textPositionTimingErrors.endErrors),
      endP95Seconds: percentile(textPositionTimingErrors.endErrors, 95),
    },
    fallbackRatio: input.fallbackRatio,
  };
}

function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function mergeExperimentDefaults(
  defaults: LlmAlignerEvalDefaults | undefined,
  experiment: LlmAlignerEvalExperiment,
): LlmAlignerEvalExperiment {
  return {
    ...defaults,
    ...experiment,
    aligner: { ...defaults?.aligner, ...experiment.aligner },
    llm: { ...defaults?.llm, ...experiment.llm },
  };
}

async function runChunk(input: {
  range: ChunkRange;
  normalizedAudioPath: string;
  chunkDir: string;
  outputDir: string;
  video: LlmAlignVideoContext;
  model: AiSummaryModelConfig;
  transcriber: ReturnType<typeof getTranscriber>;
  alignerConfig: SubtitleLlmAlignerAlignerConfig;
  llmConfig: SubtitleLlmAlignerLlmConfig;
  priority: TranscribePriority;
  chunkSeconds: number;
  signal?: AbortSignal;
}): Promise<ChunkWorkResult> {
  const { range } = input;
  const durationSec = Math.max(0.1, range.endSec - range.offsetSec);
  const chunkAudioPath = await sliceAudioByRange(
    input.normalizedAudioPath,
    input.chunkDir,
    {
      index: range.index,
      offsetSec: range.offsetSec,
      endSec: range.endSec,
    },
    { paddingSeconds: 0, signal: input.signal },
  );

  let utterances: TranscribedUtterance[] = [];
  let totalTokens: number | undefined;
  let ttftSeconds: number | undefined;

  try {
    const transcribed = await transcribeChunk({
      chunk: {
        chunkIndex: range.index,
        chunkOffsetSec: range.offsetSec,
        chunkEndSec: range.endSec,
        audioPath: chunkAudioPath,
      },
      video: input.video,
      model: input.model,
      transcriber: input.transcriber,
      llmConfig: input.llmConfig,
      priority: input.priority,
      chunkSeconds: input.chunkSeconds,
      signal: input.signal,
    });
    utterances = transcribed.utterances;
    totalTokens = transcribed.totalTokens;
    ttftSeconds = transcribed.ttftSeconds;
  } catch (error) {
    const result = buildTranscribeFailedChunk({
      chunkIndex: range.index,
      chunkOffsetSec: range.offsetSec,
      durationSec,
      maxSegmentSeconds: input.llmConfig.maxSegmentSeconds,
    });
    const record: LlmAlignerEvalChunkRecord = {
      index: range.index,
      offsetSec: range.offsetSec,
      endSec: range.endSec,
      durationSec,
      audioPath: chunkAudioPath,
      transcriptPath: null,
      alignerOutputDir: null,
      utteranceCount: 0,
      segmentCount: result.utterances.length,
      transcribeFailed: true,
      alignFallback: result.alignFallback,
      avgProb: result.avgProb,
      wordCount: result.wordCount,
      error: error instanceof Error ? error.message : String(error),
    };
    return { result, record };
  }

  const transcribePath = path.join(
    input.outputDir,
    'transcripts',
    `chunk-${String(range.index).padStart(3, '0')}.json`,
  );
  writeJson(transcribePath, {
    index: range.index,
    offsetSec: range.offsetSec,
    endSec: range.endSec,
    utterances,
    totalTokens,
    ttftSeconds,
  });

  const alignerOutputDir = path.join(
    input.outputDir,
    'aligner',
    `chunk-${String(range.index).padStart(3, '0')}`,
  );
  const transcriptTextPath = path.join(alignerOutputDir, 'transcript.txt');
  const result = await alignChunk({
    chunk: {
      chunkIndex: range.index,
      chunkOffsetSec: range.offsetSec,
      chunkEndSec: range.endSec,
      audioPath: chunkAudioPath,
      durationSec,
    },
    utterances,
    alignerConfig: input.alignerConfig,
    llmConfig: input.llmConfig,
    transcriptWritePath: transcriptTextPath,
    alignerOutputDir,
    signal: input.signal,
    runAligner: runForcedAligner,
  });

  const record: LlmAlignerEvalChunkRecord = {
    index: range.index,
    offsetSec: range.offsetSec,
    endSec: range.endSec,
    durationSec,
    audioPath: chunkAudioPath,
    transcriptPath: transcriptTextPath,
    alignerOutputDir,
    utteranceCount: utterances.length,
    segmentCount: result.utterances.length,
    transcribeFailed: result.transcribeFailed,
    alignFallback: result.alignFallback,
    avgProb: result.avgProb,
    wordCount: result.wordCount,
    missingTimingUtteranceCount: result.missingTimingUtteranceCount,
    collapsedTimingUtteranceCount: result.collapsedTimingUtteranceCount,
    localInterpolatedUtteranceCount: result.localInterpolatedUtteranceCount,
    matchedCharRatio: result.matchedCharRatio,
    totalTokens,
    ttftSeconds,
  };
  return { result, record, totalTokens, ttftSeconds };
}

export async function runLlmAlignerExperiment(
  experiment: LlmAlignerEvalExperiment,
  options: LlmAlignerEvalRunOptions = {},
): Promise<LlmAlignerEvalResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const id = sanitizeFileName(experiment.id);
  const outputRoot = options.outputRoot || DEFAULT_OUTPUT_ROOT;
  const outputDir = path.resolve(
    experiment.outputDir ||
      path.join(
        outputRoot,
        `${new Date().toISOString().replace(/[:.]/g, '-')}-${id}`,
      ),
  );
  const chunkDir = path.join(outputDir, 'chunks');
  fs.mkdirSync(chunkDir, { recursive: true });

  const model = resolveModel(experiment);
  if (model.isMultimodal === false) {
    throw new Error(`model is not multimodal: ${model.id}`);
  }
  const transcriber = getTranscriber(model);

  const normalizedAudioPath = await normalizeAudioToMp3(
    path.resolve(experiment.audioPath),
    outputDir,
  );
  const durationSeconds = await probeAudioDurationSeconds(
    normalizedAudioPath,
    options.signal,
  );
  const chunkSeconds = clampInteger(
    Math.min(
      Number(experiment.chunkSeconds) || DEFAULT_LLM_ALIGNER_CHUNK_SECONDS,
      transcriber.maxAudioChunkSeconds,
    ),
    DEFAULT_LLM_ALIGNER_CHUNK_SECONDS,
    60,
    60 * 60,
  );
  const chunkConcurrency = clampInteger(
    experiment.chunkConcurrency ?? options.chunkConcurrency,
    1,
    1,
    16,
  );
  const alignerConfig = normalizeAlignerConfig(experiment.aligner);
  const llmConfig = normalizeLlmConfig(experiment.llm);
  const video: LlmAlignVideoContext = {
    platform: experiment.platform || 'eval',
    video_id: experiment.videoId || id,
    title: experiment.title || id,
    channel_name: experiment.channelName || null,
    description: experiment.description || null,
  };
  const ranges = buildChunkRanges(durationSeconds, chunkSeconds);
  writeJson(path.join(outputDir, 'input.json'), {
    ...experiment,
    model: { ...model, apiKey: model.apiKey ? '[redacted]' : '' },
    normalizedAudioPath,
    durationSeconds,
    chunkCount: ranges.length,
  });

  const chunkWork = await mapLimit(ranges, chunkConcurrency, (range) =>
    runChunk({
      range,
      normalizedAudioPath,
      chunkDir,
      outputDir,
      video,
      model,
      transcriber,
      alignerConfig,
      llmConfig,
      priority: experiment.priority || 'manual-subtitle',
      chunkSeconds,
      signal: options.signal,
    }),
  );

  const chunkResults = chunkWork.map((entry) => entry.result);
  const segments = assembleSegments(chunkResults, {
    maxSegmentSeconds: llmConfig.maxSegmentSeconds,
  }).map((segment) => ({
    start: Math.max(0, Number(segment.start.toFixed(3))),
    end: Math.max(
      Number(segment.end.toFixed(3)),
      Number((segment.start + 0.05).toFixed(3)),
    ),
    text: segment.text,
    ...(segment.speaker ? { speaker: segment.speaker } : {}),
  }));
  const totalTokens = chunkWork.reduce(
    (sum, entry) => sum + (entry.totalTokens || 0),
    0,
  );
  const firstChunkTtft = chunkWork[0]?.ttftSeconds;
  const summaryBase = summarizeChunkResults(chunkResults, {
    totalTokens: totalTokens > 0 ? totalTokens : undefined,
    firstChunkTtft,
  });
  const fallbackRatio =
    summaryBase.chunkCount > 0
      ? Number(
          (summaryBase.interpolatedCount / summaryBase.chunkCount).toFixed(4),
        )
      : 0;
  const summary = {
    ...summaryBase,
    segmentCount: segments.length,
    fallbackRatio,
  };
  const golden = readGoldenSubtitle({
    goldenJsonPath: experiment.goldenJsonPath,
    goldenSubtitlePath: experiment.goldenSubtitlePath,
  });

  const subtitleText = buildSubtitleText(segments);
  const quality = golden
    ? scoreLlmAlignerQuality({
        golden,
        hypothesisSegments: segments,
        fallbackRatio,
      })
    : undefined;
  const subtitleJsonPath = path.join(outputDir, 'subtitle.json');
  const subtitleTextPath = path.join(outputDir, 'subtitle.txt');
  const metricsPath = path.join(outputDir, 'metrics.json');
  writeJson(subtitleJsonPath, {
    status: 'completed',
    sourceMethod: 'llm-aligner-eval',
    language: 'unknown',
    segmentStyle: 'fine',
    text: subtitleText,
    segments,
    metadata: { ...summary, ...(quality ? { quality } : {}) },
  });
  fs.writeFileSync(subtitleTextPath, `${subtitleText}\n`, 'utf8');

  if (!experiment.keepAudioChunks) {
    await fs.promises.rm(chunkDir, { recursive: true, force: true });
  }

  const completedAt = new Date().toISOString();
  const result: LlmAlignerEvalResult = {
    id,
    outputDir,
    startedAt,
    completedAt,
    durationMs: Date.now() - startedMs,
    audioPath: path.resolve(experiment.audioPath),
    normalizedAudioPath,
    model: {
      id: model.id,
      name: model.name,
      model: model.model,
      protocol: model.protocol,
    },
    config: {
      chunkSeconds,
      chunkConcurrency,
      aligner: alignerConfig,
      llm: llmConfig,
    },
    summary,
    ...(quality ? { quality } : {}),
    chunks: chunkWork.map((entry) => entry.record),
    files: {
      subtitleJson: subtitleJsonPath,
      subtitleText: subtitleTextPath,
      metrics: metricsPath,
    },
  };
  writeJson(metricsPath, result);
  return result;
}

export async function runLlmAlignerManifest(input: {
  defaults?: LlmAlignerEvalDefaults;
  experiments: LlmAlignerEvalExperiment[];
  concurrency?: number;
  outputRoot?: string;
  chunkConcurrency?: number;
  signal?: AbortSignal;
}): Promise<
  Array<
    | { ok: true; result: LlmAlignerEvalResult }
    | { ok: false; id: string; error: string; outputDir?: string }
  >
> {
  const outputRoot =
    input.outputRoot || input.defaults?.outputRoot || DEFAULT_OUTPUT_ROOT;
  const experiments = input.experiments.map((experiment) =>
    mergeExperimentDefaults(input.defaults, experiment),
  );
  return mapLimit(
    experiments,
    clampInteger(input.concurrency, 1, 1, Math.max(1, os.cpus().length)),
    async (experiment) => {
      try {
        const result = await runLlmAlignerExperiment(experiment, {
          outputRoot,
          chunkConcurrency: input.chunkConcurrency,
          signal: input.signal,
        });
        return { ok: true as const, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const outputDir = experiment.outputDir
          ? path.resolve(experiment.outputDir)
          : undefined;
        if (outputDir) {
          writeJson(path.join(outputDir, 'error.json'), {
            id: experiment.id,
            error: message,
            failedAt: new Date().toISOString(),
          });
        }
        return {
          ok: false as const,
          id: experiment.id,
          error: message,
          outputDir,
        };
      }
    },
  );
}
