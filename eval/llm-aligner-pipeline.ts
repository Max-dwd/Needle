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
  id?: string;
  audioPath?: string;
  caseId?: string;
  caseDir?: string;
  caseManifestPath?: string;
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
  configSource?: string;
  configSnapshot?: unknown;
  qualityGate?: LlmAlignerQualityGate;
}

export interface LlmAlignerEvalDefaults extends Omit<
  LlmAlignerEvalExperiment,
  'id' | 'audioPath' | 'caseId' | 'caseDir' | 'outputDir'
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
  transcribeDurationMs?: number;
  alignerDurationMs?: number;
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
  case?: {
    id: string;
    dir: string;
    metadataPath?: string;
  };
  summary: ReturnType<typeof summarizeChunkResults> & {
    segmentCount: number;
    fallbackRatio: number;
  };
  quality?: LlmAlignerQualityMetrics;
  qualityGate?: LlmAlignerQualityGate;
  qualityGateResult?: LlmAlignerQualityGateResult;
  configSource?: string;
  configSnapshot?: unknown;
  phaseTiming: LlmAlignerEvalPhaseTiming;
  chunks: LlmAlignerEvalChunkRecord[];
  files: {
    run: string;
    subtitleJson: string;
    subtitleText: string;
    metrics: string;
    alignment?: string;
  };
}

export interface LlmAlignerEvalPhaseTiming {
  totalDurationMs: number;
  audioPrepareDurationMs: number;
  chunkWallDurationMs: number;
  transcribeDurationMs: number;
  alignerDurationMs: number;
}

export interface LlmAlignerAlignmentPair {
  index: number;
  status:
    | 'match'
    | 'text_mismatch'
    | 'timestamp_drift'
    | 'missing_generated'
    | 'extra_generated';
  golden: SubtitleSegmentLike | null;
  generated: SubtitleSegmentLike | null;
  textSimilarity: number | null;
  startDriftSeconds: number | null;
  endDriftSeconds: number | null;
  // True when the matched generated segment also covers other golden segments
  // (a coarse segment spanning several fine golden segments). The words are
  // present, just merged into one generated segment.
  merged?: boolean;
}

export interface LlmAlignerAlignmentArtifact {
  version: 1;
  generatedAt: string;
  case: {
    id: string | null;
    goldenPath: string;
  };
  generated: {
    subtitlePath: string;
  };
  thresholds: {
    minTextSimilarity: number;
    maxStartDriftSeconds: number;
    maxEndDriftSeconds: number;
  };
  summary: {
    pairCount: number;
    matchCount: number;
    textMismatchCount: number;
    timestampDriftCount: number;
    missingGeneratedCount: number;
    extraGeneratedCount: number;
    mergedCount: number;
  };
  pairs: LlmAlignerAlignmentPair[];
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

export interface LlmAlignerQualityGate {
  minCoverage?: number;
  maxNormalizedCharErrorRate?: number;
  maxStartMaeSeconds?: number;
  maxStartP95Seconds?: number;
  maxEndMaeSeconds?: number;
  maxEndP95Seconds?: number;
}

export interface LlmAlignerQualityGateCheck {
  name: string;
  operator: '>=' | '<=';
  expected: number;
  actual: number | null;
  passed: boolean;
}

export interface LlmAlignerQualityGateResult {
  passed: boolean;
  checks: LlmAlignerQualityGateCheck[];
  reason?: string;
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
    return applyProviderModelOverride(
      experiment.model,
      experiment.providerModel,
    );
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
    verbatimCoveragePrompt:
      input?.verbatimCoveragePrompt === undefined
        ? false
        : Boolean(input.verbatimCoveragePrompt),
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
  const anchorPairs = collectLcsAnchorPairs(
    referenceTimeline,
    hypothesisTimeline,
  );
  const referenceTimeByHypothesisIndex = new Map<number, number>();
  for (const [referenceIndex, hypothesisIndex] of anchorPairs) {
    const reference = referenceTimeline[referenceIndex];
    if (reference)
      referenceTimeByHypothesisIndex.set(hypothesisIndex, reference.time);
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
    throw new Error(
      'lcs-anchor timing supports at most 65535 normalized chars',
    );
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

export function readGoldenSubtitle(input: {
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

export function evaluateQualityGate(
  gate: LlmAlignerQualityGate,
  quality: LlmAlignerQualityMetrics | undefined,
): LlmAlignerQualityGateResult {
  if (!quality) {
    return {
      passed: false,
      checks: [],
      reason: 'quality metrics unavailable',
    };
  }

  const checks: LlmAlignerQualityGateCheck[] = [];
  const addMinCheck = (
    name: string,
    actual: number | null,
    expected?: number,
  ) => {
    if (expected === undefined) return;
    checks.push({
      name,
      operator: '>=',
      expected,
      actual,
      passed: actual !== null && actual >= expected,
    });
  };
  const addMaxCheck = (
    name: string,
    actual: number | null,
    expected?: number,
  ) => {
    if (expected === undefined) return;
    checks.push({
      name,
      operator: '<=',
      expected,
      actual,
      passed: actual !== null && actual <= expected,
    });
  };

  addMinCheck('text.coverage', quality.text.coverage, gate.minCoverage);
  addMaxCheck(
    'text.normalizedCharErrorRate',
    quality.text.normalizedCharErrorRate,
    gate.maxNormalizedCharErrorRate,
  );
  addMaxCheck(
    'timing.startMaeSeconds',
    quality.timing.startMaeSeconds,
    gate.maxStartMaeSeconds,
  );
  addMaxCheck(
    'timing.startP95Seconds',
    quality.timing.startP95Seconds,
    gate.maxStartP95Seconds,
  );
  addMaxCheck(
    'timing.endMaeSeconds',
    quality.timing.endMaeSeconds,
    gate.maxEndMaeSeconds,
  );
  addMaxCheck(
    'timing.endP95Seconds',
    quality.timing.endP95Seconds,
    gate.maxEndP95Seconds,
  );

  return {
    passed: checks.every((check) => check.passed),
    checks,
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

function resolveMaybeRelative(
  filePath: string,
  baseDir = process.cwd(),
): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
}

function findCaseAudioPath(caseDir: string): string | null {
  for (const extension of ['mp3', 'm4a', 'wav', 'aac', 'webm', 'mp4']) {
    const candidate = path.join(caseDir, `audio.${extension}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readJsonIfExists(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<
    string,
    unknown
  >;
}

function resolveEvalCaseInput(experiment: LlmAlignerEvalExperiment): {
  caseId?: string;
  caseDir?: string;
  metadataPath?: string;
  audioPath?: string;
  goldenJsonPath?: string;
  platform?: string;
  videoId?: string;
  title?: string;
  channelName?: string;
  description?: string;
} {
  let caseDir = experiment.caseDir
    ? resolveMaybeRelative(experiment.caseDir)
    : undefined;
  let caseId = experiment.caseId;

  if (!caseDir && caseId) {
    const manifestPath = resolveMaybeRelative(
      experiment.caseManifestPath || path.join('eval', 'data', 'manifest.json'),
    );
    const manifest = readJsonIfExists(manifestPath);
    const cases = Array.isArray(manifest?.cases) ? manifest.cases : [];
    const entry = cases.find(
      (candidate): candidate is Record<string, unknown> =>
        Boolean(
          candidate &&
          typeof candidate === 'object' &&
          (candidate as Record<string, unknown>).id === caseId,
        ),
    );
    const manifestDir = path.dirname(manifestPath);
    if (!entry) {
      const caseDirFallback = path.join(manifestDir, 'cases', caseId);
      if (
        fs.existsSync(path.join(caseDirFallback, 'metadata.json')) ||
        fs.existsSync(path.join(caseDirFallback, 'golden.json'))
      ) {
        caseDir = caseDirFallback;
      } else {
        throw new Error(`eval case not found: ${caseId}`);
      }
    }
    if (entry) {
      if (typeof entry.caseDir === 'string') {
        caseDir = resolveMaybeRelative(entry.caseDir);
      } else if (typeof entry.goldenJsonPath === 'string') {
        caseDir = path.dirname(resolveMaybeRelative(entry.goldenJsonPath));
      }
      if (!experiment.audioPath && typeof entry.audioPath === 'string') {
        experiment = { ...experiment, audioPath: entry.audioPath };
      }
      if (
        !experiment.goldenJsonPath &&
        typeof entry.goldenJsonPath === 'string'
      ) {
        experiment = { ...experiment, goldenJsonPath: entry.goldenJsonPath };
      }
      if (!caseDir && typeof entry.caseDir === 'string') {
        caseDir = resolveMaybeRelative(entry.caseDir, manifestDir);
      }
    }
  }

  if (!caseDir) {
    return {
      audioPath: experiment.audioPath,
      goldenJsonPath: experiment.goldenJsonPath,
      platform: experiment.platform,
      videoId: experiment.videoId,
      title: experiment.title,
      channelName: experiment.channelName,
      description: experiment.description,
    };
  }

  const metadataPath = path.join(caseDir, 'metadata.json');
  const metadata = readJsonIfExists(metadataPath);
  const video = metadata?.video as Record<string, unknown> | undefined;
  const audio = metadata?.audio as Record<string, unknown> | undefined;
  const golden = metadata?.golden as Record<string, unknown> | undefined;
  caseId =
    caseId || (typeof metadata?.id === 'string' ? metadata.id : undefined);

  const metadataAudioPath =
    typeof audio?.cachedAudioPath === 'string' && audio.cachedAudioPath
      ? resolveMaybeRelative(audio.cachedAudioPath)
      : undefined;
  const metadataGoldenPath =
    typeof golden?.jsonPath === 'string' && golden.jsonPath
      ? resolveMaybeRelative(golden.jsonPath)
      : undefined;

  return {
    caseId,
    caseDir,
    metadataPath: fs.existsSync(metadataPath) ? metadataPath : undefined,
    audioPath:
      experiment.audioPath ||
      metadataAudioPath ||
      findCaseAudioPath(caseDir) ||
      undefined,
    goldenJsonPath:
      experiment.goldenJsonPath ||
      metadataGoldenPath ||
      path.join(caseDir, 'golden.json'),
    platform:
      experiment.platform ||
      (typeof video?.platform === 'string' ? video.platform : undefined),
    videoId:
      experiment.videoId ||
      (typeof video?.videoId === 'string' ? video.videoId : undefined),
    title:
      experiment.title ||
      (typeof video?.title === 'string' ? video.title : undefined),
    channelName:
      experiment.channelName ||
      (typeof video?.channelName === 'string' ? video.channelName : undefined),
    description: experiment.description,
  };
}

function normalizedTextSimilarity(left: string, right: string): number {
  const reference = normalizeQualityText(left);
  const hypothesis = normalizeQualityText(right);
  if (!reference && !hypothesis) return 1;
  if (!reference || !hypothesis) return 0;
  const distance = charEditDistance(reference, hypothesis);
  return Number(
    (1 - distance / Math.max(reference.length, hypothesis.length)).toFixed(4),
  );
}

function overlapSeconds(
  left: SubtitleSegmentLike,
  right: SubtitleSegmentLike,
): number {
  return Math.max(
    0,
    Math.min(left.end, right.end) - Math.max(left.start, right.start),
  );
}

// True when `outer`'s normalized text strictly contains `inner`'s — i.e. the
// inner segment's words are present inside a longer outer segment. The min
// length guard avoids spurious single-character containment.
function textContains(outer: string, inner: string): boolean {
  const o = normalizeQualityText(outer);
  const i = normalizeQualityText(inner);
  return i.length >= 2 && o.length > i.length && o.includes(i);
}

export function buildAlignmentArtifact(input: {
  caseId?: string;
  golden: {
    goldenPath: string;
    segments: SubtitleSegmentLike[];
  };
  generatedSubtitlePath: string;
  generatedSegments: SubtitleSegmentLike[];
}): LlmAlignerAlignmentArtifact {
  const minTextSimilarity = 0.92;
  const maxStartDriftSeconds = 0.8;
  const maxEndDriftSeconds = 1.2;
  const usedGenerated = new Set<number>();
  const pairs: LlmAlignerAlignmentPair[] = [];

  for (const [goldenIndex, golden] of input.golden.segments.entries()) {
    let bestIndex = -1;
    let bestScore = 0;
    for (const [
      generatedIndex,
      generated,
    ] of input.generatedSegments.entries()) {
      if (usedGenerated.has(generatedIndex)) continue;
      const overlap = overlapSeconds(golden, generated);
      const startDistance = Math.abs(golden.start - generated.start);
      const similarity = normalizedTextSimilarity(golden.text, generated.text);
      const score =
        overlap > 0
          ? overlap + similarity
          : startDistance <= 3
            ? 0.2 + similarity
            : 0;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = generatedIndex;
      }
    }

    let generated = bestIndex >= 0 ? input.generatedSegments[bestIndex]! : null;
    if (bestIndex >= 0) usedGenerated.add(bestIndex);

    // Containment fallback: a coarse generated segment can span several golden
    // segments. If no unused candidate is left, reuse an already-matched
    // generated segment that overlaps this golden segment in time and already
    // contains its text — the words are present, just merged upstream.
    if (!generated) {
      const mergedIndex = input.generatedSegments.findIndex(
        (candidate, candidateIndex) =>
          usedGenerated.has(candidateIndex) &&
          overlapSeconds(golden, candidate) > 0 &&
          textContains(candidate.text, golden.text),
      );
      if (mergedIndex >= 0) generated = input.generatedSegments[mergedIndex]!;
    }

    const contained = generated
      ? textContains(generated.text, golden.text)
      : false;
    const reverseContained =
      generated && !contained
        ? textContains(golden.text, generated.text)
        : false;
    const merged = contained;
    const textSimilarity = generated
      ? contained || reverseContained
        ? 1
        : normalizedTextSimilarity(golden.text, generated.text)
      : null;
    const startDriftSeconds = generated
      ? Number((generated.start - golden.start).toFixed(3))
      : null;
    const endDriftSeconds = generated
      ? Number((generated.end - golden.end).toFixed(3))
      : null;
    const status: LlmAlignerAlignmentPair['status'] = !generated
      ? 'missing_generated'
      : contained || reverseContained
        ? 'match'
        : textSimilarity !== null && textSimilarity < minTextSimilarity
          ? 'text_mismatch'
          : Math.abs(startDriftSeconds || 0) > maxStartDriftSeconds ||
              Math.abs(endDriftSeconds || 0) > maxEndDriftSeconds
            ? 'timestamp_drift'
            : 'match';

    pairs.push({
      index: goldenIndex,
      status,
      golden,
      generated,
      textSimilarity,
      startDriftSeconds,
      endDriftSeconds,
      ...(merged ? { merged: true } : {}),
    });
  }

  for (const [generatedIndex, generated] of input.generatedSegments.entries()) {
    if (usedGenerated.has(generatedIndex)) continue;
    pairs.push({
      index: pairs.length,
      status: 'extra_generated',
      golden: null,
      generated,
      textSimilarity: null,
      startDriftSeconds: null,
      endDriftSeconds: null,
    });
  }

  const summary = {
    pairCount: pairs.length,
    matchCount: pairs.filter((pair) => pair.status === 'match').length,
    textMismatchCount: pairs.filter((pair) => pair.status === 'text_mismatch')
      .length,
    timestampDriftCount: pairs.filter(
      (pair) => pair.status === 'timestamp_drift',
    ).length,
    missingGeneratedCount: pairs.filter(
      (pair) => pair.status === 'missing_generated',
    ).length,
    extraGeneratedCount: pairs.filter(
      (pair) => pair.status === 'extra_generated',
    ).length,
    mergedCount: pairs.filter((pair) => pair.merged).length,
  };

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    case: {
      id: input.caseId || null,
      goldenPath: input.golden.goldenPath,
    },
    generated: {
      subtitlePath: input.generatedSubtitlePath,
    },
    thresholds: {
      minTextSimilarity,
      maxStartDriftSeconds,
      maxEndDriftSeconds,
    },
    summary,
    pairs,
  };
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
  let transcribeDurationMs = 0;
  const transcribeStartedMs = Date.now();

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
    transcribeDurationMs = Date.now() - transcribeStartedMs;
    utterances = transcribed.utterances;
    totalTokens = transcribed.totalTokens;
    ttftSeconds = transcribed.ttftSeconds;
  } catch (error) {
    transcribeDurationMs = Date.now() - transcribeStartedMs;
    const result = buildTranscribeFailedChunk({
      chunkIndex: range.index,
      chunkOffsetSec: range.offsetSec,
      durationSec,
      maxSegmentSeconds: input.llmConfig.maxSegmentSeconds,
      transcribeDurationMs,
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
      transcribeDurationMs,
      alignerDurationMs: result.alignerDurationMs,
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
    transcribeDurationMs,
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

  const resultWithTiming = { ...result, transcribeDurationMs };

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
    transcribeDurationMs,
    alignerDurationMs: result.alignerDurationMs,
    totalTokens,
    ttftSeconds,
  };
  return { result: resultWithTiming, record, totalTokens, ttftSeconds };
}

export async function runLlmAlignerExperiment(
  experiment: LlmAlignerEvalExperiment,
  options: LlmAlignerEvalRunOptions = {},
): Promise<LlmAlignerEvalResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const caseInput = resolveEvalCaseInput(experiment);
  const id = sanitizeFileName(
    experiment.id ||
      caseInput.caseId ||
      (caseInput.audioPath
        ? path.basename(caseInput.audioPath, path.extname(caseInput.audioPath))
        : 'llm-aligner-eval'),
  );
  if (!caseInput.audioPath) {
    throw new Error(`eval audio is missing for ${id}`);
  }
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

  const audioPrepareStartedMs = Date.now();
  const normalizedAudioPath = await normalizeAudioToMp3(
    path.resolve(caseInput.audioPath),
    outputDir,
  );
  const durationSeconds = await probeAudioDurationSeconds(
    normalizedAudioPath,
    options.signal,
  );
  const audioPrepareDurationMs = Date.now() - audioPrepareStartedMs;
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
    platform: caseInput.platform || 'eval',
    video_id: caseInput.videoId || id,
    title: caseInput.title || id,
    channel_name: caseInput.channelName || null,
    description: caseInput.description || null,
  };
  const ranges = buildChunkRanges(durationSeconds, chunkSeconds);
  writeJson(path.join(outputDir, 'input.json'), {
    ...experiment,
    model: { ...model, apiKey: model.apiKey ? '[redacted]' : '' },
    case: caseInput.caseDir
      ? {
          id: caseInput.caseId || null,
          dir: caseInput.caseDir,
          metadataPath: caseInput.metadataPath || null,
        }
      : null,
    audioPath: path.resolve(caseInput.audioPath),
    normalizedAudioPath,
    durationSeconds,
    chunkCount: ranges.length,
  });

  const chunkStartedMs = Date.now();
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
  const chunkWallDurationMs = Date.now() - chunkStartedMs;

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
    goldenJsonPath: caseInput.goldenJsonPath,
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
  const qualityGateResult = experiment.qualityGate
    ? evaluateQualityGate(experiment.qualityGate, quality)
    : undefined;
  const subtitleJsonPath = path.join(outputDir, 'subtitle.json');
  const subtitleTextPath = path.join(outputDir, 'subtitle.txt');
  const metricsPath = path.join(outputDir, 'metrics.json');
  const runPath = path.join(outputDir, 'run.json');
  const alignmentPath = golden ? path.join(outputDir, 'alignment.json') : null;
  const totalDurationMs = Date.now() - startedMs;
  const phaseTiming: LlmAlignerEvalPhaseTiming = {
    totalDurationMs,
    audioPrepareDurationMs,
    chunkWallDurationMs,
    transcribeDurationMs: chunkWork.reduce(
      (sum, entry) => sum + (entry.record.transcribeDurationMs || 0),
      0,
    ),
    alignerDurationMs: chunkWork.reduce(
      (sum, entry) => sum + (entry.record.alignerDurationMs || 0),
      0,
    ),
  };
  writeJson(subtitleJsonPath, {
    status: 'completed',
    sourceMethod: 'llm-aligner-eval',
    language: 'unknown',
    segmentStyle: 'fine',
    text: subtitleText,
    segments,
    metadata: {
      ...summary,
      phaseTiming,
      ...(quality ? { quality } : {}),
      ...(experiment.qualityGate
        ? {
            qualityGate: experiment.qualityGate,
            qualityGateResult,
          }
        : {}),
    },
  });
  fs.writeFileSync(subtitleTextPath, `${subtitleText}\n`, 'utf8');
  const alignment = golden
    ? buildAlignmentArtifact({
        caseId: caseInput.caseId,
        golden,
        generatedSubtitlePath: subtitleJsonPath,
        generatedSegments: segments,
      })
    : undefined;
  if (alignment && alignmentPath) writeJson(alignmentPath, alignment);

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
    audioPath: path.resolve(caseInput.audioPath),
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
    ...(caseInput.caseDir
      ? {
          case: {
            id: caseInput.caseId || id,
            dir: caseInput.caseDir,
            ...(caseInput.metadataPath
              ? { metadataPath: caseInput.metadataPath }
              : {}),
          },
        }
      : {}),
    summary,
    ...(quality ? { quality } : {}),
    ...(experiment.qualityGate
      ? {
          qualityGate: experiment.qualityGate,
          qualityGateResult,
        }
      : {}),
    ...(experiment.configSource
      ? { configSource: experiment.configSource }
      : {}),
    ...(experiment.configSnapshot
      ? { configSnapshot: experiment.configSnapshot }
      : {}),
    phaseTiming,
    chunks: chunkWork.map((entry) => entry.record),
    files: {
      run: runPath,
      subtitleJson: subtitleJsonPath,
      subtitleText: subtitleTextPath,
      metrics: metricsPath,
      ...(alignmentPath ? { alignment: alignmentPath } : {}),
    },
  };
  writeJson(metricsPath, result);
  writeJson(runPath, {
    version: 1,
    status: 'completed',
    pipeline: 'llm-aligner',
    id: result.id,
    case: result.case || null,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
    model: result.model,
    config: result.config,
    configSource: result.configSource || null,
    configSnapshot: result.configSnapshot || null,
    summary: result.summary,
    quality: result.quality || null,
    qualityGate: result.qualityGate || null,
    qualityGateResult: result.qualityGateResult || null,
    phaseTiming: result.phaseTiming,
    files: result.files,
  });
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
      const fallbackId = sanitizeFileName(
        experiment.id ||
          experiment.caseId ||
          (experiment.audioPath
            ? path.basename(
                experiment.audioPath,
                path.extname(experiment.audioPath),
              )
            : 'llm-aligner-eval'),
      );
      const outputDir = path.resolve(
        experiment.outputDir ||
          path.join(
            outputRoot,
            `${new Date().toISOString().replace(/[:.]/g, '-')}-${fallbackId}`,
          ),
      );
      const preparedExperiment = { ...experiment, outputDir };
      try {
        const result = await runLlmAlignerExperiment(preparedExperiment, {
          outputRoot,
          chunkConcurrency: input.chunkConcurrency,
          signal: input.signal,
        });
        return { ok: true as const, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Failed runs are not recorded: drop any partial output directory so the
        // dashboard never lists a failed/incomplete run. The failure is surfaced
        // through the return value (and the CLI/job log) instead.
        try {
          fs.rmSync(outputDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
        return {
          ok: false as const,
          id: fallbackId,
          error: message,
          outputDir,
        };
      }
    },
  );
}
