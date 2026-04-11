import { AuthRequiredError, CommandExecutionError, EmptyResultError, } from '../errors.js';
function asRecord(value) {
    return value && typeof value === 'object'
        ? value
        : null;
}
function asString(value) {
    return typeof value === 'string' ? value : '';
}
function parseVideoId(input) {
    if (!input.startsWith('http'))
        return input;
    try {
        const parsed = new URL(input);
        if (parsed.searchParams.has('v'))
            return parsed.searchParams.get('v') || input;
        if (parsed.hostname === 'youtu.be')
            return parsed.pathname.slice(1).split('/')[0] || input;
        const match = parsed.pathname.match(/^\/(shorts|embed|live|v)\/([^/?]+)/);
        if (match?.[2])
            return match[2];
    }
    catch {
        // Fall through to raw input.
    }
    return input;
}
function parseChannelInput(input) {
    const trimmed = input.trim();
    if (!trimmed.startsWith('http'))
        return trimmed;
    try {
        const parsed = new URL(trimmed);
        const path = parsed.pathname.replace(/\/+$/, '');
        const channelMatch = path.match(/^\/channel\/([^/]+)$/);
        if (channelMatch?.[1])
            return channelMatch[1];
    }
    catch {
        // Fall through to raw input.
    }
    return trimmed;
}
function isDirectChannelBrowseId(input) {
    return /^(UC|HC)[A-Za-z0-9_-]+$/.test(input.trim());
}
function buildChannelResolveUrl(input) {
    const trimmed = input.trim();
    if (!trimmed)
        return 'https://www.youtube.com/';
    if (trimmed.startsWith('http'))
        return trimmed;
    if (trimmed.startsWith('@'))
        return `https://www.youtube.com/${trimmed}`;
    if (trimmed.startsWith('/'))
        return `https://www.youtube.com${trimmed}`;
    return `https://www.youtube.com/${trimmed}`;
}
function extractChannelBrowseIdFromHtml(html) {
    const candidates = [
        html.match(/"externalId":"((?:UC|HC)[A-Za-z0-9_-]+)"/),
        html.match(/"browseId":"((?:UC|HC)[A-Za-z0-9_-]+)"/),
        html.match(/<link[^>]+rel="canonical"[^>]+href="https:\/\/www\.youtube\.com\/channel\/((?:UC|HC)[A-Za-z0-9_-]+)"/i),
        html.match(/<meta[^>]+itemprop="channelId"[^>]+content="((?:UC|HC)[A-Za-z0-9_-]+)"/i),
    ];
    for (const match of candidates) {
        if (match?.[1])
            return match[1];
    }
    return '';
}
function toIsoDate(value) {
    if (typeof value !== 'string' || value.trim() === '')
        return '';
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed))
        return trimmed;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return new Date(`${trimmed}T00:00:00Z`).toISOString();
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}
function formatDurationFromSeconds(value) {
    const total = Math.max(0, Math.floor(value));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
}
function isMembersOnlyText(value) {
    return (typeof value === 'string' &&
        /member|members only|subscriber-only|premium|会员|专属|付费/i.test(value));
}
function collectBadgeTexts(value) {
    if (!Array.isArray(value))
        return [];
    const labels = [];
    for (const item of value) {
        const badge = asRecord(item);
        if (!badge)
            continue;
        const metadata = asRecord(badge.metadataBadgeRenderer);
        const label = asString(metadata?.label);
        if (label)
            labels.push(label);
        const thumbnail = asRecord(badge.thumbnailBadgeViewModel);
        const text = asString(thumbnail?.text);
        if (text)
            labels.push(text);
    }
    return labels;
}
function getSimpleText(value) {
    const record = asRecord(value);
    if (!record)
        return '';
    return asString(record.simpleText) || asString(record.text);
}
function isMembersOnlyBadgeLabel(label) {
    return isMembersOnlyText(label);
}
function isDurationText(value) {
    return (typeof value === 'string' && /^\d{1,2}:\d{2}(?::\d{2})?$/.test(value.trim()));
}
function extractDurationFromAccessibilityLabel(value) {
    if (typeof value !== 'string')
        return '';
    const match = value.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/);
    return match?.[0] || '';
}
function pickDurationText(...candidates) {
    for (const candidate of candidates) {
        if (isDurationText(candidate))
            return candidate.trim();
    }
    return '';
}
function extractDurationFromOverlays(overlays) {
    for (const overlay of overlays) {
        const record = asRecord(overlay);
        const timeStatus = getSimpleText(asRecord(asRecord(record?.thumbnailOverlayTimeStatusRenderer)?.text));
        const badges = collectBadgeTexts(asRecord(asRecord(record?.thumbnailBottomOverlayViewModel)?.badges));
        const duration = pickDurationText(timeStatus, ...badges);
        if (duration)
            return duration;
    }
    return '';
}
function extractGridVideoRendererSummary(renderer) {
    const value = asRecord(renderer);
    if (!value)
        return null;
    const titleRuns = Array.isArray(asRecord(value.title)?.runs)
        ? asRecord(value.title)?.runs
        : [];
    const firstTitleRun = asRecord(titleRuns[0]);
    const videoId = asString(value.videoId);
    const title = asString(firstTitleRun?.text) ||
        asString(asRecord(value.title)?.simpleText);
    if (!videoId || !title)
        return null;
    const thumbnails = Array.isArray(asRecord(value.thumbnail)?.thumbnails)
        ? asRecord(value.thumbnail)?.thumbnails
        : [];
    const lastThumbnail = asRecord(thumbnails.at(-1));
    const overlays = Array.isArray(value.thumbnailOverlays)
        ? value.thumbnailOverlays
        : [];
    const duration = extractDurationFromOverlays(overlays);
    const overlayTexts = overlays.flatMap((overlay) => collectBadgeTexts(asRecord(asRecord(overlay)?.thumbnailBottomOverlayViewModel)?.badges));
    const badgeTexts = [...collectBadgeTexts(value.badges), ...overlayTexts];
    return {
        video_id: videoId,
        title,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        thumbnail_url: asString(lastThumbnail?.url),
        published_at: asString(asRecord(value.publishedTimeText)?.simpleText),
        duration,
        is_members_only: badgeTexts.some(isMembersOnlyBadgeLabel) ? 1 : 0,
    };
}
function extractLockupVideoSummary(lockup) {
    const value = asRecord(lockup);
    if (!value || asString(value.contentType) !== 'LOCKUP_CONTENT_TYPE_VIDEO') {
        return null;
    }
    const contentId = asString(value.contentId);
    const metadata = asRecord(asRecord(value.metadata)?.lockupMetadataViewModel);
    const title = asString(asRecord(metadata?.title)?.content);
    if (!contentId || !title)
        return null;
    const overlays = Array.isArray(asRecord(asRecord(value.contentImage)?.thumbnailViewModel)?.overlays)
        ? asRecord(asRecord(value.contentImage)?.thumbnailViewModel)
            ?.overlays
        : [];
    let duration = '';
    const overlayTexts = [];
    for (const overlay of overlays) {
        const badges = collectBadgeTexts(asRecord(asRecord(overlay)?.thumbnailBottomOverlayViewModel)?.badges);
        overlayTexts.push(...badges);
        const durationText = pickDurationText(...badges);
        if (!duration && durationText)
            duration = durationText;
    }
    const imageSources = Array.isArray(asRecord(asRecord(asRecord(value.contentImage)?.thumbnailViewModel)?.image)
        ?.sources)
        ? asRecord(asRecord(asRecord(value.contentImage)?.thumbnailViewModel)?.image)?.sources
        : [];
    const lastImage = asRecord(imageSources.at(-1));
    const badgeTexts = [...collectBadgeTexts(value.badges), ...overlayTexts];
    return {
        video_id: contentId,
        title,
        url: `https://www.youtube.com/watch?v=${contentId}`,
        thumbnail_url: asString(lastImage?.url),
        duration,
        is_members_only: badgeTexts.some(isMembersOnlyBadgeLabel) ? 1 : 0,
    };
}
function extractVideoRendererSummary(renderer) {
    const value = asRecord(renderer);
    if (!value)
        return null;
    const videoId = asString(value.videoId);
    const title = asString(asRecord(value.title)?.simpleText) ||
        (Array.isArray(asRecord(value.title)?.runs)
            ? asString(asRecord((asRecord(value.title)?.runs)[0])?.text)
            : '');
    if (!videoId || !title)
        return null;
    const thumbnails = Array.isArray(asRecord(value.thumbnail)?.thumbnails)
        ? asRecord(value.thumbnail)?.thumbnails
        : [];
    const lastThumbnail = asRecord(thumbnails.at(-1));
    const overlays = Array.isArray(value.thumbnailOverlays)
        ? value.thumbnailOverlays
        : [];
    const badgeTexts = [
        ...collectBadgeTexts(value.badges),
        ...collectBadgeTexts(value.ownerBadges),
    ];
    const lengthText = getSimpleText(value.lengthText);
    const accessibilityLabel = asString(asRecord(asRecord(asRecord(value.lengthText)?.accessibility)?.accessibilityData)
        ?.label);
    return {
        video_id: videoId,
        title,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        thumbnail_url: asString(lastThumbnail?.url),
        published_at: asString(asRecord(value.publishedTimeText)?.simpleText) ||
            asString(asRecord(value.publishedTimeText)?.text),
        duration: pickDurationText(lengthText, extractDurationFromAccessibilityLabel(accessibilityLabel), extractDurationFromOverlays(overlays)),
        is_members_only: badgeTexts.some(isMembersOnlyBadgeLabel) ? 1 : 0,
    };
}
export const __youtubeCommandTestUtils = {
    parseYoutubeCaptionXml,
    extractDurationFromAccessibilityLabel,
    extractDurationFromOverlays,
    extractGridVideoRendererSummary,
    extractLockupVideoSummary,
    extractVideoRendererSummary,
    pickDurationText,
};
function extractJsonAssignmentFromHtml(html, names) {
    for (const name of names) {
        const needle = `${name}`;
        const assignIndex = html.indexOf(needle);
        if (assignIndex === -1)
            continue;
        const jsonStart = html.indexOf('{', assignIndex);
        if (jsonStart === -1)
            continue;
        let depth = 0;
        let inString = false;
        let escaping = false;
        for (let i = jsonStart; i < html.length; i += 1) {
            const char = html[i];
            if (inString) {
                if (escaping)
                    escaping = false;
                else if (char === '\\')
                    escaping = true;
                else if (char === '"')
                    inString = false;
                continue;
            }
            if (char === '"') {
                inString = true;
                continue;
            }
            if (char === '{') {
                depth += 1;
                continue;
            }
            if (char === '}') {
                depth -= 1;
                if (depth === 0) {
                    try {
                        return JSON.parse(html.slice(jsonStart, i + 1));
                    }
                    catch {
                        break;
                    }
                }
            }
        }
    }
    return null;
}
async function prepareYoutubeApiPage(page) {
    const currentUrl = await page.getCurrentUrl?.();
    if (currentUrl && /^https?:\/\/(www\.)?youtube\.com/i.test(currentUrl)) {
        return;
    }
    await page.goto('https://www.youtube.com', { waitUntil: 'none' });
}
async function fetchYoutubeChannelData(page, input, limit = 10) {
    const channelInput = parseChannelInput(input);
    await prepareYoutubeApiPage(page);
    const data = (await page.evaluate(`
    (async () => {
      const isMembersOnlyText = ${isMembersOnlyText.toString()};
      const collectBadgeTexts = ${collectBadgeTexts.toString()};
      const getSimpleText = ${getSimpleText.toString()};
      const isMembersOnlyBadgeLabel = ${isMembersOnlyBadgeLabel.toString()};
      const isDurationText = ${isDurationText.toString()};
      const extractDurationFromAccessibilityLabel = ${extractDurationFromAccessibilityLabel.toString()};
      const pickDurationText = ${pickDurationText.toString()};
      const extractDurationFromOverlays = ${extractDurationFromOverlays.toString()};
      const asRecord = ${asRecord.toString()};
      const asString = ${asString.toString()};
      const extractGridVideoRendererSummary = ${extractGridVideoRendererSummary.toString()};
      const extractLockupVideoSummary = ${extractLockupVideoSummary.toString()};
      const extractVideoRendererSummary = ${extractVideoRendererSummary.toString()};
      const isDirectChannelBrowseId = ${isDirectChannelBrowseId.toString()};
      const buildChannelResolveUrl = ${buildChannelResolveUrl.toString()};
      const extractChannelBrowseIdFromHtml = ${extractChannelBrowseIdFromHtml.toString()};
      const channelInput = ${JSON.stringify(channelInput)};
      const limit = ${Math.min(Math.max(limit, 1), 30)};
      const cfg = window.ytcfg?.data_ || {};
      const apiKey = cfg.INNERTUBE_API_KEY;
      const context = cfg.INNERTUBE_CONTEXT;
      if (!apiKey || !context) return { error: 'YouTube config not found' };

      let browseId = channelInput;
      if (!isDirectChannelBrowseId(channelInput)) {
        const resolvedUrl = buildChannelResolveUrl(channelInput);
        const resolveResp = await fetch('/youtubei/v1/navigation/resolve_url?key=' + apiKey + '&prettyPrint=false', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context, url: resolvedUrl }),
        });
        if (resolveResp.ok) {
          const resolveData = await resolveResp.json();
          browseId = resolveData.endpoint?.browseEndpoint?.browseId || browseId;
        }
        if (!isDirectChannelBrowseId(browseId)) {
          const pageResp = await fetch(resolvedUrl, { credentials: 'include' });
          if (pageResp.ok) {
            const html = await pageResp.text();
            browseId = extractChannelBrowseIdFromHtml(html) || browseId;
          }
        }
      }

      if (!isDirectChannelBrowseId(browseId)) {
        return { error: 'Unable to resolve channel browseId' };
      }

      const resp = await fetch('/youtubei/v1/browse?key=' + apiKey + '&prettyPrint=false', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context, browseId }),
      });
      if (!resp.ok) return { error: 'Channel API returned HTTP ' + resp.status };
      const data = await resp.json();

      const metadata = data.metadata?.channelMetadataRenderer || {};
      const header = data.header?.pageHeaderRenderer || data.header?.c4TabbedHeaderRenderer || {};
      const avatarUrl =
        metadata.avatar?.thumbnails?.slice(-1)?.[0]?.url ||
        header.content?.pageHeaderViewModel?.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources?.slice(-1)?.[0]?.url ||
        header.avatar?.thumbnails?.slice(-1)?.[0]?.url ||
        '';

      const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
      const selectedTab = tabs.find((t) => t.tabRenderer?.selected) || tabs[0];
      const videosTab = tabs.find((tab) => {
        const tr = tab?.tabRenderer || {};
        const title = tr.title || '';
        const url =
          tr.endpoint?.commandMetadata?.webCommandMetadata?.url ||
          tr.endpoint?.browseEndpoint?.canonicalBaseUrl ||
          '';
        return /videos/i.test(title) || /\\/videos(?:\\?|$)/.test(url);
      });

      let videoTabContent = videosTab?.tabRenderer?.content || selectedTab?.tabRenderer?.content || null;
      if (videosTab?.tabRenderer?.endpoint?.browseEndpoint?.params) {
        const browseEndpoint = videosTab.tabRenderer.endpoint.browseEndpoint;
        const videosResp = await fetch('/youtubei/v1/browse?key=' + apiKey + '&prettyPrint=false', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            context,
            browseId: browseEndpoint.browseId || metadata.externalId || browseId,
            params: browseEndpoint.params,
          }),
        });
        if (videosResp.ok) {
          const videosData = await videosResp.json();
          const videoTabs = videosData.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
          const resolvedTab = videoTabs.find((tab) => tab?.tabRenderer?.selected) || videoTabs[0];
          if (resolvedTab?.tabRenderer?.content) {
            videoTabContent = resolvedTab.tabRenderer.content;
          }
        }
      }

      const recentVideos = [];
      const seen = new Set();
      const pushVideo = (item) => {
        if (!item || recentVideos.length >= limit) return;
        if (!item.video_id || !item.title || seen.has(item.video_id)) return;
        seen.add(item.video_id);
        recentVideos.push(item);
      };

      const sections = videoTabContent?.sectionListRenderer?.contents || [];
      for (const section of sections) {
        for (const shelf of (section.itemSectionRenderer?.contents || [])) {
          for (const item of (shelf.shelfRenderer?.content?.horizontalListRenderer?.items || [])) {
            pushVideo(extractLockupVideoSummary(item.lockupViewModel));
            pushVideo(extractGridVideoRendererSummary(item.gridVideoRenderer));
            pushVideo(extractVideoRendererSummary(item.videoRenderer));
          }
        }
      }

      const richGridContents = videoTabContent?.richGridRenderer?.contents || [];
      for (const item of richGridContents) {
        const richContent = item?.richItemRenderer?.content || {};
        pushVideo(extractVideoRendererSummary(richContent.videoRenderer));
        pushVideo(extractGridVideoRendererSummary(richContent.gridVideoRenderer));
        pushVideo(extractLockupVideoSummary(richContent.lockupViewModel));
      }

      return {
        channel_id: metadata.externalId || browseId,
        name: metadata.title || '',
        avatar_url: avatarUrl,
        recent_videos: recentVideos,
      };
    })()
  `));
    if (!data || typeof data !== 'object') {
        throw new Error('Failed to fetch YouTube channel data');
    }
    if (typeof data.error === 'string' && data.error) {
        throw new Error(data.error);
    }
    return {
        channel_id: String(data.channel_id || channelInput),
        name: String(data.name || channelInput),
        avatar_url: String(data.avatar_url || ''),
        recent_videos: Array.isArray(data.recent_videos)
            ? data.recent_videos
            : [],
    };
}
async function fetchYoutubeVideoData(page, input) {
    const videoId = parseVideoId(input);
    await prepareYoutubeApiPage(page);
    const data = (await page.evaluate(`
    (async () => {
      const extractJsonAssignmentFromHtml = ${extractJsonAssignmentFromHtml.toString()};
      const videoId = ${JSON.stringify(videoId)};

      const watchResp = await fetch('/watch?v=' + encodeURIComponent(videoId), {
        credentials: 'include',
      });
      if (!watchResp.ok) return { error: 'Watch HTML returned HTTP ' + watchResp.status };

      const html = await watchResp.text();
      const player = extractJsonAssignmentFromHtml(html, ['ytInitialPlayerResponse', 'ytInitialPlayerResponse = ']);
      const yt = extractJsonAssignmentFromHtml(html, ['ytInitialData', 'ytInitialData = ']);
      if (!player) return { error: 'ytInitialPlayerResponse not found in watch HTML' };

      const details = player.videoDetails || {};
      const microformat = player.microformat?.playerMicroformatRenderer || {};
      const playability = player.playabilityStatus || {};
      const contents = yt?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
      const badges = details.badges || [];
      const ownerBadges = microformat.ownerProfileUrl ? [] : [];

      let memberText = '';
      try {
        const messages = Array.isArray(playability.messages) ? playability.messages.join(' ') : '';
        memberText = [playability.status, playability.reason, messages].filter(Boolean).join(' ');
      } catch {}

      return {
        video_id: details.videoId || videoId,
        title: details.title || '',
        thumbnail_url: details.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || '',
        published_at: microformat.publishDate || microformat.uploadDate || '',
        duration: details.lengthSeconds ? Number(details.lengthSeconds) : 0,
        is_members_only:
          (/member|members only|subscriber-only|premium/i.test(memberText)
            || badges.some((badge) => /member|subscriber|premium/i.test(badge?.metadataBadgeRenderer?.label || ''))
            || ownerBadges.some((badge) => /member|subscriber|premium/i.test(badge?.metadataBadgeRenderer?.label || '')))
            ? 1
            : 0,
      };
    })()
  `));
    if (!data || typeof data !== 'object') {
        throw new Error('Failed to extract YouTube video metadata');
    }
    if (typeof data.error === 'string' && data.error) {
        throw new Error(data.error);
    }
    const durationSeconds = typeof data.duration === 'number'
        ? data.duration
        : Number.parseInt(String(data.duration || '0'), 10) || 0;
    return {
        video_id: String(data.video_id || videoId),
        title: String(data.title || ''),
        thumbnail_url: String(data.thumbnail_url || ''),
        published_at: toIsoDate(data.published_at),
        duration: durationSeconds > 0 ? formatDurationFromSeconds(durationSeconds) : '',
        is_members_only: data.is_members_only === 1 ||
            data.is_members_only === true ||
            isMembersOnlyText(data.is_members_only)
            ? 1
            : 0,
    };
}
function readRequiredInput(input, flagName, label) {
    const flagged = input.flags[flagName];
    const value = (typeof flagged === 'string' ? flagged : '') || input.positionals[0] || '';
    if (!value.trim())
        throw new CommandExecutionError(`Missing ${label}`);
    return value.trim();
}
function readOptionalString(input, name) {
    const value = input.flags[name];
    return typeof value === 'string' ? value.trim() : '';
}
function readIntFlag(input, name, fallback, max) {
    const raw = input.flags[name];
    const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
    const base = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    return typeof max === 'number' ? Math.min(base, max) : base;
}
function formatTimestamp(seconds) {
    return `${Number(seconds).toFixed(2)}s`;
}
function decodeXmlEntities(value) {
    return value
        .replaceAll('&amp;', '&')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'");
}
function extractXmlAttr(source, name) {
    const needle = `${name}="`;
    const idx = source.indexOf(needle);
    if (idx === -1)
        return '';
    const start = idx + needle.length;
    const end = source.indexOf('"', start);
    if (end === -1)
        return '';
    return source.substring(start, end);
}
function parseYoutubeCaptionXml(xml) {
    if (!xml?.length)
        return [];
    const isFormat3 = xml.includes('<p t="');
    const marker = isFormat3 ? '<p ' : '<text ';
    const endMarker = isFormat3 ? '</p>' : '</text>';
    const results = [];
    let pos = 0;
    while (true) {
        const tagStart = xml.indexOf(marker, pos);
        if (tagStart === -1)
            break;
        let contentStart = xml.indexOf('>', tagStart);
        if (contentStart === -1)
            break;
        contentStart += 1;
        const tagEnd = xml.indexOf(endMarker, contentStart);
        if (tagEnd === -1)
            break;
        const attrStr = xml.substring(tagStart + marker.length, contentStart - 1);
        const content = xml.substring(contentStart, tagEnd);
        let startSec;
        let durSec;
        if (isFormat3) {
            startSec = (parseFloat(extractXmlAttr(attrStr, 't')) || 0) / 1000;
            durSec = (parseFloat(extractXmlAttr(attrStr, 'd')) || 0) / 1000;
        }
        else {
            startSec = parseFloat(extractXmlAttr(attrStr, 'start')) || 0;
            durSec = parseFloat(extractXmlAttr(attrStr, 'dur')) || 0;
        }
        const text = decodeXmlEntities(content.replace(/<[^>]+>/g, ''))
            .split('\n')
            .join(' ')
            .trim();
        if (text) {
            results.push({ start: startSec, end: startSec + durSec, text });
        }
        pos = tagEnd + endMarker.length;
    }
    return results;
}
function parseTimestampToSeconds(raw) {
    const parts = raw.split(':').map((value) => Number.parseInt(value, 10));
    if (parts.some((value) => Number.isNaN(value)))
        return null;
    if (parts.length === 3)
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2)
        return parts[0] * 60 + parts[1];
    return null;
}
function groupTranscriptSegments(segments) {
    const rows = [];
    let currentText = [];
    let currentStart = 0;
    let lastStart = 0;
    const flush = () => {
        if (currentText.length === 0)
            return;
        rows.push({
            start: formatTimestamp(currentStart),
            end: formatTimestamp(lastStart),
            text: currentText.join(' ').replace(/\s+/g, ' ').trim(),
        });
        currentText = [];
    };
    for (const segment of segments) {
        if (currentText.length === 0) {
            currentStart = segment.start;
            lastStart = segment.start;
            currentText.push(segment.text);
            continue;
        }
        const gap = segment.start - lastStart;
        if (gap > 8 ||
            /[。！？.!?]$/.test(currentText[currentText.length - 1] || '')) {
            flush();
            currentStart = segment.start;
        }
        currentText.push(segment.text);
        lastStart = segment.start;
    }
    flush();
    return rows.map((row, index) => ({
        index: index + 1,
        start: row.start,
        end: row.end,
        text: row.text,
    }));
}
export async function runYoutubeChannelInfo(page, input) {
    const channel = readRequiredInput(input, 'channel', 'channel');
    try {
        const data = await fetchYoutubeChannelData(page, channel, 1);
        return {
            channel_id: data.channel_id,
            name: data.name,
            avatar_url: data.avatar_url,
        };
    }
    catch (error) {
        throw new CommandExecutionError(error instanceof Error ? error.message : String(error));
    }
}
export async function runYoutubeChannelVideos(page, input) {
    const channel = readRequiredInput(input, 'channel', 'channel');
    const limit = readIntFlag(input, 'limit', 10, 30);
    try {
        const data = await fetchYoutubeChannelData(page, channel, limit);
        return data.recent_videos;
    }
    catch (error) {
        throw new CommandExecutionError(error instanceof Error ? error.message : String(error));
    }
}
export async function runYoutubeVideoMeta(page, input) {
    const video = readRequiredInput(input, 'video', 'video');
    try {
        return await fetchYoutubeVideoData(page, video);
    }
    catch (error) {
        throw new CommandExecutionError(error instanceof Error ? error.message : String(error));
    }
}
export async function runYoutubeTranscript(page, input) {
    const video = readRequiredInput(input, 'url', 'url');
    const lang = readOptionalString(input, 'lang');
    const mode = readOptionalString(input, 'mode') || 'grouped';
    const videoId = parseVideoId(video);
    try {
        await prepareYoutubeApiPage(page);
        const captionData = (await page.evaluate(`
      (async () => {
        const cfg = window.ytcfg?.data_ || {};
        const apiKey = cfg.INNERTUBE_API_KEY;
        if (!apiKey) return { error: 'INNERTUBE_API_KEY not found on page' };

        const resp = await fetch('/youtubei/v1/player?key=' + apiKey + '&prettyPrint=false', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } },
            videoId: ${JSON.stringify(videoId)}
          })
        });

        if (!resp.ok) return { error: 'InnerTube player API returned HTTP ' + resp.status };
        const data = await resp.json();
        const renderer = data.captions?.playerCaptionsTracklistRenderer;
        if (!renderer?.captionTracks?.length) {
          return { error: 'No captions available for this video' };
        }

        const tracks = renderer.captionTracks;
        const langPref = ${JSON.stringify(lang)};
        let track = null;
        if (langPref) {
          track = tracks.find(t => t.languageCode === langPref)
            || tracks.find(t => t.languageCode.startsWith(langPref));
        }
        if (!track) {
          track = tracks.find(t => t.kind !== 'asr') || tracks[0];
        }

        const captionResp = await fetch(track.baseUrl, { credentials: 'include' });
        if (!captionResp.ok) {
          return { error: 'Caption URL returned HTTP ' + captionResp.status };
        }

        return { xml: await captionResp.text() };
      })()
    `));
        if (captionData?.error) {
            throw new CommandExecutionError(captionData.error);
        }
        const xml = String(captionData?.xml || '');
        if (!xml.trim()) {
            throw new CommandExecutionError('Caption XML missing from player response');
        }
        const segments = parseYoutubeCaptionXml(xml);
        if (segments.length === 0) {
            throw new EmptyResultError('youtube transcript');
        }
        if (mode === 'raw') {
            return segments.map((segment, index) => ({
                index: index + 1,
                start: formatTimestamp(segment.start),
                end: formatTimestamp(segment.end || segment.start),
                text: segment.text,
            }));
        }
        return groupTranscriptSegments(segments.map((segment) => ({ start: segment.start, text: segment.text })));
    }
    catch (error) {
        if (error instanceof Error &&
            /No captions available|not available|login required|not logged in/i.test(error.message)) {
            throw new AuthRequiredError('youtube.com', error.message);
        }
        throw error instanceof CommandExecutionError
            ? error
            : new CommandExecutionError(error instanceof Error ? error.message : String(error));
    }
}
export async function runYoutubeChannelCompat(page, input) {
    const channel = readRequiredInput(input, 'channel', 'channel');
    const limit = readIntFlag(input, 'limit', 10, 30);
    const data = await fetchYoutubeChannelData(page, channel, limit).catch((error) => {
        throw new CommandExecutionError(error instanceof Error ? error.message : String(error));
    });
    const rows = [
        { field: 'name', value: data.name },
        { field: 'channelId', value: data.channel_id },
        { field: 'avatar_url', value: data.avatar_url },
    ];
    if (data.recent_videos.length > 0) {
        rows.push({ field: '---', value: '--- Recent Videos ---' });
        for (const video of data.recent_videos) {
            rows.push({
                field: video.title,
                value: [video.duration || '', video.published_at || '', video.url || '']
                    .filter(Boolean)
                    .join(' | '),
            });
        }
    }
    return rows;
}
export async function runYoutubeVideoCompat(page, input) {
    return runYoutubeVideoMeta(page, input);
}
