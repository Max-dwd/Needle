/**
 * Intent Agent Runner
 *
 * Executes intent agents by calling the configured AI model with the
 * agent's prompt + video context, then saving the output as an artifact.
 *
 * Trigger modes:
 *   - `daily`: checked every minute by the scheduler, fires at agent_schedule_time
 *   - `on_new_videos`: fires (debounced) when new videos are discovered for an intent
 *   - `manual`: only via MCP or future UI button
 */

import { getDb, type Intent } from './db';
import { appEvents } from './events';
import { log } from './logger';
import {
  getAgentContext,
  saveArtifact,
  type AgentContext,
} from './intent-agent';
import {
  resolveChatCompletionsUrl,
  createChatCompletionRequest,
} from './ai-summary-client';
import { resolveAiSummaryGenerationSettings } from './ai-summary-settings';
import {
  acquireSharedAiBudget,
  estimateTextTokens,
} from './shared-ai-budget';

// ---------------------------------------------------------------------------
// Singleton state (survives Next.js HMR)
// ---------------------------------------------------------------------------

interface AgentRunnerState {
  initialized: boolean;
  dailyTimer: ReturnType<typeof setTimeout> | null;
  pendingNewVideoRuns: Map<string, ReturnType<typeof setTimeout>>;
  runningAgents: Set<string>; // intent names currently executing
}

const globalKey = Symbol.for('folo-intent-agent-runner');

function getState(): AgentRunnerState {
  const g = globalThis as Record<symbol, AgentRunnerState | undefined>;
  if (!g[globalKey]) {
    g[globalKey] = {
      initialized: false,
      dailyTimer: null,
      pendingNewVideoRuns: new Map(),
      runningAgents: new Set(),
    };
  }
  return g[globalKey]!;
}

// ---------------------------------------------------------------------------
// Debounce delay for on_new_videos trigger (seconds)
// ---------------------------------------------------------------------------

const NEW_VIDEOS_DEBOUNCE_MS = 60_000; // 1 minute — let burst settle

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export function ensureIntentAgentRunner(): void {
  const state = getState();
  if (state.initialized) return;
  state.initialized = true;

  // Start the daily check loop
  scheduleDailyCheck();

  // Listen for new videos (for on_new_videos trigger)
  appEvents.on('video:discovered', onVideoDiscovered);

  log.info('agent', 'initialized');
}

export function stopIntentAgentRunner(): void {
  const state = getState();
  if (state.dailyTimer) {
    clearTimeout(state.dailyTimer);
    state.dailyTimer = null;
  }
  for (const timer of state.pendingNewVideoRuns.values()) {
    clearTimeout(timer);
  }
  state.pendingNewVideoRuns.clear();
  state.initialized = false;
}

// ---------------------------------------------------------------------------
// Daily trigger — check every 60s if any intent's schedule time matches now
// ---------------------------------------------------------------------------

function scheduleDailyCheck(): void {
  const state = getState();
  if (state.dailyTimer) clearTimeout(state.dailyTimer);

  // Align to the next full minute boundary for cleaner timing
  const nowMs = Date.now();
  const msUntilNextMinute = 60_000 - (nowMs % 60_000);

  state.dailyTimer = setTimeout(() => {
    checkDailyIntents();
    scheduleDailyCheck(); // re-arm
  }, msUntilNextMinute);
}

function checkDailyIntents(): void {
  try {
    const db = getDb();
    const now = new Date();
    const currentHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const intents = db
      .prepare(
        `SELECT * FROM intents
         WHERE agent_trigger = 'daily'
           AND agent_prompt IS NOT NULL
           AND agent_prompt != ''
           AND agent_schedule_time = ?`,
      )
      .all(currentHHMM) as Intent[];

    for (const intent of intents) {
      triggerAgentRun(intent, 'daily');
    }
  } catch (err) {
    log.error('agent', 'daily-check-error', { error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// on_new_videos trigger — debounced per intent
// ---------------------------------------------------------------------------

function onVideoDiscovered(event: { channelId: string }): void {
  try {
    const db = getDb();

    // Resolve channel → intent
    const channel = db
      .prepare('SELECT intent FROM channels WHERE channel_id = ?')
      .get(event.channelId) as { intent: string } | undefined;
    if (!channel?.intent) return;

    const intent = db
      .prepare(
        `SELECT * FROM intents
         WHERE name = ?
           AND agent_trigger = 'on_new_videos'
           AND agent_prompt IS NOT NULL
           AND agent_prompt != ''`,
      )
      .get(channel.intent) as Intent | undefined;
    if (!intent) return;

    // Debounce: reset timer for this intent
    const state = getState();
    const existing = state.pendingNewVideoRuns.get(intent.name);
    if (existing) clearTimeout(existing);

    state.pendingNewVideoRuns.set(
      intent.name,
      setTimeout(() => {
        state.pendingNewVideoRuns.delete(intent.name);
        triggerAgentRun(intent, 'on_new_videos');
      }, NEW_VIDEOS_DEBOUNCE_MS),
    );
  } catch (err) {
    log.error('agent', 'on-new-videos-error', { error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Core: trigger an agent run (skip if already running for this intent)
// ---------------------------------------------------------------------------

function triggerAgentRun(intent: Intent, source: string): void {
  const state = getState();
  if (state.runningAgents.has(intent.name)) {
    log.info('agent', 'skipped-already-running', { intent: intent.name });
    return;
  }

  // Fire-and-forget; errors are logged internally
  void runIntentAgent(intent, source);
}

// ---------------------------------------------------------------------------
// Core: execute the agent
// ---------------------------------------------------------------------------

export async function runIntentAgent(
  intent: Intent,
  source: string = 'manual',
): Promise<string | null> {
  const state = getState();
  state.runningAgents.add(intent.name);

  appEvents.emit('agent:start', {
    intentId: intent.id,
    intentName: intent.name,
    source,
    at: new Date().toISOString(),
  });

  try {
    if (!intent.agent_prompt) {
      throw new Error('agent_prompt is empty');
    }

    // 1. Build context
    const ctx = getAgentContext(intent.id, {
      days: 7,
      limit: 50,
      includeSubtitles: true,
    });
    if (!ctx) throw new Error(`intent ${intent.id} not found`);

    // 2. Build prompts
    const systemPrompt = buildSystemPrompt(intent);
    const userPrompt = buildUserPrompt(ctx);
    const fullPrompt = systemPrompt + '\n' + userPrompt;

    // 3. Resolve model (respects per-intent auto_summary_model_id)
    const { selectedModel } = resolveAiSummaryGenerationSettings({
      modelIdOverride: intent.auto_summary_model_id,
      triggerSource: 'auto',
      intentName: intent.name,
    });

    // 4. Acquire shared AI budget
    const budgetLease = await acquireSharedAiBudget({
      priority: 'auto-summary',
      estimatedTokens: estimateTextTokens(fullPrompt),
      label: `agent:${intent.name}`,
    });

    let responseText: string;
    try {
      // 5. Call AI
      const url = resolveChatCompletionsUrl(selectedModel.endpoint);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${selectedModel.apiKey}`,
        },
        body: JSON.stringify(
          createChatCompletionRequest(
            { system: systemPrompt, user: userPrompt },
            selectedModel,
          ),
        ),
        signal: AbortSignal.timeout(5 * 60 * 1000),
      });

      const raw = await response.text();
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // not JSON
      }

      if (!response.ok) {
        const errMsg = parsed
          ? ((parsed as { error?: { message?: string } }).error?.message || raw.slice(0, 300))
          : raw.slice(0, 300);
        throw new Error(`AI API error: ${errMsg}`);
      }

      if (!parsed) throw new Error('AI returned invalid JSON');

      // Extract text from OpenAI-compatible response
      const choices = Array.isArray((parsed as { choices?: unknown[] }).choices)
        ? ((parsed as { choices: Array<{ message?: { content?: string } }> }).choices)
        : [];
      responseText = choices[0]?.message?.content?.trim() || '';
      if (!responseText) throw new Error('AI returned empty content');

      // Release budget with actual token count
      const usage = (parsed as { usage?: { total_tokens?: number } }).usage;
      budgetLease.release(usage?.total_tokens);
    } catch (err) {
      budgetLease.release();
      throw err;
    }

    // 6. Save artifact
    const now = new Date();
    const datePart = now.toISOString().slice(0, 10);
    const timePart = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const filename = `${datePart}-${timePart}-${source}.md`;
    saveArtifact(intent.name, filename, responseText);

    log.info('agent', 'completed', { intent: intent.name, source, filename });

    appEvents.emit('agent:complete', {
      intentId: intent.id,
      intentName: intent.name,
      source,
      filename,
      at: new Date().toISOString(),
    });

    return responseText;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('agent', 'failed', { intent: intent.name, source, error: message });

    appEvents.emit('agent:error', {
      intentId: intent.id,
      intentName: intent.name,
      source,
      error: message,
      at: new Date().toISOString(),
    });

    return null;
  } finally {
    state.runningAgents.delete(intent.name);
  }
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function buildSystemPrompt(intent: Intent): string {
  const parts = [
    `你是一个名为「${intent.name}」的意图 agent。`,
    '用户订阅了若干视频频道，这些频道被分组到该意图下。',
    '你的任务是根据以下指令处理最近的视频内容，并生成 Markdown 格式的报告。',
  ];

  if (intent.agent_memory) {
    parts.push('', '## 你的记忆（上次运行保存的笔记）', intent.agent_memory);
  }

  parts.push('', '## 用户指令', intent.agent_prompt || '（无指令）');

  return parts.join('\n');
}

function buildUserPrompt(ctx: AgentContext): string {
  const parts: string[] = ['# 最近视频'];

  if (ctx.videos.length === 0) {
    parts.push('（最近 7 天没有新视频）');
    return parts.join('\n');
  }

  for (const v of ctx.videos) {
    parts.push('');
    parts.push(`## ${v.title || '(无标题)'}`);
    parts.push(`- 频道: ${v.channel_name || '未知'}`);
    parts.push(`- 平台: ${v.platform}`);
    parts.push(`- 发布时间: ${v.published_at || '未知'}`);
    if (v.has_summary) parts.push('- 已有摘要');

    if (v.subtitle_text) {
      // Truncate very long subtitles to avoid blowing up context
      const maxChars = 8000;
      const text =
        v.subtitle_text.length > maxChars
          ? v.subtitle_text.slice(0, maxChars) + '\n...(字幕已截断)'
          : v.subtitle_text;
      parts.push('', '### 字幕内容', '```', text, '```');
    }
  }

  return parts.join('\n');
}
