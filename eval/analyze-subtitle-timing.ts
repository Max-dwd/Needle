#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';

interface CliOptions {
  hyp?: string;
  golden?: string;
  metrics?: string;
  jsonOutput?: string;
  boundaryWindowSeconds: number;
}

interface SubtitleSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

interface TextSpan {
  textStart: number;
  textEnd: number;
  timeStart: number;
  timeEnd: number;
}

interface TimingPair {
  index: number;
  textRatioStart: number;
  textRatioEnd: number;
  textRatioMid: number;
  hypStart: number;
  hypEnd: number;
  refStart: number;
  refEnd: number;
  startError: number;
  endError: number;
  startAbsError: number;
  endAbsError: number;
  boundaryAbsErrors: number[];
  nearestChunkBoundarySeconds: number | null;
}

interface BucketStats {
  label: string;
  count: number;
  startMedianSeconds: number | null;
  startMaeSeconds: number | null;
  startP95Seconds: number | null;
  endMedianSeconds: number | null;
  endMaeSeconds: number | null;
  endP95Seconds: number | null;
  boundaryMedianSeconds: number | null;
  boundaryMaeSeconds: number | null;
  boundaryP95Seconds: number | null;
}

interface ChunkRange {
  index: number;
  offsetSec: number;
  endSec: number;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { boundaryWindowSeconds: 5 };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case '--hyp':
      case '--hypothesis':
        options.hyp = next();
        break;
      case '--golden':
        options.golden = next();
        break;
      case '--metrics':
        options.metrics = next();
        break;
      case '--json-output':
        options.jsonOutput = next();
        break;
      case '--boundary-window-seconds':
        options.boundaryWindowSeconds = Number(next());
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!options.hyp) throw new Error('--hyp is required');
  if (!options.golden) throw new Error('--golden is required');
  if (
    !Number.isFinite(options.boundaryWindowSeconds) ||
    options.boundaryWindowSeconds <= 0
  ) {
    throw new Error('--boundary-window-seconds must be a positive number');
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage:
  npm exec tsx -- eval/analyze-subtitle-timing.ts \\
    --hyp eval/runs/<run>/subtitle.json \\
    --golden eval/data/cases/<case>/golden.json

Options:
  --hyp, --hypothesis          Hypothesis subtitle JSON
  --golden                    Golden/reference JSON
  --metrics                   Optional eval metrics.json with chunks[]
  --boundary-window-seconds   Near-boundary window for summary bucket (default: 5)
  --json-output               Optional path to write the full analysis JSON
`);
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8')) as unknown;
}

function round(value: number | null, digits = 3): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function toSubtitleSegment(value: unknown): SubtitleSegment | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const start = Number(entry.start);
  const end = Number(entry.end);
  const text = typeof entry.text === 'string' ? entry.text.trim() : '';
  if (!Number.isFinite(start) || !Number.isFinite(end) || !text) return null;
  const speaker = typeof entry.speaker === 'string' ? entry.speaker : undefined;
  return {
    start,
    end: Math.max(end, start + 0.05),
    text,
    ...(speaker ? { speaker } : {}),
  };
}

function extractSegments(payload: unknown): SubtitleSegment[] {
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
      .filter((segment): segment is SubtitleSegment => Boolean(segment));
    if (segments.length > 0) return segments;
  }

  return [];
}

function buildTextTimeline(segments: SubtitleSegment[]): {
  spans: TextSpan[];
  totalChars: number;
} {
  const spans: TextSpan[] = [];
  let cursor = 0;

  for (const segment of segments) {
    const charCount = Array.from(normalizeText(segment.text)).length;
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

function mapTextPositionToTime(
  timeline: { spans: TextSpan[]; totalChars: number },
  position: number,
  boundarySide: 'start' | 'end',
): number | null {
  if (timeline.totalChars <= 0 || timeline.spans.length === 0) return null;
  const safePosition = Math.min(
    timeline.totalChars,
    Math.max(0, Number.isFinite(position) ? position : 0),
  );

  for (const [index, span] of timeline.spans.entries()) {
    const isLast = index === timeline.spans.length - 1;
    if (
      !isLast &&
      (boundarySide === 'start'
        ? safePosition >= span.textEnd
        : safePosition > span.textEnd)
    ) {
      continue;
    }
    const spanChars = Math.max(1, span.textEnd - span.textStart);
    const ratio = Math.min(
      1,
      Math.max(0, (safePosition - span.textStart) / spanChars),
    );
    return span.timeStart + (span.timeEnd - span.timeStart) * ratio;
  }

  return timeline.spans.at(-1)?.timeEnd ?? null;
}

function nearestDistance(value: number, candidates: number[]): number | null {
  if (candidates.length === 0) return null;
  let best = Infinity;
  for (const candidate of candidates) {
    best = Math.min(best, Math.abs(value - candidate));
  }
  return Number.isFinite(best) ? best : null;
}

function collectTimingPairs(
  referenceSegments: SubtitleSegment[],
  hypothesisSegments: SubtitleSegment[],
  chunkBoundaries: number[],
): TimingPair[] {
  const referenceTimeline = buildTextTimeline(referenceSegments);
  const hypothesisTimeline = buildTextTimeline(hypothesisSegments);
  if (referenceTimeline.totalChars <= 0 || hypothesisTimeline.totalChars <= 0) {
    return [];
  }

  const pairs: TimingPair[] = [];
  let hypothesisCursor = 0;
  for (const [index, segment] of hypothesisSegments.entries()) {
    const charCount = Array.from(normalizeText(segment.text)).length;
    if (charCount <= 0) continue;

    const textStart = hypothesisCursor;
    const textEnd = hypothesisCursor + charCount;
    hypothesisCursor = textEnd;

    const textRatioStart = textStart / hypothesisTimeline.totalChars;
    const textRatioEnd = textEnd / hypothesisTimeline.totalChars;
    const referenceStart = mapTextPositionToTime(
      referenceTimeline,
      textRatioStart * referenceTimeline.totalChars,
      'start',
    );
    const referenceEnd = mapTextPositionToTime(
      referenceTimeline,
      textRatioEnd * referenceTimeline.totalChars,
      'end',
    );
    if (referenceStart === null || referenceEnd === null) continue;

    const nearestStart = nearestDistance(segment.start, chunkBoundaries);
    const nearestEnd = nearestDistance(segment.end, chunkBoundaries);
    const nearestChunkBoundarySeconds =
      nearestStart === null && nearestEnd === null
        ? null
        : Math.min(nearestStart ?? Infinity, nearestEnd ?? Infinity);

    pairs.push({
      index,
      textRatioStart,
      textRatioEnd,
      textRatioMid: (textRatioStart + textRatioEnd) / 2,
      hypStart: segment.start,
      hypEnd: segment.end,
      refStart: referenceStart,
      refEnd: referenceEnd,
      startError: segment.start - referenceStart,
      endError: segment.end - referenceEnd,
      startAbsError: Math.abs(segment.start - referenceStart),
      endAbsError: Math.abs(segment.end - referenceEnd),
      boundaryAbsErrors: [
        Math.abs(segment.start - referenceStart),
        Math.abs(segment.end - referenceEnd),
      ],
      nearestChunkBoundarySeconds,
    });
  }

  return pairs;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index]!;
}

function stats(label: string, pairs: TimingPair[]): BucketStats {
  const start = pairs.map((pair) => pair.startAbsError);
  const end = pairs.map((pair) => pair.endAbsError);
  const boundary = pairs.flatMap((pair) => pair.boundaryAbsErrors);

  return {
    label,
    count: pairs.length,
    startMedianSeconds: round(percentile(start, 50)),
    startMaeSeconds: round(average(start)),
    startP95Seconds: round(percentile(start, 95)),
    endMedianSeconds: round(percentile(end, 50)),
    endMaeSeconds: round(average(end)),
    endP95Seconds: round(percentile(end, 95)),
    boundaryMedianSeconds: round(percentile(boundary, 50)),
    boundaryMaeSeconds: round(average(boundary)),
    boundaryP95Seconds: round(percentile(boundary, 95)),
  };
}

function extractChunkRanges(payload: unknown): ChunkRange[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const candidate = record.chunks;
  if (!Array.isArray(candidate)) return [];

  return candidate
    .map((value) => {
      if (!value || typeof value !== 'object') return null;
      const entry = value as Record<string, unknown>;
      const index = Number(entry.index);
      const offsetSec = Number(entry.offsetSec);
      const endSec = Number(entry.endSec);
      if (
        !Number.isInteger(index) ||
        !Number.isFinite(offsetSec) ||
        !Number.isFinite(endSec) ||
        endSec <= offsetSec
      ) {
        return null;
      }
      return { index, offsetSec, endSec };
    })
    .filter((range): range is ChunkRange => Boolean(range))
    .sort((left, right) => left.offsetSec - right.offsetSec);
}

function inferMetricsPath(hypothesisPath: string): string | null {
  const candidate = path.join(
    path.dirname(path.resolve(hypothesisPath)),
    'metrics.json',
  );
  return fs.existsSync(candidate) ? candidate : null;
}

function buildChunkBoundaries(ranges: ChunkRange[]): number[] {
  const starts = ranges.map((range) => range.offsetSec);
  const ends = ranges.map((range) => range.endSec);
  const minStart = Math.min(...starts);
  const maxEnd = Math.max(...ends);
  return [...new Set([...starts, ...ends])]
    .filter((value) => value > minStart && value < maxEnd)
    .sort((left, right) => left - right);
}

function textPositionBuckets(pairs: TimingPair[]): BucketStats[] {
  return [
    stats(
      'early 0-33%',
      pairs.filter((pair) => pair.textRatioMid < 1 / 3),
    ),
    stats(
      'mid 33-67%',
      pairs.filter(
        (pair) => pair.textRatioMid >= 1 / 3 && pair.textRatioMid < 2 / 3,
      ),
    ),
    stats(
      'late 67-100%',
      pairs.filter((pair) => pair.textRatioMid >= 2 / 3),
    ),
  ];
}

function chunkBoundaryBuckets(
  pairs: TimingPair[],
  boundaryWindowSeconds: number,
): BucketStats[] {
  return [
    stats(
      'chunk <=1s',
      pairs.filter(
        (pair) =>
          pair.nearestChunkBoundarySeconds !== null &&
          pair.nearestChunkBoundarySeconds <= 1,
      ),
    ),
    stats(
      'chunk <=3s',
      pairs.filter(
        (pair) =>
          pair.nearestChunkBoundarySeconds !== null &&
          pair.nearestChunkBoundarySeconds > 1 &&
          pair.nearestChunkBoundarySeconds <= 3,
      ),
    ),
    stats(
      `chunk <=${boundaryWindowSeconds}s`,
      pairs.filter(
        (pair) =>
          pair.nearestChunkBoundarySeconds !== null &&
          pair.nearestChunkBoundarySeconds > 3 &&
          pair.nearestChunkBoundarySeconds <= boundaryWindowSeconds,
      ),
    ),
    stats(
      `chunk >${boundaryWindowSeconds}s`,
      pairs.filter(
        (pair) =>
          pair.nearestChunkBoundarySeconds === null ||
          pair.nearestChunkBoundarySeconds > boundaryWindowSeconds,
      ),
    ),
  ];
}

function formatValue(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(3);
}

function printTable(title: string, rows: BucketStats[]): void {
  console.log(`\n${title}`);
  console.log(
    [
      'bucket',
      'n',
      'start_med',
      'start_mae',
      'start_p95',
      'end_med',
      'end_mae',
      'end_p95',
      'boundary_med',
      'boundary_mae',
      'boundary_p95',
    ].join('\t'),
  );
  for (const row of rows) {
    console.log(
      [
        row.label,
        String(row.count),
        formatValue(row.startMedianSeconds),
        formatValue(row.startMaeSeconds),
        formatValue(row.startP95Seconds),
        formatValue(row.endMedianSeconds),
        formatValue(row.endMaeSeconds),
        formatValue(row.endP95Seconds),
        formatValue(row.boundaryMedianSeconds),
        formatValue(row.boundaryMaeSeconds),
        formatValue(row.boundaryP95Seconds),
      ].join('\t'),
    );
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const hypothesisPath = path.resolve(options.hyp!);
  const goldenPath = path.resolve(options.golden!);
  const metricsPath = options.metrics
    ? path.resolve(options.metrics)
    : inferMetricsPath(hypothesisPath);

  const hypothesisSegments = extractSegments(readJson(hypothesisPath));
  const referenceSegments = extractSegments(readJson(goldenPath));
  if (hypothesisSegments.length === 0) {
    throw new Error(`no hypothesis segments found in ${hypothesisPath}`);
  }
  if (referenceSegments.length === 0) {
    throw new Error(`no reference segments found in ${goldenPath}`);
  }

  const chunks = metricsPath ? extractChunkRanges(readJson(metricsPath)) : [];
  const chunkBoundaries = chunks.length > 1 ? buildChunkBoundaries(chunks) : [];
  const pairs = collectTimingPairs(
    referenceSegments,
    hypothesisSegments,
    chunkBoundaries,
  );
  const overall = stats('overall', pairs);
  const byTextPosition = textPositionBuckets(pairs);
  const byChunkBoundary =
    chunkBoundaries.length > 0
      ? chunkBoundaryBuckets(pairs, options.boundaryWindowSeconds)
      : [];
  const report = {
    pairingMethod: 'text-position',
    hypothesisPath,
    goldenPath,
    metricsPath,
    segmentCounts: {
      hypothesis: hypothesisSegments.length,
      reference: referenceSegments.length,
      paired: pairs.length,
    },
    chunks: {
      count: chunks.length,
      boundaryCount: chunkBoundaries.length,
      boundariesSeconds: chunkBoundaries.map((value) => round(value)),
      boundaryWindowSeconds: options.boundaryWindowSeconds,
    },
    overall,
    byTextPosition,
    byChunkBoundary,
    pairs: pairs.map((pair) => ({
      ...pair,
      textRatioStart: round(pair.textRatioStart, 6),
      textRatioEnd: round(pair.textRatioEnd, 6),
      textRatioMid: round(pair.textRatioMid, 6),
      hypStart: round(pair.hypStart),
      hypEnd: round(pair.hypEnd),
      refStart: round(pair.refStart),
      refEnd: round(pair.refEnd),
      startError: round(pair.startError),
      endError: round(pair.endError),
      startAbsError: round(pair.startAbsError),
      endAbsError: round(pair.endAbsError),
      boundaryAbsErrors: pair.boundaryAbsErrors.map((value) => round(value)),
      nearestChunkBoundarySeconds: round(pair.nearestChunkBoundarySeconds),
    })),
  };

  console.log(`hypothesis: ${hypothesisPath}`);
  console.log(`golden:     ${goldenPath}`);
  console.log(`pairs:      ${pairs.length}`);
  console.log(`chunks:     ${chunks.length}`);
  if (metricsPath) console.log(`metrics:    ${metricsPath}`);
  printTable('Overall', [overall]);
  printTable('By Text Position', byTextPosition);
  if (byChunkBoundary.length > 0) {
    printTable('By Chunk Boundary Distance', byChunkBoundary);
  } else {
    console.log('\nBy Chunk Boundary Distance\nn/a: no chunk metadata found');
  }

  if (options.jsonOutput) {
    const outputPath = path.resolve(options.jsonOutput);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    console.log(`\nwrote ${outputPath}`);
  }
}

main();
