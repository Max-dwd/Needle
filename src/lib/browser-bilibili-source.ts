import {
  openBrowserWorkspaceLoginPage,
  withBrowserWorkspacePage,
} from './browser-session-manager';
import {
  asFieldValueRows,
  asRecord,
  normalizeChannelInfoRecord,
  normalizeVideoMetaRecord,
  normalizeVideoSummaryRecord,
  parseFieldValueMap,
  runBrowserJson,
  type BrowserChannelInfo,
  type BrowserExecOptions,
  type BrowserFollowingRow,
  type BrowserSubtitleRow,
  type BrowserVideoMeta,
  type BrowserVideoSummary,
} from './browser-source-shared';

export const BROWSER_BILIBILI_FOLLOWING_WORKSPACE = 'folo-bilibili-following';

function normalizeBilibiliVideoMetaPayload(
  payload: unknown,
  bvid: string,
): BrowserVideoMeta {
  const record = asRecord(payload);
  if (record) {
    return normalizeVideoMetaRecord(record, 'bilibili', bvid);
  }

  const rows = asFieldValueRows(payload);
  if (!rows) {
    throw new Error('browser bilibili video-meta returned unexpected payload');
  }

  return normalizeVideoMetaRecord(parseFieldValueMap(rows), 'bilibili', bvid);
}

function normalizeBilibiliChannelInfoPayload(
  payload: unknown,
  uidOrUrl: string,
): BrowserChannelInfo {
  const record = asRecord(payload);
  if (record) {
    return normalizeChannelInfoRecord(record, uidOrUrl);
  }

  const rows = asFieldValueRows(payload);
  if (!rows) {
    throw new Error(
      'browser bilibili channel-info returned unexpected payload',
    );
  }

  return normalizeChannelInfoRecord(parseFieldValueMap(rows), uidOrUrl);
}

function normalizeBilibiliUserVideosPayload(
  payload: unknown,
): BrowserVideoSummary[] {
  if (!Array.isArray(payload)) {
    throw new Error('browser bilibili user-videos returned unexpected payload');
  }

  return payload
    .map((item) =>
      normalizeVideoSummaryRecord(asRecord(item) || {}, 'bilibili'),
    )
    .filter((item): item is BrowserVideoSummary => Boolean(item));
}

export async function fetchBrowserBilibiliVideoMeta(
  bvid: string,
  options?: BrowserExecOptions,
): Promise<BrowserVideoMeta> {
  const payload = await runBrowserJson(
    ['bilibili', 'video-meta', bvid],
    {
      ...options,
      strategy: 'metadata',
    },
  );

  return normalizeBilibiliVideoMetaPayload(payload, bvid);
}

export async function fetchBrowserBilibiliChannelInfo(
  uidOrUrl: string,
  options?: BrowserExecOptions,
): Promise<BrowserChannelInfo> {
  const payload = await runBrowserJson(
    ['bilibili', 'channel-info', uidOrUrl],
    {
      ...options,
      strategy: 'metadata',
    },
  );

  return normalizeBilibiliChannelInfoPayload(payload, uidOrUrl);
}

export async function fetchBrowserBilibiliUserVideos(
  uid: string,
  limit = 20,
  options?: BrowserExecOptions,
): Promise<BrowserVideoSummary[]> {
  const result = await runBrowserJson(
    ['bilibili', 'user-videos', uid, '--limit', String(limit)],
    options,
  );
  return normalizeBilibiliUserVideosPayload(result);
}

export async function fetchBrowserBilibiliSubtitleRows(
  bvid: string,
  options?: BrowserExecOptions,
): Promise<BrowserSubtitleRow[]> {
  const result = await runBrowserJson(['bilibili', 'subtitle', bvid], options);
  if (!Array.isArray(result)) {
    throw new Error('browser bilibili subtitle returned unexpected payload');
  }
  return result as BrowserSubtitleRow[];
}

export async function fetchBrowserBilibiliFollowing(options?: {
  uid?: string;
  page?: number;
  limit?: number;
  allowBrowserBootstrap?: boolean;
}): Promise<BrowserFollowingRow[]> {
  const args = ['bilibili', 'following'];
  const uid = options?.uid?.trim();
  if (uid) {
    args.push(uid);
  }
  if (
    typeof options?.page === 'number' &&
    Number.isFinite(options.page) &&
    options.page > 0
  ) {
    args.push('--page', String(options.page));
  }
  if (
    typeof options?.limit === 'number' &&
    Number.isFinite(options.limit) &&
    options.limit > 0
  ) {
    args.push('--limit', String(options.limit));
  }

  const result = await runBrowserJson(args, {
    allowBrowserBootstrap: options?.allowBrowserBootstrap,
  });
  if (!Array.isArray(result)) {
    throw new Error('browser bilibili following returned unexpected payload');
  }
  return result as BrowserFollowingRow[];
}

export async function warmupBrowserBilibiliFollowing(): Promise<void> {
  try {
    await fetchBrowserBilibiliFollowing({
      page: 1,
      limit: 1,
    });
  } catch {
    // Best-effort only. The goal is to trigger the controlled-browser
    // startup path before the user clicks "I have logged in".
  }
}

export async function fetchBrowserBilibiliFollowingViaBridge(
  uid?: string,
): Promise<BrowserFollowingRow[]> {
  return withBrowserWorkspacePage(
    {
      workspace: BROWSER_BILIBILI_FOLLOWING_WORKSPACE,
      timeoutSeconds: 30,
    },
    async (page) => {
      await page.goto('https://www.bilibili.com/', {
        waitUntil: 'domcontentloaded',
        settleMs: 1200,
      });

      const result = await page.evaluate(`(async () => {
      const normalizeList = (items) => Array.isArray(items)
        ? items.map((item) => ({
            mid: item?.mid,
            name: item?.uname || item?.name || '',
            uname: item?.uname || item?.name || '',
            face: item?.face || '',
            sign: item?.sign || '',
            following: item?.attribute === 6 ? '互相关注' : '已关注',
            fans: item?.official_verify?.desc || '',
          }))
        : [];

      const requestedUid = ${JSON.stringify(uid?.trim() || '')};
      let resolvedUid = requestedUid;
      if (!resolvedUid) {
        const navRes = await fetch('https://api.bilibili.com/x/web-interface/nav', {
          credentials: 'include',
        });
        const navPayload = await navRes.json();
        if (navPayload?.code !== 0 || !navPayload?.data?.isLogin || !navPayload?.data?.mid) {
          throw new Error(navPayload?.message || 'Not logged in to Bilibili');
        }
        resolvedUid = String(navPayload.data.mid);
      }

      const pageSize = 50;
      let pageNum = 1;
      let total = Infinity;
      const all = [];

      while (all.length < total) {
        const res = await fetch(
          'https://api.bilibili.com/x/relation/followings?vmid='
            + encodeURIComponent(resolvedUid)
            + '&pn=' + pageNum
            + '&ps=' + pageSize
            + '&order=desc',
          { credentials: 'include' },
        );
        const payload = await res.json();
        if (payload?.code !== 0) {
          throw new Error(payload?.message || ('获取关注列表失败（code ' + String(payload?.code ?? 'unknown') + '）'));
        }

        const pageRows = normalizeList(payload?.data?.list);
        total = typeof payload?.data?.total === 'number' ? payload.data.total : pageRows.length;
        all.push(...pageRows);

        if (pageRows.length < pageSize) break;
        pageNum += 1;
      }

      return all;
    })()`);

      if (!Array.isArray(result)) {
        throw new Error('browser bilibili following bridge returned unexpected payload');
      }

      return result as BrowserFollowingRow[];
    },
  );
}

export async function openBrowserBilibiliLoginPage(): Promise<void> {
  return openBrowserWorkspaceLoginPage({
    workspace: BROWSER_BILIBILI_FOLLOWING_WORKSPACE,
    url: 'https://www.bilibili.com/',
    timeoutSeconds: 30,
    settleMs: 1500,
  });
}
