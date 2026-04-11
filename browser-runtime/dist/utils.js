import fs from 'node:fs';
import path from 'node:path';
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export async function saveBase64ToFile(base64, filePath) {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(filePath, Buffer.from(base64, 'base64'));
}
export function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
