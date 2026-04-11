import { getDb } from './db';
import { getAppSetting, setAppSetting } from './app-settings';
import { signAndFetchBilibili } from './wbi';

const BILIBILI_SESSDATA_KEY = 'bilibili_sessdata';
const BILIBILI_AI_SUMMARY_ENABLED_KEY = 'bilibili_ai_summary_enabled';

type AuthState = 'valid' | 'missing' | 'invalid' | 'error';

export interface BilibiliAuthStatus {
  state: AuthState;
  message: string;
  enabled: boolean;
  hasStoredSessdata: boolean;
  maskedSessdata: string | null;
  updatedAt: string | null;
}

interface StoredSettingRow {
  value: string | null;
  updated_at: string;
}

function readStoredSessdataRow(): StoredSettingRow | null {
  const row = getDb()
    .prepare('SELECT value, updated_at FROM app_settings WHERE key = ?')
    .get(BILIBILI_SESSDATA_KEY) as StoredSettingRow | undefined;
  return row ?? null;
}

export function getBilibiliSessdata(): string {
  const stored = readStoredSessdataRow()?.value?.trim();
  if (stored) return stored;
  return (process.env.BILIBILI_SESSDATA || '').trim();
}

export function isBilibiliAiSummaryEnabled(): boolean {
  const stored = getAppSetting(BILIBILI_AI_SUMMARY_ENABLED_KEY)?.trim();
  if (!stored) return true;
  return stored !== 'false';
}

export function setBilibiliAiSummaryEnabled(enabled: boolean) {
  setAppSetting(BILIBILI_AI_SUMMARY_ENABLED_KEY, enabled ? 'true' : 'false');
}

export function setBilibiliSessdata(sessdata: string) {
  getDb()
    .prepare(
      `
      INSERT INTO app_settings(key, value, updated_at)
      VALUES(?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `,
    )
    .run(BILIBILI_SESSDATA_KEY, sessdata.trim());
}

export function clearBilibiliSessdata() {
  getDb()
    .prepare('DELETE FROM app_settings WHERE key = ?')
    .run(BILIBILI_SESSDATA_KEY);
}

function maskSessdata(sessdata: string | null): string | null {
  if (!sessdata) return null;
  if (sessdata.length <= 8) return '*'.repeat(sessdata.length);
  return `${sessdata.slice(0, 4)}...${sessdata.slice(-4)}`;
}

function baseStatus(
  state: AuthState,
  message: string,
  overrideSessdata?: string,
): BilibiliAuthStatus {
  const row = readStoredSessdataRow();
  const resolved =
    overrideSessdata?.trim() ||
    row?.value?.trim() ||
    (process.env.BILIBILI_SESSDATA || '').trim() ||
    null;
  return {
    state,
    message,
    enabled: isBilibiliAiSummaryEnabled(),
    hasStoredSessdata: Boolean(resolved),
    maskedSessdata: maskSessdata(resolved),
    updatedAt: row?.updated_at ?? null,
  };
}

async function findTestVideo(sessdata: string) {
  const latestVideo = getDb()
    .prepare(
      `
      SELECT video_id
      FROM videos
      WHERE platform = 'bilibili'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    )
    .get() as { video_id?: string } | undefined;

  if (latestVideo?.video_id) {
    return latestVideo.video_id;
  }

  const navRes = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: {
      Cookie: `SESSDATA=${sessdata}`,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: 'https://www.bilibili.com/',
    },
    cache: 'no-store',
  });
  const navData = await navRes.json();
  if (navData.code === 0 && navData.data?.isLogin) {
    return null;
  }
  throw new Error(navData.message || 'Bilibili auth check failed');
}

export async function validateBilibiliSessdata(
  sessdata: string,
): Promise<BilibiliAuthStatus> {
  const trimmed = sessdata.trim();
  if (!trimmed) {
    return baseStatus('missing', '未配置 SESSDATA');
  }

  try {
    const testVideoId = await findTestVideo(trimmed);
    if (!testVideoId) {
      return baseStatus(
        'valid',
        '登录态有效，但当前还没有可用于 AI 总结测试的 B 站视频',
        trimmed,
      );
    }

    const viewRes = await fetch(
      `https://api.bilibili.com/x/web-interface/view?bvid=${testVideoId}`,
      {
        headers: {
          Cookie: `SESSDATA=${trimmed}`,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://www.bilibili.com/',
        },
        cache: 'no-store',
      },
    );
    const viewData = await viewRes.json();

    if (viewData.code !== 0) {
      return baseStatus(
        'invalid',
        `登录态校验失败：${viewData.message || '无法读取视频信息'}`,
        trimmed,
      );
    }

    const conclusionRes = await signAndFetchBilibili(
      'https://api.bilibili.com/x/web-interface/view/conclusion/get',
      {
        bvid: testVideoId,
        cid: viewData.data.cid,
        up_mid: viewData.data.owner.mid,
      },
      trimmed,
    );
    const conclusionData = await conclusionRes.json();

    if (conclusionData.code === 0) {
      return baseStatus('valid', '登录态有效，AI 总结接口可用', trimmed);
    }

    if (conclusionData.code === -101) {
      return baseStatus(
        'invalid',
        '登录态失效或未登录，请更新 SESSDATA',
        trimmed,
      );
    }

    return baseStatus(
      'valid',
      `登录态有效，AI 总结接口已响应：${conclusionData.message || `code ${conclusionData.code}`}`,
      trimmed,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return baseStatus('error', `校验失败：${message}`, trimmed);
  }
}

export async function getBilibiliAuthStatus(): Promise<BilibiliAuthStatus> {
  return validateBilibiliSessdata(getBilibiliSessdata());
}
