export const BROWSER_METHOD_ID = 'browser' as const;

export type BrowserMethodId = typeof BROWSER_METHOD_ID;

export function isBrowserMethodId(value: string | null | undefined): boolean {
  return String(value || '')
    .trim()
    .toLowerCase() === BROWSER_METHOD_ID;
}

export function getBrowserMethodLabel(
  value: string | null | undefined,
): string {
  return isBrowserMethodId(value) ? 'Needle Browser' : String(value || '');
}
