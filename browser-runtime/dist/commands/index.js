import { runBilibiliChannelInfo, runBilibiliFollowing, runBilibiliSubtitle, runBilibiliUserVideos, runBilibiliVideoMeta, } from './bilibili.js';
import { runYoutubeChannelCompat, runYoutubeChannelInfo, runYoutubeChannelVideos, runYoutubeTranscript, runYoutubeVideoCompat, runYoutubeVideoMeta, } from './youtube.js';
const COMMANDS = new Map([
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
export function resolveCommandHandler(site, command) {
    return COMMANDS.get(`${site}/${command}`);
}
function parseFlagValue(argv, index) {
    const next = argv[index + 1];
    if (!next || next.startsWith('-')) {
        return { nextIndex: index, value: true };
    }
    return { nextIndex: index + 1, value: next };
}
export function parseCliRequest(argv) {
    const args = [...argv];
    let format = 'json';
    const positionals = [];
    const flags = {};
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
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
        throw new Error('Usage: needle-browser-local <site> <command> [args] -f json');
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
