import fs from 'node:fs';
import path from 'node:path';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function saveBase64ToFile(
  base64: string,
  filePath: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(filePath, Buffer.from(base64, 'base64'));
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
