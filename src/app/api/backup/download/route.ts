import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { NextRequest, NextResponse } from 'next/server';
import { createBackupOutputPath, runBackupScript } from '@/lib/backup-system';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseBooleanParam(value: string | null): boolean {
  return value === '1' || value === 'true';
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const includeEnv = parseBooleanParam(searchParams.get('includeEnv'));
  const includeSummaryMd = parseBooleanParam(
    searchParams.get('includeSummaryMd'),
  );
  const outputPath = createBackupOutputPath();

  try {
    await runBackupScript({
      outputPath,
      includeEnv,
      includeSummaryMd,
    });

    const stat = await fs.promises.stat(outputPath);
    const stream = Readable.toWeb(
      fs.createReadStream(outputPath),
    ) as ReadableStream<Uint8Array>;

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Length': String(stat.size),
        'Content-Disposition': `attachment; filename="${path.basename(outputPath)}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '备份失败';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
