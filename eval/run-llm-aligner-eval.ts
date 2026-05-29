#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import {
  loadEvalConfig,
  loadRepoEnv,
  type EvalConfigLoadResult,
} from './config';
import type {
  LlmAlignerEvalDefaults,
  LlmAlignerEvalExperiment,
} from './llm-aligner-pipeline';

interface ManifestFile {
  outputRoot?: string;
  concurrency?: number;
  chunkConcurrency?: number;
  defaults?: LlmAlignerEvalDefaults;
  experiments: LlmAlignerEvalExperiment[];
}

interface CliOptions {
  config?: string;
  validateConfig?: boolean;
  manifest?: string;
  outputRoot?: string;
  concurrency?: number;
  chunkConcurrency?: number;
  audio?: string;
  caseId?: string;
  caseDir?: string;
  caseManifestPath?: string;
  id?: string;
  title?: string;
  channelName?: string;
  modelId?: string;
  providerModel?: string;
  modelFile?: string;
  chunkSeconds?: number;
  maxSegmentSeconds?: number;
  coveragePrompt?: boolean;
  goldenJsonPath?: string;
  goldenSubtitlePath?: string;
  keepAudioChunks?: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
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
      case '--config':
        options.config = next();
        break;
      case '--validate-config':
        options.validateConfig = true;
        break;
      case '--manifest':
      case '-m':
        options.manifest = next();
        break;
      case '--output-root':
        options.outputRoot = next();
        break;
      case '--concurrency':
      case '-c':
        options.concurrency = Number(next());
        break;
      case '--chunk-concurrency':
        options.chunkConcurrency = Number(next());
        break;
      case '--audio':
        options.audio = next();
        break;
      case '--case':
      case '--case-id':
        options.caseId = next();
        break;
      case '--case-dir':
        options.caseDir = next();
        break;
      case '--case-manifest':
        options.caseManifestPath = next();
        break;
      case '--id':
        options.id = next();
        break;
      case '--title':
        options.title = next();
        break;
      case '--channel':
        options.channelName = next();
        break;
      case '--model-id':
        options.modelId = next();
        break;
      case '--provider-model':
        options.providerModel = next();
        break;
      case '--model-file':
        options.modelFile = next();
        break;
      case '--chunk-seconds':
        options.chunkSeconds = Number(next());
        break;
      case '--max-segment-seconds':
        options.maxSegmentSeconds = Number(next());
        break;
      case '--coverage-prompt':
        options.coveragePrompt = true;
        break;
      case '--golden-json':
        options.goldenJsonPath = next();
        break;
      case '--golden-subtitle':
        options.goldenSubtitlePath = next();
        break;
      case '--keep-audio-chunks':
        options.keepAudioChunks = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage:
  npm run eval:llm-aligner -- --config eval/config.local.yaml

  npm exec tsx -- eval/run-llm-aligner-eval.ts --manifest eval/llm-aligner-manifest.example.json

  npm exec tsx -- eval/run-llm-aligner-eval.ts \\
    --audio /path/to/audio.mp3 \\
    --id sample-a \\
    --model-id your-multimodal-model-id \\
    --chunk-seconds 300 \\
    --concurrency 2

Options:
  --config                  YAML eval config file (recommended)
  --validate-config         Validate YAML config and exit without running eval
  --manifest, -m             JSON manifest with experiments[]
  --output-root              Directory for run outputs (default: eval/runs)
  --concurrency, -c          Number of experiments to run in parallel
  --chunk-concurrency        Number of chunks to process in parallel per experiment
  --audio                    Single-experiment audio input
  --case                     Single eval case id from eval/data/manifest.json
  --case-dir                 Single eval case directory with metadata/golden/audio
  --case-manifest            Golden dataset manifest for --case
  --id                       Single-experiment id
  --model-id                 Model id from Settings -> Models
  --provider-model           Override provider model slug while reusing model id credentials
  --model-file               JSON file containing an AiSummaryModelConfig
  --chunk-seconds            LLM/aligner chunk length in seconds
  --max-segment-seconds      Final segment split target in seconds
  --coverage-prompt          Add stricter verbatim coverage instructions to transcription prompt
  --golden-json              Reference golden JSON for quality metrics
  --golden-subtitle          Reference subtitle JSON for quality metrics
  --keep-audio-chunks        Keep sliced chunk audio files in the output directory
`);
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8')) as T;
}

function buildSingleExperiment(options: CliOptions): ManifestFile {
  if (!options.audio && !options.caseId && !options.caseDir) {
    throw new Error(
      'either --manifest, --audio, --case, or --case-dir is required',
    );
  }
  const model = options.modelFile
    ? readJsonFile<LlmAlignerEvalExperiment['model']>(options.modelFile)
    : undefined;
  return {
    outputRoot: options.outputRoot,
    concurrency: options.concurrency,
    chunkConcurrency: options.chunkConcurrency,
    experiments: [
      {
        id:
          options.id ||
          options.caseId ||
          (options.audio
            ? path.basename(options.audio, path.extname(options.audio))
            : undefined),
        audioPath: options.audio,
        caseId: options.caseId,
        caseDir: options.caseDir,
        caseManifestPath: options.caseManifestPath,
        title: options.title,
        channelName: options.channelName,
        modelId: options.modelId,
        providerModel: options.providerModel,
        model,
        goldenJsonPath: options.goldenJsonPath,
        goldenSubtitlePath: options.goldenSubtitlePath,
        chunkSeconds: options.chunkSeconds,
        llm:
          options.maxSegmentSeconds || options.coveragePrompt
            ? {
                ...(options.maxSegmentSeconds
                  ? { maxSegmentSeconds: options.maxSegmentSeconds }
                  : {}),
                ...(options.coveragePrompt
                  ? { verbatimCoveragePrompt: true }
                  : {}),
              }
            : undefined,
        keepAudioChunks: options.keepAudioChunks,
      },
    ],
  };
}

function assertConfigModeOptions(options: CliOptions): void {
  const unsupported: string[] = [];
  if (options.manifest) unsupported.push('--manifest');
  if (options.audio) unsupported.push('--audio');
  if (options.caseDir) unsupported.push('--case-dir');
  if (options.caseManifestPath) unsupported.push('--case-manifest');
  if (options.modelId) unsupported.push('--model-id');
  if (options.providerModel) unsupported.push('--provider-model');
  if (options.modelFile) unsupported.push('--model-file');
  if (options.goldenJsonPath) unsupported.push('--golden-json');
  if (options.goldenSubtitlePath) unsupported.push('--golden-subtitle');
  if (options.title) unsupported.push('--title');
  if (options.channelName) unsupported.push('--channel');
  if (unsupported.length > 0) {
    throw new Error(
      `--config cannot be combined with ${unsupported.join(', ')} in v1`,
    );
  }
}

function buildConfigManifest(
  configLoad: EvalConfigLoadResult,
  options: CliOptions,
): ManifestFile {
  assertConfigModeOptions(options);

  const { config, configSource, configSnapshot } = configLoad;
  const selectedTargets = options.caseId
    ? config.dataset.targets.filter((target) => target.id === options.caseId)
    : config.dataset.targets;
  if (selectedTargets.length === 0) {
    throw new Error(`eval config case not found: ${options.caseId}`);
  }

  const llmAligner = config.pipeline.llmAligner;
  const defaults: LlmAlignerEvalDefaults = {
    model: config.model,
    chunkSeconds: options.chunkSeconds ?? llmAligner.chunkSeconds,
    chunkConcurrency: options.chunkConcurrency ?? llmAligner.chunkConcurrency,
    aligner: config.aligner,
    llm: {
      maxSegmentSeconds:
        options.maxSegmentSeconds ?? llmAligner.maxSegmentSeconds,
      expectSpeakerLabels: llmAligner.expectSpeakerLabels,
      verbatimCoveragePrompt:
        options.coveragePrompt || llmAligner.verbatimCoveragePrompt,
    },
    keepAudioChunks: options.keepAudioChunks || config.run.keepAudioChunks,
    caseManifestPath: path.join(config.dataset.outputDir, 'manifest.json'),
    configSource,
    configSnapshot,
    ...(config.qualityGate ? { qualityGate: config.qualityGate } : {}),
  };

  return {
    outputRoot: options.outputRoot || config.run.outputRoot,
    concurrency: options.concurrency ?? config.run.concurrency,
    chunkConcurrency:
      options.chunkConcurrency ?? config.pipeline.llmAligner.chunkConcurrency,
    defaults,
    experiments: selectedTargets.map((target) => ({
      id: target.id,
      caseId: target.id,
      platform: target.platform,
      videoId: target.videoId,
    })),
  };
}

async function main(): Promise<void> {
  loadRepoEnv();

  const options = parseArgs(process.argv.slice(2));
  if (options.validateConfig) {
    if (!options.config) {
      throw new Error('--validate-config requires --config');
    }
    const configLoad = loadEvalConfig(options.config, { requireApiKey: false });
    const manifest = buildConfigManifest(configLoad, options);
    console.log(
      `[ok] eval config ${path.relative(process.cwd(), configLoad.configSource)} experiments=${manifest.experiments.length} outputRoot=${path.relative(process.cwd(), manifest.outputRoot || '')}`,
    );
    return;
  }

  const manifest = options.config
    ? buildConfigManifest(loadEvalConfig(options.config), options)
    : options.manifest
      ? readJsonFile<ManifestFile>(options.manifest)
      : buildSingleExperiment(options);

  const { runLlmAlignerManifest } = await import('./llm-aligner-pipeline');
  const results = await runLlmAlignerManifest({
    defaults: manifest.defaults,
    experiments: manifest.experiments,
    outputRoot: options.outputRoot || manifest.outputRoot,
    concurrency: options.concurrency ?? manifest.concurrency,
    chunkConcurrency: options.chunkConcurrency ?? manifest.chunkConcurrency,
  });

  let failed = 0;
  for (const entry of results) {
    if (entry.ok) {
      const { result } = entry;
      const quality = result.quality
        ? ` ncer=${result.quality.text.normalizedCharErrorRate} coverage=${result.quality.text.coverage} startMae=${result.quality.timing.startMaeSeconds ?? 'n/a'}s endMae=${result.quality.timing.endMaeSeconds ?? 'n/a'}s`
        : '';
      const qualityGate = result.qualityGateResult
        ? ` gate=${result.qualityGateResult.passed ? 'pass' : 'fail'}`
        : '';
      console.log(
        `[ok] ${result.id} segments=${result.summary.segmentCount} chunks=${result.summary.chunkCount} fallback=${result.summary.fallbackRatio}${quality}${qualityGate} out=${result.outputDir}`,
      );
    } else {
      failed += 1;
      console.error(`[failed] ${entry.id}: ${entry.error}`);
    }
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
