#!/usr/bin/env node

/**
 * Needle Intent Agent MCP Server
 *
 * Provides tools for external AI agents (Claude Code, Codex, etc.)
 * to access intent data, video subtitles, and manage agent artifacts.
 *
 * Usage:
 *   tsx src/mcp-server/index.ts
 *
 * Claude Code config (~/.claude.json or project .mcp.json):
 *   {
 *     "mcpServers": {
 *       "needle": {
 *         "command": "tsx",
 *         "args": ["src/mcp-server/index.ts"],
 *         "cwd": "/path/to/needle"
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  getAgentContext,
  searchVideos,
  readSubtitleText,
  saveArtifact,
  updateAgentMemory,
} from '../lib/intent-agent.js';
import { getDb, type Intent } from '../lib/db.js';

const server = new McpServer({
  name: 'needle',
  version: '1.0.0',
});

// ---------------------------------------------------------------------------
// Tool 1: get_intent_agent_context
// ---------------------------------------------------------------------------

server.tool(
  'get_intent_agent_context',
  'Get the full context for an intent agent: intent config, recent videos with raw subtitles, and past artifacts. This is the primary entry point for agent tasks.',
  {
    intent_id: z.number().optional().describe('Intent ID. Provide either intent_id or intent_name.'),
    intent_name: z.string().optional().describe('Intent name. Provide either intent_id or intent_name.'),
    days: z.number().optional().default(7).describe('Number of days of videos to include (default: 7)'),
    limit: z.number().optional().default(50).describe('Max number of videos (default: 50)'),
    include_subtitles: z.boolean().optional().default(true).describe('Include raw subtitle text for each video (default: true)'),
  },
  async (args) => {
    const db = getDb();

    let intentId = args.intent_id;
    if (!intentId && args.intent_name) {
      const intent = db
        .prepare('SELECT id FROM intents WHERE name = ?')
        .get(args.intent_name) as { id: number } | undefined;
      if (!intent) {
        return {
          content: [{ type: 'text' as const, text: `Intent "${args.intent_name}" not found.` }],
          isError: true,
        };
      }
      intentId = intent.id;
    }

    if (!intentId) {
      return {
        content: [{ type: 'text' as const, text: 'Provide either intent_id or intent_name.' }],
        isError: true,
      };
    }

    const context = getAgentContext(intentId, {
      days: args.days,
      limit: args.limit,
      includeSubtitles: args.include_subtitles,
    });

    if (!context) {
      return {
        content: [{ type: 'text' as const, text: `Intent ID ${intentId} not found.` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(context, null, 2) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool 2: search_videos
// ---------------------------------------------------------------------------

server.tool(
  'search_videos',
  'Search videos across all intents by keyword, platform, intent, or time range.',
  {
    keyword: z.string().optional().describe('Search in video titles'),
    platform: z.enum(['youtube', 'bilibili']).optional().describe('Filter by platform'),
    intent_name: z.string().optional().describe('Filter by intent name'),
    days: z.number().optional().describe('Only videos from the last N days'),
    limit: z.number().optional().default(20).describe('Max results (default: 20)'),
  },
  async (args) => {
    const results = searchVideos({
      keyword: args.keyword,
      platform: args.platform,
      intentName: args.intent_name,
      days: args.days,
      limit: args.limit,
    });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(results, null, 2),
      }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool 3: read_subtitle
// ---------------------------------------------------------------------------

server.tool(
  'read_subtitle',
  'Read the full raw subtitle text for a single video. Returns the plain text transcript.',
  {
    video_id: z.string().describe('The video ID (e.g. YouTube video ID)'),
    platform: z.enum(['youtube', 'bilibili']).describe('Video platform'),
  },
  async (args) => {
    const text = readSubtitleText(args.platform, args.video_id);
    if (!text) {
      return {
        content: [{ type: 'text' as const, text: `No subtitle found for ${args.platform}/${args.video_id}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text' as const, text }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool 4: save_artifact
// ---------------------------------------------------------------------------

server.tool(
  'save_artifact',
  'Save an agent output artifact (markdown file) to the intent\'s artifact directory. Use for daily digests, reports, recommendations, etc.',
  {
    intent_name: z.string().describe('Intent name (used as directory name)'),
    filename: z.string().describe('Filename for the artifact, e.g. "2026-04-09-digest.md"'),
    content: z.string().describe('Markdown content of the artifact'),
  },
  async (args) => {
    try {
      const filePath = saveArtifact(args.intent_name, args.filename, args.content);
      return {
        content: [{ type: 'text' as const, text: `Artifact saved: ${filePath}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to save artifact: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 5: update_memory
// ---------------------------------------------------------------------------

server.tool(
  'update_memory',
  'Read or update the persistent memory for an intent agent. Memory persists across agent runs and can store user preferences, learned patterns, etc.',
  {
    intent_id: z.number().optional().describe('Intent ID. Provide either intent_id or intent_name.'),
    intent_name: z.string().optional().describe('Intent name.'),
    memory: z.string().optional().describe('New memory content to save. Omit to read current memory.'),
  },
  async (args) => {
    const db = getDb();

    // Consistent with get_intent_agent_context: id takes priority over name
    let intentId = args.intent_id;
    if (!intentId && args.intent_name) {
      const row = db
        .prepare('SELECT id FROM intents WHERE name = ?')
        .get(args.intent_name) as { id: number } | undefined;
      if (!row) {
        return {
          content: [{ type: 'text' as const, text: `Intent "${args.intent_name}" not found.` }],
          isError: true,
        };
      }
      intentId = row.id;
    }

    if (!intentId) {
      return {
        content: [{ type: 'text' as const, text: 'Provide either intent_id or intent_name.' }],
        isError: true,
      };
    }

    const intentRow = db
      .prepare('SELECT * FROM intents WHERE id = ?')
      .get(intentId) as Intent | undefined;

    if (!intentRow) {
      return {
        content: [{ type: 'text' as const, text: `Intent ID ${intentId} not found.` }],
        isError: true,
      };
    }

    // Read mode
    if (args.memory === undefined) {
      return {
        content: [{
          type: 'text' as const,
          text: intentRow.agent_memory || '(no memory stored)',
        }],
      };
    }

    // Write mode
    updateAgentMemory(intentId, args.memory);
    return {
      content: [{ type: 'text' as const, text: 'Memory updated.' }],
    };
  },
);

// ---------------------------------------------------------------------------
// Resource: list all intents with agent config
// ---------------------------------------------------------------------------

server.resource(
  'intents',
  'needle://intents',
  async () => ({
    contents: [{
      uri: 'needle://intents',
      mimeType: 'application/json',
      text: JSON.stringify(
        (getDb()
          .prepare('SELECT id, name, agent_prompt, agent_trigger, agent_schedule_time, agent_memory FROM intents ORDER BY sort_order ASC, id ASC')
          .all() as Intent[]),
        null,
        2,
      ),
    }],
  }),
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Needle MCP Server failed to start:', err);
  process.exit(1);
});
