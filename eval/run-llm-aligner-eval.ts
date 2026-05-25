#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
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
  manifest?: string;
  outputRoot?: string;
  concurrency?: number;
  chunkConcurrency?: number;
  audio?: string;
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

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const normalized = trimmed.startsWith('export ')
    ? trimmed.slice('export '.length).trimStart()
    : trimmed;
  const equalsIndex = normalized.indexOf('=');
  if (equalsIndex <= 0) return null;

  const key = normalized.slice(0, equalsIndex).trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) return null;

  let value = normalized.slice(equalsIndex + 1).trim();
  const quote = value[0];
  if (
    (quote === '"' || quote === "'") &&
    value.length >= 2 &&
    value[value.length - 1] === quote
  ) {
    value = value.slice(1, -1);
    if (quote === '"') {
      value = value
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
  } else {
    const hashIndex = value.indexOf('#');
    if (hashIndex >= 0) {
      value = value.slice(0, hashIndex).trimEnd();
    }
  }

  return [key, value];
}

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const entry = parseEnvLine(line);
    if (!entry) continue;
    const [key, value] = entry;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function loadRepoEnv(): void {
  const repoRoot = path.resolve(__dirname, '..');
  loadEnvFile(path.join(repoRoot, '.env.local'));
  loadEnvFile(path.join(repoRoot, '.env'));
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
  npm exec tsx -- eval/run-llm-aligner-eval.ts --manifest eval/llm-aligner-manifest.example.json

  npm exec tsx -- eval/run-llm-aligner-eval.ts \\
    --audio /path/to/audio.mp3 \\
    --id sample-a \\
    --model-id your-multimodal-model-id \\
    --chunk-seconds 300 \\
    --concurrency 2

Options:
  --manifest, -m             JSON manifest with experiments[]
  --output-root              Directory for run outputs (default: eval/runs)
  --concurrency, -c          Number of experiments to run in parallel
  --chunk-concurrency        Number of chunks to process in parallel per experiment
  --audio                    Single-experiment audio input
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
  if (!options.audio) {
    throw new Error('either --manifest or --audio is required');
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
          path.basename(options.audio, path.extname(options.audio)),
        audioPath: options.audio,
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

async function main(): Promise<void> {
  loadRepoEnv();

  const options = parseArgs(process.argv.slice(2));
  const manifest = options.manifest
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
      console.log(
        `[ok] ${result.id} segments=${result.summary.segmentCount} chunks=${result.summary.chunkCount} fallback=${result.summary.fallbackRatio}${quality} out=${result.outputDir}`,
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
