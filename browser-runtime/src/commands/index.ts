import type { IPage } from '../types.js';
import {
  runBilibiliChannelInfo,
  runBilibiliFollowing,
  runBilibiliSubtitle,
  runBilibiliUserVideos,
  runBilibiliVideoMeta,
} from './bilibili.js';
import {
  runYoutubeChannelCompat,
  runYoutubeChannelInfo,
  runYoutubeChannelVideos,
  runYoutubeTranscript,
  runYoutubeVideoCompat,
  runYoutubeVideoMeta,
} from './youtube.js';

export interface ParsedCommandInput {
  site: string;
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export interface ParsedCliRequest {
  commandInput: ParsedCommandInput;
  format: 'json';
}

export type CommandHandler = (
  page: IPage,
  input: ParsedCommandInput,
) => Promise<unknown>;

const COMMANDS = new Map<string, CommandHandler>([
  ['youtube/channel-info', runYoutubeChannelInfo],
  ['youtube/channel-videos', runYoutubeChannelVideos],
  ['youtube/video-meta', runYoutubeVideoMeta],
  ['youtube/transcript', runYoutubeTranscript],
  ['youtube/channel', runYoutubeChannelCompat],
  ['youtube/video', runYoutubeVideoCompat],
  ['bilibili/channel-info', runBilibiliChannelInfo],
  ['bilibili/user-videos', runBilibiliUserVideos],
  ['bilibili/video-meta', runBilibiliVideoMeta],
  ['bilibili/subtitle', runBilibiliSubtitle],
  ['bilibili/following', runBilibiliFollowing],
]);

export function resolveCommandHandler(
  site: string,
  command: string,
): CommandHandler | undefined {
  return COMMANDS.get(`${site}/${command}`);
}

function parseFlagValue(
  argv: string[],
  index: number,
): { nextIndex: number; value: string | boolean } {
  const next = argv[index + 1];
  if (!next || next.startsWith('-')) {
    return { nextIndex: index, value: true };
  }
  return { nextIndex: index + 1, value: next };
}

export function parseCliRequest(argv: string[]): ParsedCliRequest {
  const args = [...argv];
  let format: 'json' = 'json';
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '-f' || token === '--format') {
      const value = args[index + 1];
      if (value !== 'json') {
        throw new Error('Only `-f json` is supported by Needle Browser runtime.');
      }
      format = 'json';
      index += 1;
      continue;
    }

    if (token.startsWith('--')) {
      const name = token.slice(2);
      const parsed = parseFlagValue(args, index);
      flags[name] = parsed.value;
      index = parsed.nextIndex;
      continue;
    }

    positionals.push(token);
  }

  if (positionals.length < 2) {
    throw new Error(
      'Usage: needle-browser-local <site> <command> [args] -f json',
    );
  }

  const [site, command, ...rest] = positionals;
  return {
    commandInput: {
      site,
      command,
      positionals: rest,
      flags,
    },
    format,
  };
}
