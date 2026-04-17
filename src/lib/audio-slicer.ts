import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const FFMPEG_CANDIDATES = [
  process.env.FFMPEG_BIN,
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  'ffmpeg',
].filter((value): value is string => Boolean(value && value.trim()));

export interface AudioSliceRange {
  index: number;
  offsetSec: number;
  endSec: number;
}

export interface SliceAudioOptions {
  paddingSeconds?: number;
  signal?: AbortSignal;
}

function pickFfmpegBinary(): string {
  for (const candidate of FFMPEG_CANDIDATES) {
    if (candidate.includes(path.sep)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    return candidate;
  }
  throw new Error('ffmpeg binary not found');
}

export async function sliceAudioByRange(
  audioPath: string,
  outputDir: string,
  range: AudioSliceRange,
  options: SliceAudioOptions = {},
): Promise<string> {
  fs.mkdirSync(outputDir, { recursive: true });
  const paddingSeconds = options.paddingSeconds ?? 0.5;
  const startSeconds = Math.max(0, range.offsetSec - paddingSeconds);
  const endSeconds = Math.max(startSeconds + 1, range.endSec + paddingSeconds);
  const outputPath = path.join(
    outputDir,
    `${path.parse(audioPath).name}.whisper-batch-${String(range.index).padStart(3, '0')}.mp3`,
  );

  const timeoutSignal = AbortSignal.timeout(5 * 60 * 1000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  await execFileAsync(
    pickFfmpegBinary(),
    [
      '-y',
      '-ss',
      String(startSeconds),
      '-t',
      String(endSeconds - startSeconds),
      '-i',
      audioPath,
      '-vn',
      '-acodec',
      'copy',
      outputPath,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    } as Parameters<typeof execFileAsync>[2],
  );

  return outputPath;
}
