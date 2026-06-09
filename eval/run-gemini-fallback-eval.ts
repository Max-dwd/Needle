#!/usr/bin/env tsx
/**
 * Gemini-fallback subtitle eval.
 *
 * Faithfully reproduces Needle's production `gemini` subtitle method
 * (`fetchSubtitleViaSegmentedAudio` in src/lib/subtitles.ts): split the cached
 * audio into the transcriber's native chunk size, ask Gemini to emit
 * timestamped `[mm:ss-mm:ss]` lines, parse them, shift by chunk offset, dedupe.
 * Timestamps come from Gemini itself — no forced aligner.
 *
 * The output is then scored against the same browser golden with the same
 * `scoreLlmAlignerQuality` / quality gate the llm-aligner eval uses, so the two
 * pipelines are directly comparable on identical cases and references.
 *
 * Usage:
 *   npx tsx eval/run-gemini-fallback-eval.ts --config eval/config.local.yaml
 *   npx tsx eval/run-gemini-fallback-eval.ts --config eval/config.local.yaml --case short-youtube-llm-ibm
 */
import fs from 'fs';
import path from 'path';

import { loadEvalConfig } from './config';
import {
  scoreLlmAlignerQuality,
  readGoldenSubtitle,
  evaluateQualityGate,
  buildAlignmentArtifact,
  type LlmAlignerQualityGate,
} from './llm-aligner-pipeline';
import {
  buildSegmentedSubtitlePrompt,
  splitAudioIntoChunks,
  parseAiRangeBlock,
  shiftSubtitleSegments,
  dedupeSegments,
  probeAudioDurationSeconds,
  formatSecondsForAiRange,
  type SubtitleSegment,
} from '@/lib/subtitles';
import {
  DEFAULT_AI_SUBTITLE_PROMPT_TEMPLATE,
  DEFAULT_AI_SUBTITLE_SEGMENT_PROMPT_TEMPLATE,
} from '@/lib/ai-summary-settings';
import { getTranscriber } from '@/lib/subtitle-providers';

// The 4 cases that already have llm-aligner results, for an apples-to-apples
// comparison. Override with one or more --case flags.
const DEFAULT_CASES = [
  'short-youtube-llm-ibm',
  'adhoc-youtube-5sLYAQS9sWQ',
  'short-chinese-chloe-remember',
  'adhoc-youtube-LAwBdRR4wQk',
];

interface CliOptions {
  config: string;
  cases: string[];
  outputRoot: string;
}

function parseArgs(argv: string[]): CliOptions {
  let config = 'eval/config.local.yaml';
  let outputRoot = 'eval/runs-gemini-fallback';
  const cases: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') config = argv[++i]!;
    else if (arg === '--case') cases.push(argv[++i]!);
    else if (arg === '--output-root') outputRoot = argv[++i]!;
  }
  return {
    config,
    cases: cases.length > 0 ? cases : DEFAULT_CASES,
    outputRoot,
  };
}

function readCaseMetadata(caseDir: string): {
  audioPath: string;
  goldenJsonPath: string;
  durationSeconds: number | null;
} {
  const metaPath = path.join(caseDir, 'metadata.json');
  const audioFallback = path.join(caseDir, 'audio.mp3');
  const goldenFallback = path.join(caseDir, 'golden.json');
  if (!fs.existsSync(metaPath)) {
    return {
      audioPath: audioFallback,
      goldenJsonPath: goldenFallback,
      durationSeconds: null,
    };
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
    audio?: { cachedAudioPath?: string; durationSeconds?: number };
    golden?: { jsonPath?: string };
  };
  const audioPath = meta.audio?.cachedAudioPath
    ? path.resolve(meta.audio.cachedAudioPath)
    : audioFallback;
  const goldenJsonPath = meta.golden?.jsonPath
    ? path.resolve(meta.golden.jsonPath)
    : goldenFallback;
  return {
    audioPath: fs.existsSync(audioPath) ? audioPath : audioFallback,
    goldenJsonPath: fs.existsSync(goldenJsonPath)
      ? goldenJsonPath
      : goldenFallback,
    durationSeconds: meta.audio?.durationSeconds ?? null,
  };
}

async function runCase(
  caseId: string,
  config: ReturnType<typeof loadEvalConfig>['config'],
  outputRoot: string,
): Promise<{ passed: boolean | null }> {
  const caseDir = path.resolve('eval/data/cases', caseId);
  if (!fs.existsSync(caseDir)) {
    console.error(`[skip] ${caseId}: case dir not found (${caseDir})`);
    return { passed: null };
  }
  const { audioPath, goldenJsonPath, durationSeconds } =
    readCaseMetadata(caseDir);
  const golden = readGoldenSubtitle({ goldenJsonPath });
  if (!golden) {
    console.error(`[skip] ${caseId}: golden not found (${goldenJsonPath})`);
    return { passed: null };
  }

  const startedAt = new Date();
  const outputDir = path.join(
    outputRoot,
    `${startedAt.toISOString().replace(/[:.]/g, '-')}-${caseId}`,
  );
  const chunkDir = path.join(outputDir, 'chunks');
  fs.mkdirSync(chunkDir, { recursive: true });

  // Failed runs are not recorded: if anything throws, drop the partial output
  // directory so the dashboard never lists an incomplete run.
  let succeeded = false;
  try {
    const transcriber = getTranscriber(config.model);
    const chunkSeconds = transcriber.maxAudioChunkSeconds;
    const totalDuration =
      durationSeconds ?? (await probeAudioDurationSeconds(audioPath)) ?? 0;
    if (!totalDuration) throw new Error(`${caseId}: cannot determine duration`);

    const chunks = await splitAudioIntoChunks(
      audioPath,
      chunkDir,
      totalDuration,
      chunkSeconds,
    );

    const mergedSegments: SubtitleSegment[] = [];
    const rawBlocks: string[] = [];
    let totalTokens = 0;
    let firstChunkTtft: number | undefined;
    let unparseableChunks = 0;
    const transcribeStart = Date.now();

    for (const chunk of chunks) {
      const raw = await transcriber.transcribeAudio(config.model, {
        audioPath: chunk.filePath,
        mediaType: 'audio/mpeg',
        prompt: buildSegmentedSubtitlePrompt(
          DEFAULT_AI_SUBTITLE_PROMPT_TEMPLATE,
          DEFAULT_AI_SUBTITLE_SEGMENT_PROMPT_TEMPLATE,
          chunk.startSeconds,
          chunk.endSeconds,
          chunkSeconds,
        ),
        priority: 'manual-subtitle',
        label: `gemini-fallback:${caseId}:chunk-${chunk.index + 1}`,
        estimatedTokens: 8000,
      });
      if (chunk.index === 0) firstChunkTtft = raw.ttftSeconds;
      const relative = parseAiRangeBlock(raw.text);
      if (relative.length === 0) unparseableChunks += 1;
      mergedSegments.push(
        ...shiftSubtitleSegments(relative, chunk.startSeconds),
      );
      rawBlocks.push(
        `# chunk ${chunk.index + 1} ${formatSecondsForAiRange(chunk.startSeconds)}-${formatSecondsForAiRange(chunk.endSeconds)}\n${raw.text.trim()}`,
      );
      totalTokens += raw.usage?.totalTokens || 0;
    }
    const transcribeDurationMs = Date.now() - transcribeStart;

    const segments = dedupeSegments(mergedSegments);
    if (segments.length === 0) {
      throw new Error(
        `${caseId}: gemini fallback produced no parseable segments`,
      );
    }
    const hypothesisText = segments.map((segment) => segment.text).join('\n');
    const quality = scoreLlmAlignerQuality({
      golden,
      hypothesisSegments: segments,
      hypothesisText,
      fallbackRatio: 0,
    });
    const gate = config.qualityGate as LlmAlignerQualityGate | undefined;
    const qualityGateResult = gate
      ? evaluateQualityGate(gate, quality)
      : undefined;

    const completedAt = new Date();
    const metrics = {
      id: caseId,
      method: 'gemini-fallback',
      pipeline: 'gemini-fallback',
      status: 'completed',
      outputDir,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      audioPath,
      model: {
        id: config.model.id,
        model: config.model.model,
        protocol: config.model.protocol,
      },
      config: { chunkSeconds, alignerless: true },
      summary: {
        chunkCount: chunks.length,
        unparseableChunks,
        segmentCount: segments.length,
        totalTokens,
        firstChunkTtft,
        transcribeDurationMs,
      },
      quality,
      qualityGate: gate ?? null,
      qualityGateResult: qualityGateResult ?? null,
      goldenPath: goldenJsonPath,
    };
    fs.writeFileSync(
      path.join(outputDir, 'metrics.json'),
      JSON.stringify(metrics, null, 2),
    );
    const subtitleJsonPath = path.join(outputDir, 'subtitle.json');
    fs.writeFileSync(
      subtitleJsonPath,
      JSON.stringify(
        {
          language: 'unknown',
          segmentStyle: 'coarse',
          text: hypothesisText,
          segments,
          metadata: { ...metrics.summary, quality },
        },
        null,
        2,
      ),
    );
    // Same alignment artifact the llm-aligner pipeline emits, so the dashboard's
    // subtitle-alignment diff panel works for gemini-fallback runs too.
    fs.writeFileSync(
      path.join(outputDir, 'alignment.json'),
      JSON.stringify(
        buildAlignmentArtifact({
          caseId,
          golden,
          generatedSubtitlePath: subtitleJsonPath,
          generatedSegments: segments,
        }),
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(outputDir, 'subtitle.txt'),
      segments
        .map(
          (s) =>
            `[${formatSecondsForAiRange(s.start)}-${formatSecondsForAiRange(s.end)}] ${s.text}`,
        )
        .join('\n'),
    );
    fs.writeFileSync(path.join(outputDir, 'raw.txt'), rawBlocks.join('\n\n'));

    const passed = qualityGateResult?.passed ?? null;
    console.log(
      `[ok] ${caseId} method=gemini-fallback chunks=${chunks.length} segments=${segments.length} ` +
        `coverage=${quality.text.coverage} ncer=${quality.text.normalizedCharErrorRate} ` +
        `startMae=${quality.timing.startMaeSeconds}s endMae=${quality.timing.endMaeSeconds}s ` +
        `tokens=${totalTokens} gate=${passed === null ? 'n/a' : passed ? 'pass' : 'FAIL'} out=${outputDir}`,
    );
    succeeded = true;
    return { passed };
  } finally {
    if (!succeeded) {
      try {
        fs.rmSync(outputDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { config } = loadEvalConfig(options.config);
  const outputRoot = path.resolve(options.outputRoot);
  fs.mkdirSync(outputRoot, { recursive: true });

  console.log(
    `[start] gemini-fallback eval model=${config.model.model} cases=${options.cases.length}`,
  );
  let failures = 0;
  for (const caseId of options.cases) {
    try {
      const { passed } = await runCase(caseId, config, outputRoot);
      if (passed === false) failures += 1;
    } catch (error) {
      failures += 1;
      console.error(
        `[failed] ${caseId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures > 0) process.exitCode = 1;
}

void main();
