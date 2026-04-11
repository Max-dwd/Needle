import { getBilibiliSessdata } from '@/lib/bilibili-auth';
import {
  fetchBrowserBilibiliFollowing,
  fetchBrowserBilibiliFollowingViaBridge,
} from '@/lib/browser-bilibili-source';

export interface BilibiliFollowing {
  mid: number;
  uname: string;
  face: string;
  sign: string;
}

interface BilibiliApiPayload<T> {
  code: number;
  message?: string;
  data?: T;
}

interface BilibiliNavData {
  isLogin?: boolean;
  mid?: number;
}

interface BilibiliFollowingApiRow {
  mid?: number | string;
  name?: string;
  uname?: string;
  face?: string;
  sign?: string;
}

interface BilibiliFollowingsData {
  total?: number;
  list?: BilibiliFollowingApiRow[];
}

function normalizeFaceUrl(face: string | undefined): string {
  const value = (face || '').trim();
  if (!value) return '';
  if (value.startsWith('//')) return `https:${value}`;
  return value.replace(/^http:\/\//, 'https://');
}

function mapFollowingRows(
  rows: BilibiliFollowingApiRow[],
): BilibiliFollowing[] {
  return rows
    .map((item): BilibiliFollowing | null => {
      const mid = typeof item.mid === 'number' ? item.mid : Number(item.mid);
      if (!Number.isFinite(mid) || mid <= 0) return null;
      return {
        mid,
        uname: (item.uname || item.name || '').trim() || `UP主 ${mid}`,
        face: normalizeFaceUrl(item.face),
        sign: (item.sign || '').trim(),
      };
    })
    .filter((item): item is BilibiliFollowing => item !== null);
}

function getBilibiliHeaders(sessdata: string): HeadersInit {
  return {
    Cookie: `SESSDATA=${sessdata}`,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
}

async function getCurrentBilibiliUid(sessdata: string): Promise<string> {
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: getBilibiliHeaders(sessdata),
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`获取 B 站登录态失败（HTTP ${res.status}）`);
  }

  const payload = (await res.json()) as BilibiliApiPayload<BilibiliNavData>;
  if (payload.code !== 0 || !payload.data?.isLogin || !payload.data?.mid) {
    throw new Error(
      payload.message || 'B 站登录态无效，请在设置页更新 SESSDATA',
    );
  }

  return String(payload.data.mid);
}

async function fetchBilibiliFollowingListViaApi(
  sessdata: string,
  uid?: string,
): Promise<BilibiliFollowing[]> {
  const resolvedUid = uid?.trim() || (await getCurrentBilibiliUid(sessdata));
  const pageSize = 50;
  let page = 1;
  let total = Infinity;
  const allRows: BilibiliFollowingApiRow[] = [];

  while (allRows.length < total) {
    const url = `https://api.bilibili.com/x/relation/followings?vmid=${encodeURIComponent(resolvedUid)}&pn=${page}&ps=${pageSize}&order=desc`;
    const res = await fetch(url, {
      headers: getBilibiliHeaders(sessdata),
      cache: 'no-store',
    });

    if (!res.ok) {
      throw new Error(`获取 B 站关注列表失败（HTTP ${res.status}）`);
    }

    const payload =
      (await res.json()) as BilibiliApiPayload<BilibiliFollowingsData>;
    if (payload.code !== 0) {
      throw new Error(
        payload.message || `获取 B 站关注列表失败（code ${payload.code}）`,
      );
    }

    const pageRows = Array.isArray(payload.data?.list)
      ? payload.data?.list
      : [];
    total = payload.data?.total ?? pageRows.length;
    allRows.push(...pageRows);

    if (pageRows.length < pageSize) break;
    page += 1;
  }

  return mapFollowingRows(allRows);
}

async function fetchBilibiliFollowingListViaBrowser(
  uid?: string,
): Promise<BilibiliFollowing[]> {
  const requestedUid = uid?.trim() || undefined;
  const pageSize = 50;
  let page = 1;
  const allRows: BilibiliFollowing[] = [];

  while (true) {
    const rawRows = await fetchBrowserBilibiliFollowing({
      uid: requestedUid,
      page,
      limit: pageSize,
    });

    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      break;
    }

    const pageRows = mapFollowingRows(rawRows);
    if (pageRows.length === 0) {
      break;
    }

    allRows.push(...pageRows);
    if (rawRows.length < pageSize) {
      break;
    }
    page += 1;
  }

  return allRows;
}

export async function fetchBilibiliFollowingList(
  uid?: string,
): Promise<BilibiliFollowing[]> {
  try {
    return mapFollowingRows(await fetchBrowserBilibiliFollowingViaBridge(uid));
  } catch (browserError) {
    try {
      return await fetchBilibiliFollowingListViaBrowser(uid);
    } catch {
      // Fall through to SESSDATA fallback below.
    }

    const sessdata = getBilibiliSessdata().trim();
    if (sessdata) {
      return fetchBilibiliFollowingListViaApi(sessdata, uid);
    }

    if (browserError instanceof Error) {
      throw browserError;
    }
    throw new Error(String(browserError));
  }
}
