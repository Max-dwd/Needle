import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEvalConfig } from './config';

const envKeys = new Set<string>();

function withEnv(key: string, value: string): void {
  envKeys.add(key);
  process.env[key] = value;
}

function writeConfig(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'needle-eval-config-'));
  const filePath = path.join(dir, 'config.yaml');
  fs.writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

function baseConfig(overrides = ''): string {
  return `
dataset:
  outputDir: eval/data
  targets:
    - id: sample-case
      platform: youtube
      videoId: abc123
      url: https://www.youtube.com/watch?v=abc123
model:
  protocol: gemini
  endpoint: https://generativelanguage.googleapis.com/v1beta
  model: gemini-2.5-flash
  apiKeyEnv: NEEDLE_TEST_EVAL_KEY
${overrides}
`;
}

afterEach(() => {
  for (const key of envKeys) {
    delete process.env[key];
  }
  envKeys.clear();
});

describe('eval config loader', () => {
  it('resolves API key env references and normalizes defaults', () => {
    withEnv('NEEDLE_TEST_EVAL_KEY', 'secret-key');
    const loaded = loadEvalConfig(writeConfig(baseConfig()));

    expect(loaded.config.model.apiKey).toBe('secret-key');
    expect(loaded.config.model.protocol).toBe('gemini');
    expect(loaded.config.dataset.targets[0]?.id).toBe('sample-case');
    expect(loaded.config.pipeline.llmAligner.chunkSeconds).toBe(300);
  });

  it('supports dataset and per-target subtitle language constraints', () => {
    withEnv('NEEDLE_TEST_EVAL_KEY', 'secret-key');
    const loaded = loadEvalConfig(
      writeConfig(
        `
dataset:
  outputDir: eval/data
  expectedLanguage: en
  requireManualCaptions: true
  targets:
    - id: sample-case
      platform: youtube
      videoId: abc123
      url: https://www.youtube.com/watch?v=abc123
      expectedLanguage: zh
      requireManualCaptions: false
model:
  protocol: gemini
  endpoint: https://generativelanguage.googleapis.com/v1beta
  model: gemini-2.5-flash
  apiKeyEnv: NEEDLE_TEST_EVAL_KEY
`,
      ),
    );

    expect(loaded.config.dataset.expectedLanguage).toBe('en');
    expect(loaded.config.dataset.requireManualCaptions).toBe(true);
    expect(loaded.config.dataset.targets[0]?.expectedLanguage).toBe('zh');
    expect(loaded.config.dataset.targets[0]?.requireManualCaptions).toBe(false);
  });

  it('fails clearly when the configured API key env var is missing', () => {
    expect(() => loadEvalConfig(writeConfig(baseConfig()))).toThrow(
      /NEEDLE_TEST_EVAL_KEY/,
    );
  });

  it('fails clearly for invalid provider protocol values', () => {
    withEnv('NEEDLE_TEST_EVAL_KEY', 'secret-key');
    const configPath = writeConfig(
      baseConfig().replace('protocol: gemini', 'protocol: made-up'),
    );

    expect(() => loadEvalConfig(configPath)).toThrow(/model.protocol/);
  });

  it('keeps redacted snapshots free of the resolved API key', () => {
    withEnv('NEEDLE_TEST_EVAL_KEY', 'secret-key');
    const loaded = loadEvalConfig(writeConfig(baseConfig()));
    const snapshot = JSON.stringify(loaded.configSnapshot);

    expect(snapshot).toContain('[redacted]');
    expect(snapshot).toContain('NEEDLE_TEST_EVAL_KEY');
    expect(snapshot).not.toContain('secret-key');
  });
});
