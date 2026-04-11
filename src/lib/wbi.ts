import crypto from 'crypto';

const mixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

function getMixinKey(orig: string): string {
  return mixinKeyEncTab
    .map((n) => orig[n])
    .join('')
    .slice(0, 32);
}

let wbiKeys: { imgKey: string; subKey: string; exp: number } | null = null;

async function fetchWbiKeys() {
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Referer: 'https://www.bilibili.com/',
    },
  });
  const json = await res.json();
  const imgUrl = json.data.wbi_img.img_url;
  const subUrl = json.data.wbi_img.sub_url;

  const imgKey = imgUrl
    .substring(imgUrl.lastIndexOf('/') + 1, imgUrl.length)
    .split('.')[0];
  const subKey = subUrl
    .substring(subUrl.lastIndexOf('/') + 1, subUrl.length)
    .split('.')[0];

  wbiKeys = {
    imgKey,
    subKey,
    exp: Date.now() + 1000 * 60 * 60 * 12, // cache for 12 hours
  };
  return wbiKeys;
}

export async function signAndFetchBilibili(
  baseUrl: string,
  params: Record<string, string | number>,
  sessdata?: string,
) {
  if (!wbiKeys || Date.now() > wbiKeys.exp) {
    await fetchWbiKeys();
  }

  const mixinKey = getMixinKey(wbiKeys!.imgKey + wbiKeys!.subKey);
  const wts = Math.round(Date.now() / 1000);

  const queryObj: Record<string, string | number> = { ...params, wts };
  const sortedParams = Object.keys(queryObj)
    .sort()
    .map((k) => {
      const v = queryObj[k].toString().replace(/[!'()*]/g, '');
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join('&');

  const w_rid = crypto
    .createHash('md5')
    .update(sortedParams + mixinKey)
    .digest('hex');
  const finalUrl = `${baseUrl}?${sortedParams}&w_rid=${w_rid}`;

  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: 'https://space.bilibili.com/',
  };

  if (sessdata) {
    headers['Cookie'] = `SESSDATA=${sessdata}`;
  }

  return fetch(finalUrl, {
    headers,
    cache: 'no-store',
  });
}
