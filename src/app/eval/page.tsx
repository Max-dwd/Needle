'use client';

import { FormEvent, ReactNode, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  GitCompareArrows,
  Loader2,
  Play,
} from 'lucide-react';
import styles from './eval.module.css';

interface EvalSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

interface EvalSubtitleSuccess {
  ok: true;
  subtitle: {
    language: string;
    format: string;
    text: string;
    sourceMethod: string | null;
    segmentStyle: 'coarse' | 'fine' | null;
    metadata: Record<string, string | number>;
    segments: EvalSegment[];
  };
}

interface EvalSubtitleFailure {
  ok: false;
  error: string;
}

interface EvalResponse {
  video: {
    platform: 'youtube' | 'bilibili';
    videoId: string;
    url: string;
    title: string;
    channelName: string | null;
    duration: string | null;
    thumbnailUrl: string | null;
  };
  startedAt: string;
  completedAt: string;
  browser: EvalSubtitleSuccess | EvalSubtitleFailure;
  llmAligner: EvalSubtitleSuccess | EvalSubtitleFailure;
}

interface CompareRow {
  id: string;
  browser: EvalSegment | null;
  llmAligner: EvalSegment | null;
  similarity: number | null;
  startDelta: number | null;
  status:
    | 'match'
    | 'text-diff'
    | 'timing-diff'
    | 'browser-only'
    | 'aligner-only';
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function lcsMask(reference: string, hypothesis: string) {
  const a = Array.from(reference);
  const b = Array.from(hypothesis);
  const dp = Array.from(
    { length: a.length + 1 },
    () => new Uint16Array(b.length + 1),
  );

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] =
        a[i] === b[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const aKeep = new Array(a.length).fill(false);
  const bKeep = new Array(b.length).fill(false);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      aKeep[i] = true;
      bKeep[j] = true;
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return { aKeep, bKeep, length: dp[0]![0]! };
}

function textSimilarity(left: string, right: string): number {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  return lcsMask(a, b).length / Math.max(a.length, b.length);
}

function overlapSeconds(left: EvalSegment, right: EvalSegment): number {
  return Math.max(
    0,
    Math.min(left.end, right.end) - Math.max(left.start, right.start),
  );
}

function buildCompareRows(
  browserSegments: EvalSegment[],
  alignerSegments: EvalSegment[],
): CompareRow[] {
  const usedAligner = new Set<number>();
  const rows: CompareRow[] = [];

  for (const [browserIndex, browser] of browserSegments.entries()) {
    let bestIndex = -1;
    let bestScore = 0;

    for (const [alignerIndex, aligner] of alignerSegments.entries()) {
      if (usedAligner.has(alignerIndex)) continue;
      const overlap = overlapSeconds(browser, aligner);
      const timingDistance = Math.abs(browser.start - aligner.start);
      const score =
        overlap > 0
          ? overlap + textSimilarity(browser.text, aligner.text)
          : timingDistance <= 2.5
            ? 0.25 + textSimilarity(browser.text, aligner.text)
            : 0;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = alignerIndex;
      }
    }

    const llmAligner = bestIndex >= 0 ? alignerSegments[bestIndex]! : null;
    if (bestIndex >= 0) usedAligner.add(bestIndex);

    const similarity = llmAligner
      ? textSimilarity(browser.text, llmAligner.text)
      : null;
    const startDelta = llmAligner ? llmAligner.start - browser.start : null;
    const status = !llmAligner
      ? 'browser-only'
      : similarity !== null &&
          similarity >= 0.92 &&
          Math.abs(startDelta || 0) <= 0.8
        ? 'match'
        : similarity !== null && similarity >= 0.92
          ? 'timing-diff'
          : 'text-diff';

    rows.push({
      id: `browser-${browserIndex}`,
      browser,
      llmAligner,
      similarity,
      startDelta,
      status,
    });
  }

  for (const [alignerIndex, llmAligner] of alignerSegments.entries()) {
    if (usedAligner.has(alignerIndex)) continue;
    rows.push({
      id: `aligner-${alignerIndex}`,
      browser: null,
      llmAligner,
      similarity: null,
      startDelta: null,
      status: 'aligner-only',
    });
  }

  return rows.sort((left, right) => {
    const leftStart = left.browser?.start ?? left.llmAligner?.start ?? 0;
    const rightStart = right.browser?.start ?? right.llmAligner?.start ?? 0;
    return leftStart - rightStart;
  });
}

function formatTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '--:--';
  const safe = Math.max(0, seconds);
  const total = Math.floor(safe);
  const ms = Math.round((safe - total) * 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const prefix = h > 0 ? `${String(h).padStart(2, '0')}:` : '';
  return `${prefix}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function diffText(
  value: string,
  peer: string | null,
  side: 'reference' | 'hypothesis',
): ReactNode {
  if (!peer) return value;
  const chars = Array.from(value);
  const { aKeep, bKeep } =
    side === 'reference' ? lcsMask(value, peer) : lcsMask(peer, value);
  const keepMask = side === 'reference' ? aKeep : bKeep;
  const normalizedLength = normalizeText(value).length;
  const peerLength = normalizeText(peer).length;

  if (
    normalizedLength === 0 ||
    peerLength === 0 ||
    textSimilarity(value, peer) >= 0.985
  ) {
    return value;
  }

  return chars.map((char, index) => (
    <span
      key={`${char}-${index}`}
      className={keepMask[index] ? undefined : styles.diffChar}
    >
      {char}
    </span>
  ));
}

function statusLabel(status: CompareRow['status']) {
  switch (status) {
    case 'match':
      return '一致';
    case 'timing-diff':
      return '时间偏移';
    case 'text-diff':
      return '文本差异';
    case 'browser-only':
      return '仅原字幕';
    case 'aligner-only':
      return '仅 aligner';
  }
}

function ResultSummary({ result }: { result: EvalResponse }) {
  const browserCount = result.browser.ok
    ? result.browser.subtitle.segments.length
    : 0;
  const alignerCount = result.llmAligner.ok
    ? result.llmAligner.subtitle.segments.length
    : 0;
  const rows =
    result.browser.ok && result.llmAligner.ok
      ? buildCompareRows(
          result.browser.subtitle.segments,
          result.llmAligner.subtitle.segments,
        )
      : [];
  const changed = rows.filter((row) => row.status !== 'match').length;
  const avgSimilarity =
    rows.length > 0
      ? rows.reduce((sum, row) => sum + (row.similarity ?? 0), 0) / rows.length
      : null;

  return (
    <section className={styles.summaryGrid}>
      <div className={styles.metric}>
        <span>Browser</span>
        <strong>{browserCount}</strong>
      </div>
      <div className={styles.metric}>
        <span>LLM Aligner</span>
        <strong>{alignerCount}</strong>
      </div>
      <div className={styles.metric}>
        <span>差异行</span>
        <strong>{changed}</strong>
      </div>
      <div className={styles.metric}>
        <span>平均相似度</span>
        <strong>
          {avgSimilarity === null
            ? '--'
            : `${Math.round(avgSimilarity * 100)}%`}
        </strong>
      </div>
    </section>
  );
}

function SourceStatus({
  title,
  result,
}: {
  title: string;
  result: EvalSubtitleSuccess | EvalSubtitleFailure;
}) {
  return (
    <div className={styles.sourceStatus}>
      <div className={styles.sourceStatusTitle}>
        {result.ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
        <strong>{title}</strong>
      </div>
      {result.ok ? (
        <span>
          {result.subtitle.sourceMethod || result.subtitle.format} ·{' '}
          {result.subtitle.segments.length} segments
        </span>
      ) : (
        <span className={styles.errorText}>{result.error}</span>
      )}
    </div>
  );
}

export default function EvalHarnessPage() {
  const [url, setUrl] = useState('');
  const [result, setResult] = useState<EvalResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const rows = useMemo(() => {
    if (!result?.browser.ok || !result.llmAligner.ok) return [];
    return buildCompareRows(
      result.browser.subtitle.segments,
      result.llmAligner.subtitle.segments,
    );
  }, [result]);

  async function runEval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedUrl = url.trim();
    if (!trimmedUrl || loading) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch('/api/eval/subtitles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: trimmedUrl }),
      });
      const payload = (await response.json()) as
        | EvalResponse
        | { error?: string };
      if (!response.ok) {
        throw new Error(
          'error' in payload && payload.error
            ? payload.error
            : 'Eval request failed',
        );
      }
      setResult(payload as EvalResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.kicker}>
            <GitCompareArrows size={16} />
            Eval Harness
          </div>
          <h1>字幕对齐对比</h1>
        </div>
        <form className={styles.form} onSubmit={runEval}>
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            spellCheck={false}
          />
          <button type="submit" disabled={loading || !url.trim()}>
            {loading ? (
              <Loader2 size={18} className={styles.spin} />
            ) : (
              <Play size={18} />
            )}
            <span>{loading ? '运行中' : '运行'}</span>
          </button>
        </form>
      </header>

      {error ? (
        <div className={styles.errorBanner}>
          <AlertTriangle size={18} />
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className={styles.loadingPanel}>
          <Loader2 size={22} className={styles.spin} />
          <span>并行运行 Needle Browser 原字幕获取和 llm-aligner 提取任务</span>
        </div>
      ) : null}

      {result ? (
        <>
          <section className={styles.videoBand}>
            {result.video.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={result.video.thumbnailUrl} alt="" />
            ) : null}
            <div>
              <div className={styles.platform}>{result.video.platform}</div>
              <h2>{result.video.title}</h2>
              <p>
                {result.video.channelName || result.video.videoId}
                {result.video.duration ? ` · ${result.video.duration}` : ''}
              </p>
            </div>
          </section>

          <ResultSummary result={result} />

          <section className={styles.statusGrid}>
            <SourceStatus title="Browser 原字幕" result={result.browser} />
            <SourceStatus title="LLM Aligner" result={result.llmAligner} />
          </section>

          {rows.length > 0 ? (
            <section className={styles.compareTable}>
              <div className={styles.tableHead}>
                <span>时间</span>
                <span>Browser 原字幕</span>
                <span>LLM Aligner</span>
                <span>状态</span>
              </div>
              {rows.map((row) => (
                <article
                  key={row.id}
                  className={`${styles.compareRow} ${styles[row.status]}`}
                >
                  <div className={styles.timeCell}>
                    <strong>
                      {formatTime(
                        row.browser?.start ?? row.llmAligner?.start ?? null,
                      )}
                    </strong>
                    <span>
                      {row.startDelta === null
                        ? ''
                        : `${row.startDelta >= 0 ? '+' : ''}${row.startDelta.toFixed(2)}s`}
                    </span>
                  </div>
                  <div className={styles.subtitleCell}>
                    {row.browser ? (
                      <>
                        <span className={styles.range}>
                          {formatTime(row.browser.start)} -{' '}
                          {formatTime(row.browser.end)}
                        </span>
                        <p>
                          {diffText(
                            row.browser.text,
                            row.llmAligner?.text || null,
                            'reference',
                          )}
                        </p>
                      </>
                    ) : (
                      <p className={styles.missing}>--</p>
                    )}
                  </div>
                  <div className={styles.subtitleCell}>
                    {row.llmAligner ? (
                      <>
                        <span className={styles.range}>
                          {formatTime(row.llmAligner.start)} -{' '}
                          {formatTime(row.llmAligner.end)}
                        </span>
                        <p>
                          {diffText(
                            row.llmAligner.text,
                            row.browser?.text || null,
                            'hypothesis',
                          )}
                        </p>
                      </>
                    ) : (
                      <p className={styles.missing}>--</p>
                    )}
                  </div>
                  <div className={styles.statusCell}>
                    <span>{statusLabel(row.status)}</span>
                    {row.similarity === null ? null : (
                      <small>{Math.round(row.similarity * 100)}%</small>
                    )}
                  </div>
                </article>
              ))}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
