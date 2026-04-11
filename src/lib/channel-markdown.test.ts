import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, Intent } from '@/lib/db';

vi.mock('@/lib/fetcher', () => ({
  parseBilibiliUid: vi.fn(),
  resolveChannelFromUrl: vi.fn(),
  resolveYouTubeChannelId: vi.fn(),
}));

import {
  exportChannelsToMarkdown,
  importChannelsFromMarkdown,
} from '@/lib/channel-markdown';

function createChannel(overrides: Partial<Channel>): Channel {
  return {
    id: 1,
    platform: 'youtube',
    channel_id: 'UC123',
    name: 'Default Channel',
    avatar_url: null,
    intent: '未分类',
    topics: [],
    category: '',
    category2: '',
    crawl_error_count: 0,
    crawl_backoff_until: null,
    created_at: '2026-03-23T12:00:00.000Z',
    ...overrides,
  };
}

function createIntent(overrides: Partial<Intent>): Intent {
  return {
    id: 1,
    name: '工作',
    auto_subtitle: 1,
    auto_summary: 1,
    sort_order: 0,
    auto_summary_model_id: null,
    agent_prompt: null,
    agent_trigger: null,
    agent_schedule_time: '09:00',
    agent_memory: null,
    created_at: '2026-03-23T12:00:00.000Z',
    ...overrides,
  };
}

const DEFAULT_INTENTS: Intent[] = [
  createIntent({ id: 1, name: '工作', sort_order: 0 }),
  createIntent({ id: 2, name: '娱乐', sort_order: 1 }),
  createIntent({ id: 3, name: '探索', sort_order: 2 }),
  createIntent({ id: 4, name: '新闻', sort_order: 3 }),
  createIntent({ id: 5, name: '未分类', sort_order: 99 }),
];

describe('exportChannelsToMarkdown', () => {
  it('renders header for empty channel list', () => {
    expect(exportChannelsToMarkdown([], DEFAULT_INTENTS)).toBe(
      '# Needle Subscriptions\n\n',
    );
  });

  it('renders a single YouTube channel under 未分类', () => {
    const markdown = exportChannelsToMarkdown(
      [
        createChannel({
          platform: 'youtube',
          channel_id: 'UCabc',
          name: 'Alpha Channel',
          intent: '未分类',
          topics: [],
        }),
      ],
      DEFAULT_INTENTS,
    );
    expect(markdown).toContain('## 未分类');
    expect(markdown).toContain(
      '- [Alpha Channel](https://www.youtube.com/channel/UCabc) `youtube:UCabc`',
    );
  });

  it('renders YouTube handles with @ URLs', () => {
    const markdown = exportChannelsToMarkdown(
      [
        createChannel({
          platform: 'youtube',
          channel_id: '@hubermanlab',
          name: 'Andrew Huberman',
          intent: '未分类',
          topics: [],
        }),
      ],
      DEFAULT_INTENTS,
    );
    expect(markdown).toContain(
      '- [Andrew Huberman](https://www.youtube.com/@hubermanlab) `youtube:@hubermanlab`',
    );
  });

  it('renders channel with topics as hashtags', () => {
    const markdown = exportChannelsToMarkdown(
      [
        createChannel({
          platform: 'youtube',
          channel_id: 'UCxyz',
          name: 'Tech Channel',
          intent: '工作',
          topics: ['AI', '科技'],
        }),
      ],
      DEFAULT_INTENTS,
    );
    expect(markdown).toContain('## 工作');
    expect(markdown).toContain(
      '- [Tech Channel](https://www.youtube.com/channel/UCxyz) `youtube:UCxyz` #AI #科技',
    );
  });

  it('channels with empty topics have no #tag suffixes', () => {
    const markdown = exportChannelsToMarkdown(
      [
        createChannel({
          platform: 'youtube',
          channel_id: 'UCempty',
          name: 'No Topics Channel',
          intent: '娱乐',
          topics: [],
        }),
      ],
      DEFAULT_INTENTS,
    );
    expect(markdown).toContain('## 娱乐');
    expect(markdown).toContain(
      '- [No Topics Channel](https://www.youtube.com/channel/UCempty) `youtube:UCempty`',
    );
    // The line above should not have any #topic hashtags after the backtick
    const channelLine = markdown.split('\n').find(l => l.includes('No Topics Channel'))!;
    expect(channelLine).not.toContain(' #');
  });

  it('channels within a group are sorted alphabetically by name', () => {
    const markdown = exportChannelsToMarkdown(
      [
        createChannel({
          id: 1,
          platform: 'youtube',
          channel_id: 'UCz',
          name: 'Zebra Channel',
          intent: '工作',
          topics: [],
        }),
        createChannel({
          id: 2,
          platform: 'youtube',
          channel_id: 'UCa',
          name: 'Alpha Channel',
          intent: '工作',
          topics: [],
        }),
        createChannel({
          id: 3,
          platform: 'youtube',
          channel_id: 'UCm',
          name: 'Middle Channel',
          intent: '工作',
          topics: [],
        }),
      ],
      DEFAULT_INTENTS,
    );
    const workSection = markdown.split('## 工作')[1].split('##')[0];
    const names = workSection
      .match(/\[([^\]]+)\]/g)!
      .map((n) => n.slice(1, -1));
    expect(names).toEqual(['Alpha Channel', 'Middle Channel', 'Zebra Channel']);
  });

  it('intent headings are ordered by sort_order with 未分类 last', () => {
    const markdown = exportChannelsToMarkdown(
      [
        createChannel({ platform: 'youtube', channel_id: 'UC1', name: 'A', intent: '未分类', topics: [] }),
        createChannel({ platform: 'youtube', channel_id: 'UC2', name: 'B', intent: '工作', topics: [] }),
        createChannel({ platform: 'youtube', channel_id: 'UC3', name: 'C', intent: '新闻', topics: [] }),
        createChannel({ platform: 'youtube', channel_id: 'UC4', name: 'D', intent: '娱乐', topics: [] }),
      ],
      DEFAULT_INTENTS,
    );
    const idx1 = markdown.indexOf('## 工作');
    const idx2 = markdown.indexOf('## 娱乐');
    const idx3 = markdown.indexOf('## 新闻');
    const idx4 = markdown.indexOf('## 未分类');
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
    expect(idx3).toBeLessThan(idx4);
  });

  it('renders Bilibili channel with correct URL', () => {
    const markdown = exportChannelsToMarkdown(
      [
        createChannel({
          platform: 'bilibili',
          channel_id: '12345678',
          name: 'B站频道',
          intent: '娱乐',
          topics: ['动漫'],
        }),
      ],
      DEFAULT_INTENTS,
    );
    expect(markdown).toContain(
      '- [B站频道](https://space.bilibili.com/12345678) `bilibili:12345678` #动漫',
    );
  });

  it('only includes intents that have channels', () => {
    const markdown = exportChannelsToMarkdown(
      [
        createChannel({
          platform: 'youtube',
          channel_id: 'UCw',
          name: 'Work Channel',
          intent: '工作',
          topics: [],
        }),
      ],
      DEFAULT_INTENTS,
    );
    expect(markdown).toContain('## 工作');
    expect(markdown).not.toContain('## 娱乐');
    expect(markdown).not.toContain('## 探索');
    expect(markdown).not.toContain('## 新闻');
    // 未分类 is only rendered if there are channels with that intent
    // Since we have no 未分类 channels, it should not appear
    expect(markdown).not.toContain('## 未分类');
  });

  it('escapes special markdown characters in channel names', () => {
    const markdown = exportChannelsToMarkdown(
      [
        createChannel({
          platform: 'youtube',
          channel_id: 'UCtest',
          name: 'Test [Channel] (2024)',
          intent: '工作',
          topics: [],
        }),
      ],
      DEFAULT_INTENTS,
    );
    // The channel name "Test [Channel] (2024)" should be escaped as "Test \[Channel\] \(2024\)"
    // inside the markdown link syntax: [name](url)
    expect(markdown).toContain('Test \\[Channel\\] \\(2024\\)');
  });
});

describe('importChannelsFromMarkdown - new format', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockDb: any;

  beforeEach(() => {
    mockDb = () => ({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(undefined),
        run: vi.fn(),
      }),
    });
  });

  it('parses new format with ## intent headings', async () => {
    const markdown = `# Needle Subscriptions

## 工作
- [Alpha](https://www.youtube.com/channel/UCabc) \`youtube:UCabc\` #AI #科技

## 未分类
- [Beta](https://space.bilibili.com/123456) \`bilibili:123456\`
`;

    const results = await importChannelsFromMarkdown(markdown, mockDb);

    expect(results).toHaveLength(2);
    const yt = results.find((r) => r.platform === 'youtube')!;
    expect(yt.channel_id).toBe('UCabc');
    expect(yt.name).toBe('Alpha');
    expect(yt.intent).toBe('工作');
    expect(yt.topics).toEqual(['AI', '科技']);

    const bili = results.find((r) => r.platform === 'bilibili')!;
    expect(bili.channel_id).toBe('123456');
    expect(bili.name).toBe('Beta');
    expect(bili.intent).toBe('未分类');
    expect(bili.topics).toEqual([]);
  });

  it('parses backtick platform:channel_id correctly', async () => {
    const markdown = `# Needle Subscriptions

## 测试
- [Test](https://www.youtube.com/watch?v=abc) \`youtube:UCtest123\`
`;

    const results = await importChannelsFromMarkdown(markdown, mockDb);

    expect(results).toHaveLength(1);
    expect(results[0].platform).toBe('youtube');
    expect(results[0].channel_id).toBe('UCtest123');
  });

  it('parses topics as hashtags at end of line', async () => {
    const markdown = `# Needle Subscriptions

## 工作
- [Channel](https://www.youtube.com/channel/UCw) \`youtube:UCw\` #标签1 #标签2 #标签3
`;

    const results = await importChannelsFromMarkdown(markdown, mockDb);

    expect(results[0].topics).toEqual(['标签1', '标签2', '标签3']);
  });

  it('deduplicates channels by platform:channel_id', async () => {
    const markdown = `# Needle Subscriptions

## 工作
- [First](https://www.youtube.com/channel/UCdup) \`youtube:UCdup\`
- [Second](https://www.youtube.com/channel/UCdup) \`youtube:UCdup\`
`;

    const results = await importChannelsFromMarkdown(markdown, mockDb);

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('First');
  });

  it('auto-creates unknown intent on import', async () => {
    const markdown = `# Needle Subscriptions

## 新建意图
- [Channel](https://www.youtube.com/channel/UCnew) \`youtube:UCnew\`
`;

    const prepareMock = vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue(undefined), // intent not found
      run: vi.fn(),
    });
    mockDb = () => ({ prepare: prepareMock });

    await importChannelsFromMarkdown(markdown, mockDb);

    // Should have called prepare to check intent and create it
    expect(prepareMock).toHaveBeenCalledWith('SELECT id FROM intents WHERE name = ?');
    expect(prepareMock).toHaveBeenCalledWith(
      'INSERT INTO intents (name, auto_subtitle, auto_summary, sort_order) VALUES (?, 0, 0, ?)',
    );
  });

  it('uses existing intent without creating new one', async () => {
    const markdown = `# Needle Subscriptions

## 工作
- [Channel](https://www.youtube.com/channel/UCex) \`youtube:UCex\`
`;

    const prepareMock = vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue({ id: 1 }), // existing intent found
      run: vi.fn(),
    });
    mockDb = () => ({ prepare: prepareMock });

    await importChannelsFromMarkdown(markdown, mockDb);

    // Should have checked intent but not inserted
    expect(prepareMock).toHaveBeenCalledWith('SELECT id FROM intents WHERE name = ?');
    // No insert call for intent creation
    const insertCalls = prepareMock.mock.calls.filter(
      (call: unknown[]) => (call[0] as string).includes('INSERT INTO intents'),
    );
    expect(insertCalls).toHaveLength(0);
  });
});

describe('importChannelsFromMarkdown - old format backward compatibility', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockDb: any;

  beforeEach(() => {
    mockDb = () => ({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(undefined),
        run: vi.fn(),
      }),
    });
  });

  it('detects old format with ## YouTube heading', async () => {
    const markdown = `# 订阅导出

- YouTube
  - 科技
    - [Tech Channel](https://www.youtube.com/channel/UCtech) \`youtube:UCtech\`
- Bilibili
  - 未分类
`;

    const results = await importChannelsFromMarkdown(markdown, mockDb);

    expect(results).toHaveLength(1);
    expect(results[0].platform).toBe('youtube');
    expect(results[0].channel_id).toBe('UCtech');
    expect(results[0].intent).toBe('未分类');
    expect(results[0].topics).toEqual(['科技']);
  });

  it('detects old format with ## Bilibili heading', async () => {
    const markdown = `# 订阅导出

- YouTube
  - 未分类
- Bilibili
  - 动漫
    - [B站频道](https://space.bilibili.com/123) \`bilibili:123\`
`;

    const results = await importChannelsFromMarkdown(markdown, mockDb);

    expect(results).toHaveLength(1);
    expect(results[0].platform).toBe('bilibili');
    expect(results[0].channel_id).toBe('123');
    expect(results[0].intent).toBe('未分类');
    expect(results[0].topics).toEqual(['动漫']);
  });

  it('maps old categories to topics in old format', async () => {
    const markdown = `# 订阅导出

- YouTube
  - 科技
    - AI
      - [AI Channel](https://www.youtube.com/channel/UCai) \`youtube:UCai\`
`;

    const results = await importChannelsFromMarkdown(markdown, mockDb);

    expect(results[0].intent).toBe('未分类');
    expect(results[0].topics).toEqual(['科技', 'AI']);
  });

  it('excludes 未分类 as a topic in old format', async () => {
    const markdown = `# 订阅导出

- YouTube
  - 未分类
    - [Channel](https://www.youtube.com/channel/UCunc) \`youtube:UCunc\`
`;

    const results = await importChannelsFromMarkdown(markdown, mockDb);

    expect(results[0].intent).toBe('未分类');
    expect(results[0].topics).toEqual([]);
  });
});

describe('round-trip data integrity', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockDb: any;

  beforeEach(() => {
    mockDb = () => ({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({ id: 1 }), // all intents exist
        run: vi.fn(),
      }),
    });
  });

  it('round-trip with Markdown special characters in channel names', async () => {
    const channels: Channel[] = [
      createChannel({
        platform: 'youtube',
        channel_id: 'UCspecial',
        name: 'Chan [1]',
        intent: '工作',
        topics: [],
      }),
      createChannel({
        platform: 'bilibili',
        channel_id: '999888777',
        name: 'Test (2024) Channel',
        intent: '娱乐',
        topics: ['AI'],
      }),
    ];

    const exported = exportChannelsToMarkdown(channels, DEFAULT_INTENTS);
    // Verify export has escaped names
    expect(exported).toContain('Chan \\[1\\]');
    expect(exported).toContain('Test \\(2024\\) Channel');

    const imported = await importChannelsFromMarkdown(exported, mockDb);

    expect(imported).toHaveLength(2);

    const ch1 = imported.find((r) => r.channel_id === 'UCspecial')!;
    expect(ch1.name).toBe('Chan [1]'); // Unescaped back to original
    expect(ch1.intent).toBe('工作');

    const ch2 = imported.find((r) => r.channel_id === '999888777')!;
    expect(ch2.name).toBe('Test (2024) Channel'); // Unescaped back to original
    expect(ch2.topics).toContain('AI');
  });

  it('export then import preserves intent, topics, platform, channel_id, name', async () => {
    const channels: Channel[] = [
      createChannel({
        id: 1,
        platform: 'youtube',
        channel_id: 'UCroundtrip',
        name: 'Roundtrip Channel',
        intent: '工作',
        topics: ['AI', '科技'],
      }),
      createChannel({
        id: 2,
        platform: 'bilibili',
        channel_id: '777888999',
        name: '循环测试频道',
        intent: '未分类',
        topics: [],
      }),
    ];

    const exported = exportChannelsToMarkdown(channels, DEFAULT_INTENTS);
    const imported = await importChannelsFromMarkdown(exported, mockDb);

    expect(imported).toHaveLength(2);

    const yt = imported.find((r) => r.platform === 'youtube')!;
    expect(yt.channel_id).toBe('UCroundtrip');
    expect(yt.name).toBe('Roundtrip Channel');
    expect(yt.intent).toBe('工作');
    expect(yt.topics).toContain('AI');
    expect(yt.topics).toContain('科技');

    const bili = imported.find((r) => r.platform === 'bilibili')!;
    expect(bili.channel_id).toBe('777888999');
    expect(bili.name).toBe('循环测试频道');
    expect(bili.intent).toBe('未分类');
  });

  it('round-trip preserves topics order (order-independent comparison)', async () => {
    const channels: Channel[] = [
      createChannel({
        platform: 'youtube',
        channel_id: 'UCtopic',
        name: 'Topic Channel',
        intent: '探索',
        topics: ['first', 'second', 'third'],
      }),
    ];

    const exported = exportChannelsToMarkdown(channels, DEFAULT_INTENTS);
    const imported = await importChannelsFromMarkdown(exported, mockDb);

    expect(imported[0].topics.sort()).toEqual(['first', 'second', 'third'].sort());
  });
});
