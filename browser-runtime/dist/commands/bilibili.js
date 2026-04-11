import { AuthRequiredError, CommandExecutionError, EmptyResultError, SelectorError, } from '../errors.js';
const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
    26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
    20, 34, 44, 52,
];
const BILIBILI_ORIGIN = 'https://www.bilibili.com';
const BILIBILI_API_ORIGIN = 'https://api.bilibili.com';
const DEFAULT_BILIBILI_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
function normalizeImageUrl(url) {
    if (!url)
        return '';
    if (url.startsWith('//'))
        return `https:${url}`;
    return url.replace(/^http:\/\//, 'https://');
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
function toIsoDate(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return new Date(value * 1000).toISOString();
    }
    if (typeof value !== 'string' || value.trim() === '')
        return '';
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed))
        return trimmed;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return new Date(`${trimmed}T00:00:00+08:00`).toISOString();
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}
function parseUidInput(input) {
    const trimmed = input.trim();
    if (/^\d+$/.test(trimmed))
        return trimmed;
    try {
        const parsed = new URL(trimmed);
        const match = parsed.pathname.match(/^\/(\d+)(?:\/|$)/);
        if (parsed.hostname.includes('space.bilibili.com') && match?.[1]) {
            return match[1];
        }
    }
    catch {
        // Fall through to raw input.
    }
    return trimmed;
}
async function getNavData(page) {
    return fetchJson(page, `${BILIBILI_API_ORIGIN}/x/web-interface/nav`);
}
async function getWbiKeys(page) {
    const nav = await getNavData(page);
    const data = nav?.data || {};
    const wbiImg = data.wbi_img || {};
    const imgUrl = String(wbiImg.img_url || '');
    const subUrl = String(wbiImg.sub_url || '');
    return {
        imgKey: imgUrl.split('/').pop()?.split('.')[0] || '',
        subKey: subUrl.split('/').pop()?.split('.')[0] || '',
    };
}
function getMixinKey(imgKey, subKey) {
    const raw = imgKey + subKey;
    return MIXIN_KEY_ENC_TAB.map((index) => raw[index] || '')
        .join('')
        .slice(0, 32);
}
async function md5(text) {
    const { createHash } = await import('node:crypto');
    return createHash('md5').update(text).digest('hex');
}
async function wbiSign(page, params) {
    const { imgKey, subKey } = await getWbiKeys(page);
    const mixinKey = getMixinKey(imgKey, subKey);
    const wts = Math.floor(Date.now() / 1000);
    const canonicalEntries = Object.entries({
        ...params,
        wts: String(wts),
    })
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [
        key,
        String(value ?? '').replace(/[!'()*]/g, ''),
    ]);
    const query = new URLSearchParams(canonicalEntries).toString().replace(/\+/g, '%20');
    return Object.fromEntries([
        ...canonicalEntries,
        ['w_rid', await md5(query + mixinKey)],
    ]);
}
async function buildCookieHeader(page) {
    const cookieGroups = await Promise.all([
        page.getCookies({ url: `${BILIBILI_ORIGIN}/` }).catch(() => []),
        page.getCookies({ url: `${BILIBILI_API_ORIGIN}/` }).catch(() => []),
        page.getCookies({ domain: '.bilibili.com' }).catch(() => []),
    ]);
    const seen = new Set();
    const pairs = [];
    for (const group of cookieGroups) {
        for (const cookie of group) {
            if (!cookie?.name)
                continue;
            const key = `${cookie.domain || ''}|${cookie.path || '/'}|${cookie.name}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            pairs.push(`${cookie.name}=${cookie.value}`);
        }
    }
    return pairs.join('; ');
}
async function fetchJson(page, url) {
    const cookieHeader = await buildCookieHeader(page);
    const response = await fetch(url, {
        headers: {
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            Origin: BILIBILI_ORIGIN,
            Referer: `${BILIBILI_ORIGIN}/`,
            'User-Agent': DEFAULT_BILIBILI_USER_AGENT,
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
    });
    if (!response.ok) {
        throw new CommandExecutionError(`Bilibili API request failed: HTTP ${response.status} for ${url}`);
    }
    const text = await response.text();
    try {
        return JSON.parse(text);
    }
    catch {
        throw new CommandExecutionError(`Bilibili API returned non-JSON payload for ${url}`);
    }
}
async function apiGet(page, path, opts = {}) {
    let params = opts.params ?? {};
    if (opts.signed) {
        params = await wbiSign(page, params);
    }
    const query = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])))
        .toString()
        .replace(/\+/g, '%20');
    return fetchJson(page, `https://api.bilibili.com${path}?${query}`);
}
async function getSelfUid(page) {
    const nav = await getNavData(page);
    const data = nav?.data || {};
    const mid = data.mid;
    if (!mid)
        throw new AuthRequiredError('bilibili.com');
    return String(mid);
}
async function resolveUid(page, input) {
    if (/^\d+$/.test(input))
        return input;
    const payload = await apiGet(page, '/x/web-interface/wbi/search/type', {
        params: {
            search_type: 'bili_user',
            keyword: input,
        },
        signed: true,
    });
    const data = payload.data || {};
    const results = Array.isArray(data.result) ? data.result : [];
    if (results.length > 0) {
        const first = results[0] || {};
        return String(first.mid || '');
    }
    throw new EmptyResultError(`bilibili user search: ${input}`, 'User may not exist or username may have changed.');
}
const MEMBERS_ONLY_TEXT_PATTERN = /充电专属|会员专属|购买观看|付费|专属视频/i;
const LIMITED_FREE_TEXT_PATTERN = /限时免费|限免|免费中|限时开放/i;
const MEMBERS_ONLY_KEY_HINT = /badge|pay|upower|charge|member|vip|right|label|tip|corner|mark|desc|subtitle|sub_title|reason/i;
function hasMembersOnlyText(value) {
    return typeof value === 'string' && MEMBERS_ONLY_TEXT_PATTERN.test(value);
}
function hasLimitedFreeText(value) {
    return typeof value === 'string' && LIMITED_FREE_TEXT_PATTERN.test(value);
}
function detectMembersOnlyFromValue(value, keyHint = '', depth = 0) {
    if (depth > 4 || value == null)
        return undefined;
    if (typeof value === 'boolean') {
        return value && /pay|upower|member|vip|charge/i.test(keyHint)
            ? 'members_only'
            : undefined;
    }
    if (hasLimitedFreeText(value)) {
        return keyHint ? 'limited_free' : undefined;
    }
    if (hasMembersOnlyText(value)) {
        return keyHint && MEMBERS_ONLY_KEY_HINT.test(keyHint)
            ? 'members_only'
            : undefined;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const detected = detectMembersOnlyFromValue(item, keyHint, depth + 1);
            if (detected)
                return detected;
        }
        return undefined;
    }
    if (typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) {
            const detected = detectMembersOnlyFromValue(nested, keyHint ? `${keyHint}.${key}` : key, depth + 1);
            if (detected)
                return detected;
        }
    }
    return undefined;
}
function detectBilibiliAccessStatus(item) {
    if (item.is_upower_exclusive === true ||
        item.is_ugc_pay === true ||
        item.is_ugc_pay_preview === true) {
        return 'members_only';
    }
    for (const [key, value] of Object.entries(item)) {
        if (key === 'title')
            continue;
        const detected = detectMembersOnlyFromValue(value, key);
        if (detected)
            return detected;
    }
    return undefined;
}
function readRequiredInput(input, flagName, label) {
    const flagged = input.flags[flagName];
    const value = (typeof flagged === 'string' ? flagged : '') || input.positionals[0] || '';
    if (!value.trim())
        throw new CommandExecutionError(`Missing ${label}`);
    return value.trim();
}
function readIntFlag(input, name, fallback, max) {
    const raw = input.flags[name];
    const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
    const base = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    return typeof max === 'number' ? Math.min(base, max) : base;
}
function readOptionalString(input, name) {
    const raw = input.flags[name];
    return typeof raw === 'string' ? raw.trim() : '';
}
export async function runBilibiliChannelInfo(page, input) {
    const uidInput = readRequiredInput(input, 'uid', 'uid');
    try {
        const uid = await resolveUid(page, parseUidInput(uidInput)).catch(async () => {
            const parsed = parseUidInput(uidInput);
            if (/^\d+$/.test(parsed))
                return parsed;
            throw new CommandExecutionError(`Cannot resolve Bilibili user: ${uidInput}`);
        });
        const payload = await apiGet(page, '/x/space/wbi/acc/info', {
            params: { mid: uid },
            signed: true,
        });
        if (payload.code !== 0) {
            throw new CommandExecutionError(`获取 Bilibili 用户信息失败: ${String(payload.message ?? 'unknown')} (${String(payload.code)})`);
        }
        const data = payload.data || {};
        return {
            channel_id: String(data.mid ?? uid),
            name: String(data.name ?? uid),
            avatar_url: normalizeImageUrl(String(data.face || '')),
        };
    }
    catch (error) {
        throw error instanceof CommandExecutionError
            ? error
            : new CommandExecutionError(error instanceof Error ? error.message : String(error));
    }
}
export async function runBilibiliUserVideos(page, input) {
    const uidInput = readRequiredInput(input, 'uid', 'uid');
    const limit = readIntFlag(input, 'limit', 20, 50);
    const order = readOptionalString(input, 'order') || 'pubdate';
    const pageNum = readIntFlag(input, 'page', 1);
    try {
        const uid = await resolveUid(page, parseUidInput(uidInput));
        const payload = await apiGet(page, '/x/space/wbi/arc/search', {
            params: {
                mid: uid,
                pn: pageNum,
                ps: limit,
                order,
            },
            signed: true,
        });
        if (payload.code !== 0) {
            throw new CommandExecutionError(`获取 Bilibili 视频列表失败: ${String(payload.message ?? 'unknown')} (${String(payload.code)})`);
        }
        const data = payload.data || {};
        const list = data.list || {};
        const videos = Array.isArray(list.vlist) ? list.vlist : [];
        return videos.slice(0, limit).map((item) => {
            const video = item || {};
            const accessStatus = detectBilibiliAccessStatus(video);
            return {
                video_id: String(video.bvid || ''),
                title: String(video.title || ''),
                url: video.bvid
                    ? `https://www.bilibili.com/video/${String(video.bvid)}`
                    : '',
                thumbnail_url: normalizeImageUrl(String(video.pic || '')),
                published_at: video.created
                    ? new Date(Number(video.created) * 1000).toISOString()
                    : '',
                duration: typeof video.length === 'string' ? video.length : '',
                is_members_only: accessStatus === 'members_only' ? 1 : undefined,
                access_status: accessStatus,
            };
        });
    }
    catch (error) {
        throw new CommandExecutionError(error instanceof Error ? error.message : String(error));
    }
}
export async function runBilibiliVideoMeta(page, input) {
    const bvid = readRequiredInput(input, 'bvid', 'bvid');
    await page.goto(`https://www.bilibili.com/video/${bvid}/`);
    try {
        const pageState = (await page.evaluate(`
      (() => {
        const state = window.__INITIAL_STATE__ || {};
        const videoData = state.videoData || {};
        const playInfo = window.__playinfo__ || {};
        const durationSeconds = Number(videoData.duration || 0)
          || Math.round(Number(playInfo?.data?.timelength || 0) / 1000)
          || 0;
        return {
          aid: videoData.aid || state.aid || null,
          cid: videoData.cid || state.cid || null,
          title: videoData.title || document.title.replace(/_哔哩哔哩_bilibili$/, ''),
          pic: videoData.pic || '',
          pubdate: videoData.pubdate || 0,
          duration: durationSeconds,
        };
      })()
    `));
        const viewPayload = await apiGet(page, '/x/web-interface/view', {
            params: { bvid },
        }).catch(() => null);
        const viewData = viewPayload?.data || {};
        const aid = Number(viewData.aid ?? pageState.aid ?? 0) || 0;
        const cid = Number(viewData.cid ?? pageState.cid ?? 0) || 0;
        let isMembersOnly = 0;
        let accessStatus;
        if (aid > 0 && cid > 0) {
            const playerPayload = await apiGet(page, '/x/player/wbi/v2', {
                params: { aid, bvid, cid },
                signed: true,
            }).catch(() => null);
            const player = playerPayload?.data || {};
            const highLevel = player.elec_high_level || {};
            const previewToast = String(player.preview_toast ?? '');
            isMembersOnly =
                player.is_upower_exclusive === true ||
                    player.is_ugc_pay_preview === true ||
                    highLevel.show_button === true ||
                    highLevel.open === true ||
                    /专属|购买观看|付费/.test(previewToast) ||
                    /专属|购买观看|付费/.test(String(highLevel.title ?? '')) ||
                    /专属|购买观看|付费/.test(String(highLevel.sub_title ?? ''))
                    ? 1
                    : 0;
            accessStatus = isMembersOnly ? 'members_only' : undefined;
        }
        return {
            video_id: bvid,
            title: String(viewData.title ?? pageState.title ?? ''),
            thumbnail_url: normalizeImageUrl(String(viewData.pic ?? pageState.pic ?? '')),
            published_at: toIsoDate(viewData.pubdate ?? pageState.pubdate ?? ''),
            duration: formatDurationFromSeconds(Number(viewData.duration ?? pageState.duration ?? 0) || 0),
            is_members_only: isMembersOnly,
            access_status: accessStatus,
        };
    }
    catch (error) {
        throw new CommandExecutionError(error instanceof Error ? error.message : String(error));
    }
}
export async function runBilibiliSubtitle(page, input) {
    const bvid = readRequiredInput(input, 'bvid', 'bvid');
    const lang = readOptionalString(input, 'lang');
    await page.goto(`https://www.bilibili.com/video/${bvid}/`);
    try {
        const pageState = (await page.evaluate(`(async () => {
      const state = window.__INITIAL_STATE__ || {};
      const videoData = state?.videoData || {};
      const playInfo = window.__playinfo__ || {};
      const dashVideo = Array.isArray(playInfo?.data?.dash?.video)
        ? playInfo.data.dash.video[0]
        : null;
      return {
        cid: videoData?.cid || state?.cid || playInfo?.data?.cid || null,
        aid: videoData?.aid || state?.aid || playInfo?.data?.aid || null,
        qualityCid: dashVideo?.id || null,
      };
    })()`));
        const viewPayload = await apiGet(page, '/x/web-interface/view', {
            params: { bvid },
        }).catch(() => null);
        const viewData = viewPayload?.data || {};
        const cid = Number(viewData.cid ?? pageState.cid ?? pageState.qualityCid ?? 0) || 0;
        if (!cid) {
            throw new SelectorError('videoData.cid', '无法在页面中提取到当前视频的 CID，请检查页面是否正常加载。');
        }
        const payload = await apiGet(page, '/x/player/wbi/v2', {
            params: { bvid, cid },
            signed: true,
        });
        if (payload.code !== 0) {
            throw new CommandExecutionError(`获取视频播放信息失败: ${String(payload.message ?? 'unknown')} (${String(payload.code)})`);
        }
        const data = payload.data || {};
        const subtitle = data.subtitle || {};
        const subtitles = Array.isArray(subtitle.subtitles)
            ? subtitle.subtitles
            : [];
        if (subtitles.length === 0) {
            throw new EmptyResultError('bilibili subtitle', '此视频没有发现外挂或智能字幕。');
        }
        const target = lang
            ? subtitles.find((item) => {
                const row = item || {};
                return row.lan === lang;
            }) ||
                subtitles[0]
            : subtitles[0] || {};
        const subtitleUrl = String(target.subtitle_url || '');
        if (!subtitleUrl) {
            throw new AuthRequiredError('bilibili.com', '[风控拦截/未登录] 获取到的 subtitle_url 为空！请确保 CLI 已成功登录且风控未封锁此账号。');
        }
        const finalUrl = subtitleUrl.startsWith('//')
            ? `https:${subtitleUrl}`
            : subtitleUrl;
        const result = (await page.evaluate(`
      (async () => {
        const res = await fetch(${JSON.stringify(finalUrl)});
        const text = await res.text();
        if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
          return { error: 'HTML', text: text.substring(0, 100) };
        }
        try {
          const subJson = JSON.parse(text);
          if (Array.isArray(subJson?.body)) return { success: true, data: subJson.body };
          if (Array.isArray(subJson)) return { success: true, data: subJson };
          return { error: 'UNKNOWN_JSON' };
        } catch {
          return { error: 'PARSE_FAILED', text: text.substring(0, 100) };
        }
      })()
    `));
        if (result?.error) {
            throw new CommandExecutionError(`字幕获取失败: ${result.error}${result.text ? ` — ${result.text}` : ''}`);
        }
        const rows = Array.isArray(result?.data) ? result.data : [];
        if (!Array.isArray(rows)) {
            throw new CommandExecutionError('解析到的字幕列表对象不符合数组格式');
        }
        return rows.map((item, index) => ({
            index: index + 1,
            from: `${Number(item.from || 0).toFixed(2)}s`,
            to: `${Number(item.to || 0).toFixed(2)}s`,
            content: String(item.content || ''),
        }));
    }
    catch (error) {
        throw error;
    }
}
export async function runBilibiliFollowing(page, input) {
    try {
        const uidInput = (typeof input.flags.uid === 'string' ? input.flags.uid : '') ||
            input.positionals[0] ||
            '';
        const uid = uidInput
            ? await resolveUid(page, parseUidInput(uidInput))
            : await getSelfUid(page);
        const pageNum = readIntFlag(input, 'page', 1);
        const limit = readIntFlag(input, 'limit', 50, 50);
        const payload = await fetchJson(page, `https://api.bilibili.com/x/relation/followings?vmid=${encodeURIComponent(uid)}&pn=${pageNum}&ps=${limit}&order=desc`);
        if (payload.code !== 0) {
            throw new CommandExecutionError(`获取关注列表失败: ${String(payload.message ?? 'unknown')} (${String(payload.code)})`);
        }
        const data = payload.data || {};
        const list = Array.isArray(data.list) ? data.list : [];
        if (list.length === 0) {
            return [
                {
                    mid: '-',
                    name: `共 ${String(data.total ?? 0)} 人关注，当前页无数据`,
                    sign: '',
                    following: '',
                    fans: '',
                },
            ];
        }
        return list.map((item) => {
            const user = item || {};
            const official = user.official_verify || {};
            return {
                mid: user.mid,
                name: String(user.uname || ''),
                uname: String(user.uname || ''),
                face: normalizeImageUrl(String(user.face || '')),
                sign: String(user.sign || '').slice(0, 40),
                following: user.attribute === 6 ? '互相关注' : '已关注',
                fans: String(official.desc || ''),
            };
        });
    }
    catch (error) {
        throw new CommandExecutionError(error instanceof Error ? error.message : String(error));
    }
}
