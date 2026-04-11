import { NextRequest, NextResponse } from 'next/server';
import {
  getBilibiliSessdata,
  isBilibiliAiSummaryEnabled,
} from '@/lib/bilibili-auth';
import { signAndFetchBilibili } from '@/lib/wbi';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const bvid = searchParams.get('bvid');

  if (!bvid) {
    return NextResponse.json(
      { error: 'Missing bvid parameter' },
      { status: 400 },
    );
  }

  try {
    if (!isBilibiliAiSummaryEnabled()) {
      return NextResponse.json(
        {
          error: 'Bilibili AI summary disabled',
          details: 'B站 AI 总结功能已关闭，请前往设置开启',
          authExpired: false,
          disabled: true,
        },
        { status: 200 },
      );
    }

    const sessdata = getBilibiliSessdata();

    // 1. Fetch video view info to get cid and up_mid
    const viewRes = await fetch(
      `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
      {
        headers: sessdata ? { Cookie: `SESSDATA=${sessdata}` } : {},
      },
    );
    const viewData = await viewRes.json();

    if (viewData.code !== 0) {
      return NextResponse.json(
        { error: 'Failed to fetch video view info', details: viewData.message },
        { status: 400 },
      );
    }

    const cid = viewData.data.cid;
    const up_mid = viewData.data.owner.mid;

    // 2. Fetch AI conclusion using wbi signed request
    const conclusionRes = await signAndFetchBilibili(
      'https://api.bilibili.com/x/web-interface/view/conclusion/get',
      {
        bvid: bvid,
        cid: cid,
        up_mid: up_mid,
      },
      sessdata,
    );

    const conclusionData = await conclusionRes.json();

    if (conclusionData.code !== 0) {
      const authExpired = conclusionData.code === -101;
      return NextResponse.json(
        {
          error: authExpired
            ? 'Bilibili auth expired'
            : 'Failed to fetch conclusion',
          details: conclusionData.message,
          code: conclusionData.code,
          authExpired,
        },
        { status: 200 },
      );
    }

    return NextResponse.json(conclusionData.data);
  } catch (error) {
    console.error('Error fetching Bilibili summary:', error);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 },
    );
  }
}
