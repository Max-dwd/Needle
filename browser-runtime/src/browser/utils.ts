export function wrapForEval(js: string): string {
  if (typeof js !== 'string') return 'undefined';
  const code = js.trim();
  if (!code) return 'undefined';

  if (/^\([\s\S]*\)\s*\(.*\)\s*$/.test(code)) return code;
  if (/^(async\s+)?(\([^)]*\)|[A-Za-z_]\w*)\s*=>/.test(code)) {
    return `(${code})()`;
  }
  if (/^(async\s+)?function[\s(]/.test(code)) return `(${code})()`;

  return code;
}
