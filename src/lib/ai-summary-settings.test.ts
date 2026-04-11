import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadSettingsModule(dbPath: string) {
  process.env.DATABASE_PATH = dbPath;
  vi.resetModules();
  return import('./ai-summary-settings');
}

describe('ai-summary-settings', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    vi.resetModules();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies top-level endpoint/model/apiKey to the selected default model', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folo-ai-settings-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'test.db');

    const { setAiSummarySettings, getAiSummarySettings } =
      await loadSettingsModule(dbPath);

    setAiSummarySettings({
      models: [
        {
          id: 'default',
          name: '默认模型',
          endpoint: 'https://old.example.com/v1',
          apiKey: 'old-key',
          model: 'old-model',
        },
        {
          id: 'backup',
          name: '备用模型',
          endpoint: 'https://backup.example.com/v1',
          apiKey: 'backup-key',
          model: 'backup-model',
        },
      ],
      defaultModelId: 'default',
      autoDefaultModelId: 'backup',
    });

    setAiSummarySettings({
      endpoint: 'https://new.example.com/v1',
      apiKey: 'new-key',
      model: 'new-model',
      models: [
        {
          id: 'default',
          name: '默认模型',
          endpoint: 'https://old.example.com/v1',
          apiKey: '',
          model: 'old-model',
        },
        {
          id: 'backup',
          name: '备用模型',
          endpoint: 'https://backup.example.com/v1',
          apiKey: '',
          model: 'backup-model',
        },
      ],
      defaultModelId: 'default',
      autoDefaultModelId: 'backup',
    });

    const settings = getAiSummarySettings();

    expect(settings.endpoint).toBe('https://new.example.com/v1');
    expect(settings.apiKey).toBe('new-key');
    expect(settings.model).toBe('new-model');
    expect(settings.models.find((item) => item.id === 'default')).toMatchObject({
      endpoint: 'https://new.example.com/v1',
      apiKey: 'new-key',
      model: 'new-model',
    });
    expect(settings.models.find((item) => item.id === 'backup')).toMatchObject({
      endpoint: 'https://backup.example.com/v1',
      apiKey: 'backup-key',
      model: 'backup-model',
    });
  });

  it('fills shared AI budget defaults and persists custom values', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folo-ai-settings-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'test.db');

    const { setAiSummarySettings, getAiSummarySettings } =
      await loadSettingsModule(dbPath);

    const defaults = getAiSummarySettings();
    expect(defaults.sharedRequestsPerMinute).toBe(10);
    expect(defaults.sharedRequestsPerDay).toBe(1000);
    expect(defaults.sharedTokensPerMinute).toBe(1000000);
    expect(defaults.subtitleFallbackTokenReserve).toBe(120000);

    setAiSummarySettings({
      sharedRequestsPerMinute: 7,
      sharedRequestsPerDay: 321,
      sharedTokensPerMinute: 345678,
      subtitleFallbackTokenReserve: 98765,
    });

    const settings = getAiSummarySettings();
    expect(settings.sharedRequestsPerMinute).toBe(7);
    expect(settings.sharedRequestsPerDay).toBe(321);
    expect(settings.sharedTokensPerMinute).toBe(345678);
    expect(settings.subtitleFallbackTokenReserve).toBe(98765);
  });

  it('fills subtitle API prompt template defaults and persists custom values', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folo-ai-settings-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'test.db');

    const {
      DEFAULT_AI_SUBTITLE_PROMPT_TEMPLATE,
      setAiSummarySettings,
      getAiSummarySettings,
    } = await loadSettingsModule(dbPath);

    const defaults = getAiSummarySettings();
    expect(defaults.subtitleApiPromptTemplate).toBe(
      DEFAULT_AI_SUBTITLE_PROMPT_TEMPLATE,
    );

    setAiSummarySettings({
      subtitleApiPromptTemplate: '请输出更紧凑的逐段字幕。',
    });

    const settings = getAiSummarySettings();
    expect(settings.subtitleApiPromptTemplate).toBe(
      '请输出更紧凑的逐段字幕。',
    );
    expect(settings.promptTemplates.subtitleApi).toBe(
      '请输出更紧凑的逐段字幕。',
    );
  });

  it('ensures summary prompt templates always include the subtitle placeholder', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folo-ai-settings-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'test.db');

    const { setAiSummarySettings, getAiSummarySettings } =
      await loadSettingsModule(dbPath);

    setAiSummarySettings({
      promptTemplate: '请总结视频要点，不要遗漏关键信息。',
    });

    const settings = getAiSummarySettings();
    expect(settings.promptTemplate).toContain('{{subtitle}}');
    expect(settings.promptTemplate).toContain('字幕内容：');
  });

  it('fills subtitle segmented prompt template defaults and persists custom values', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folo-ai-settings-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'test.db');

    const {
      DEFAULT_AI_SUBTITLE_SEGMENT_PROMPT_TEMPLATE,
      setAiSummarySettings,
      getAiSummarySettings,
    } = await loadSettingsModule(dbPath);

    const defaults = getAiSummarySettings();
    expect(defaults.subtitleSegmentPromptTemplate).toBe(
      DEFAULT_AI_SUBTITLE_SEGMENT_PROMPT_TEMPLATE,
    );

    setAiSummarySettings({
      promptTemplates: {
        subtitleSegment: '只处理当前切片，时间戳从 00:00 开始。',
      },
    });

    const settings = getAiSummarySettings();
    expect(settings.subtitleSegmentPromptTemplate).toBe(
      '只处理当前切片，时间戳从 00:00 开始。',
    );
    expect(settings.promptTemplates.subtitleSegment).toBe(
      '只处理当前切片，时间戳从 00:00 开始。',
    );
  });
});
