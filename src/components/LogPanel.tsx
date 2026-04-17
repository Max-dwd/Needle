'use client';

import { useEffect, useRef, useState } from 'react';
import type { LogEntry, LogLevel, LogScope, LogStats } from '@/types';

interface LogPanelProps {
  visible: boolean;
  onClose: () => void;
}

interface LogViewerProps {
  active: boolean;
  embedded?: boolean;
  showCloseButton?: boolean;
  onClose?: () => void;
}

type PanelTab = 'overview' | 'detail';
type LogResponse = {
  entries?: LogEntry[];
  logs?: string[];
};

interface MethodStats {
  attempts: number;
  successes: number;
  failures: number;
}

const CORE_LOG_KEYS = new Set(['ts', 'level', 'scope', 'event']);

const ERROR_TYPE_LABELS: Record<string, string> = {
  no_subtitle: '无字幕',
  members_only: '会员限定',
  empty: '内容为空',
  rate_limit: '频率限制',
  timeout: '超时',
  no_pipeline: '无来源',
  api_error: 'API错误',
  unknown: '未知',
};
const ENTRY_LIMIT = 200;

const SCOPE_META: Array<{ key: LogScope; label: string; icon: string }> = [
  { key: 'feed', label: 'Feed', icon: '📡' },
  { key: 'subtitle', label: 'Subtitle', icon: '💬' },
  { key: 'summary', label: 'AI总结', icon: '✨' },
  { key: 'api', label: 'API', icon: '🧩' },
  { key: 'system', label: 'System', icon: '⚙️' },
  { key: 'enrichment', label: 'Enrichment', icon: '🔍' },
];

function formatTimestampLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function entryMatchesFilters(
  entry: LogEntry,
  levelFilter: string,
  scopeFilter: string,
  platformFilter: string,
) {
  if (levelFilter && entry.level !== levelFilter) return false;
  if (scopeFilter && entry.scope !== scopeFilter) return false;
  if (
    platformFilter &&
    (typeof entry.platform !== 'string' || entry.platform !== platformFilter)
  ) {
    return false;
  }
  return true;
}

function getEntryTags(entry: LogEntry): Array<[string, string]> {
  return Object.entries(entry)
    .filter(([key]) => !CORE_LOG_KEYS.has(key))
    .map(([key, value]) => {
      if (typeof value === 'string') return [key, value];
      if (
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === null
      ) {
        return [key, String(value)];
      }
      return [key, JSON.stringify(value)];
    });
}

/* ── Sub-components ── */

function StatNumber({
  value,
  label,
  color,
}: {
  value: number | string;
  label: string;
  color?: string;
}) {
  return (
    <div className="log-stat-number">
      <div className="log-stat-value" style={color ? { color } : undefined}>
        {value}
      </div>
      <div className="log-stat-label">{label}</div>
    </div>
  );
}

function SuccessRateRing({ rate }: { rate: number }) {
  const r = 28;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - rate / 100);
  const color = rate >= 90 ? '#10b981' : rate >= 70 ? '#f59e0b' : '#ef4444';

  return (
    <div className="log-stat-ring-wrap">
      <svg width="72" height="72" viewBox="0 0 72 72">
        <circle
          cx="36"
          cy="36"
          r={r}
          fill="none"
          stroke="var(--border)"
          strokeWidth="5"
        />
        <circle
          cx="36"
          cy="36"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          transform="rotate(-90 36 36)"
          style={{ transition: 'stroke-dashoffset 0.6s ease' }}
        />
      </svg>
      <div className="log-stat-ring-text">
        <span className="log-stat-ring-value" style={{ color }}>
          {rate}%
        </span>
        <span className="log-stat-ring-label">成功率</span>
      </div>
    </div>
  );
}

function MethodBar({ name, stats }: { name: string; stats: MethodStats }) {
  const total = stats.attempts || 1;
  const successPct = (stats.successes / total) * 100;
  const failPct = (stats.failures / total) * 100;

  return (
    <div className="log-method-row">
      <span className="log-method-name">{name}</span>
      <div className="log-method-bar">
        <div
          className="log-method-bar-fill success"
          style={{ width: `${successPct}%` }}
        />
        <div
          className="log-method-bar-fill failure"
          style={{ width: `${failPct}%` }}
        />
      </div>
      <span className="log-method-count">
        <span style={{ color: '#10b981' }}>{stats.successes}</span>
        {stats.failures > 0 && (
          <span style={{ color: '#ef4444' }}>/{stats.failures}</span>
        )}
      </span>
    </div>
  );
}

function ScopeStatsCard({
  scope,
  label,
  icon,
  stats,
}: {
  scope: string;
  label: string;
  icon: string;
  stats: LogStats['feed'];
}) {
  const methods = Object.entries(stats.byMethod).sort(
    (a, b) => b[1].attempts - a[1].attempts,
  );
  const platforms = Object.entries(stats.byPlatform).sort(
    (a, b) => b[1] - a[1],
  );
  const decided = stats.successes + stats.failures;

  return (
    <div className={`log-scope-card scope-${scope}`}>
      <div className="log-scope-header">
        <span className="log-scope-title">
          <span>{icon}</span>
          <span>{label}</span>
        </span>
        {platforms.length > 0 && (
          <span className="log-scope-platforms">
            {platforms.map(([platform]) => (
              <span
                key={platform}
                className={`log-platform-tag platform-${platform}`}
              >
                {platform}
              </span>
            ))}
          </span>
        )}
      </div>

      <div className="log-scope-body">
        <div className="log-scope-summary">
          <SuccessRateRing rate={stats.successRate} />
          <div className="log-scope-counters">
            <StatNumber value={stats.attempts} label="尝试" />
            <StatNumber value={stats.successes} label="成功" color="#10b981" />
            <StatNumber
              value={stats.failures}
              label="失败"
              color={stats.failures > 0 ? '#ef4444' : undefined}
            />
            {stats.fallbacks > 0 && (
              <StatNumber
                value={stats.fallbacks}
                label="降级"
                color="#f59e0b"
              />
            )}
          </div>
        </div>

        {methods.length > 0 && (
          <div className="log-scope-section">
            <div className="log-scope-section-title">方法分布</div>
            <div className="log-method-list">
              {methods.map(([name, ms]) => (
                <MethodBar key={name} name={name} stats={ms} />
              ))}
            </div>
          </div>
        )}

        {Object.keys(stats.byErrorType).length > 0 && (
          <div className="log-scope-section">
            <div className="log-scope-section-title">失败类型</div>
            <div className="log-error-type-list">
              {Object.entries(stats.byErrorType)
                .sort((a, b) => b[1] - a[1])
                .map(([type, count]) => (
                  <div key={type} className="log-error-type-row">
                    <span
                      className={`log-error-type-badge error-type-${type}`}
                    >
                      {ERROR_TYPE_LABELS[type] ?? type}
                    </span>
                    <span className="log-error-type-count">{count}</span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {stats.recentErrors.length > 0 && (
          <div className="log-scope-section">
            <div className="log-scope-section-title">最近错误</div>
            <div className="log-error-list">
              {stats.recentErrors.map((err, index) => (
                <div key={`${err.time}-${index}`} className="log-error-row">
                  <span className="log-error-time">{err.time}</span>
                  <span className="log-error-method">{err.method}</span>
                  {err.error_type && (
                    <span
                      className={`log-error-type-badge error-type-${err.error_type}`}
                    >
                      {ERROR_TYPE_LABELS[err.error_type] ?? err.error_type}
                    </span>
                  )}
                  <span className="log-error-msg">{err.error}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {decided === 0 && <div className="log-scope-empty">暂无活动记录</div>}
      </div>
    </div>
  );
}

function OverviewTab({
  stats,
  loading,
}: {
  stats: LogStats | null;
  loading: boolean;
}) {
  if (loading && !stats) {
    return (
      <div className="log-overview-loading">
        <div className="log-overview-loading-text">加载统计数据…</div>
      </div>
    );
  }

  if (!stats || stats.total === 0) {
    return <div className="log-empty">暂无日志记录</div>;
  }

  return (
    <div className="log-overview">
      <div className="log-overview-summary">
        <div className="log-overview-total">
          <span className="log-overview-total-value">{stats.total}</span>
          <span className="log-overview-total-label">条日志</span>
        </div>
        <div className="log-overview-levels">
          <span className="log-level-count level-info">
            <span className="log-level-dot" style={{ background: '#3b82f6' }} />
            INFO {stats.byLevel.info || 0}
          </span>
          <span className="log-level-count level-warn">
            <span className="log-level-dot" style={{ background: '#f59e0b' }} />
            WARN {stats.byLevel.warn || 0}
          </span>
          <span className="log-level-count level-error">
            <span className="log-level-dot" style={{ background: '#ef4444' }} />
            ERROR {stats.byLevel.error || 0}
          </span>
        </div>
      </div>

      <div className="log-scope-grid">
        <ScopeStatsCard
          scope="feed"
          label="订阅抓取"
          icon="📡"
          stats={stats.feed}
        />
        <ScopeStatsCard
          scope="subtitle"
          label="字幕抓取"
          icon="💬"
          stats={stats.subtitle}
        />
        <ScopeStatsCard
          scope="summary"
          label="AI 总结"
          icon="✨"
          stats={stats.summary}
        />
      </div>
    </div>
  );
}

function DetailTab({
  entries,
  levelFilter,
  setLevelFilter,
  scopeFilter,
  setScopeFilter,
  platformFilter,
  setPlatformFilter,
}: {
  entries: LogEntry[];
  levelFilter: string;
  setLevelFilter: (v: string) => void;
  scopeFilter: string;
  setScopeFilter: (v: string) => void;
  platformFilter: string;
  setPlatformFilter: (v: string) => void;
}) {
  const levelButtons: Array<{ key: '' | LogLevel; label: string }> = [
    { key: '', label: '全部' },
    { key: 'debug', label: 'Debug' },
    { key: 'info', label: 'Info' },
    { key: 'warn', label: 'Warn' },
    { key: 'error', label: 'Error' },
  ];

  const scopeButtons = [
    { key: '', label: '全部' },
    ...SCOPE_META.map((scope) => ({ key: scope.key, label: scope.label })),
  ];

  const platformButtons = [
    { key: '', label: '全部平台' },
    { key: 'youtube', label: 'YouTube' },
    { key: 'bilibili', label: 'Bilibili' },
  ];

  return (
    <div className="log-detail">
      <div className="log-detail-filters">
        <div className="log-level-filters">
          {levelButtons.map((btn) => (
            <button
              key={btn.key}
              type="button"
              className={`log-level-btn ${levelFilter === btn.key ? 'active' : ''}`}
              onClick={() => setLevelFilter(btn.key)}
            >
              {btn.label}
            </button>
          ))}
        </div>
        <div className="log-level-filters">
          {scopeButtons.map((btn) => (
            <button
              key={btn.key}
              type="button"
              className={`log-level-btn ${scopeFilter === btn.key ? 'active' : ''}`}
              onClick={() => setScopeFilter(btn.key)}
            >
              {btn.label}
            </button>
          ))}
        </div>
        <div className="log-level-filters">
          {platformButtons.map((btn) => (
            <button
              key={btn.key}
              type="button"
              className={`log-level-btn ${platformFilter === btn.key ? 'active' : ''}`}
              onClick={() => setPlatformFilter(btn.key)}
            >
              {btn.label}
            </button>
          ))}
        </div>
      </div>

      <div className="log-timeline">
        {entries.length === 0 ? (
          <div className="log-empty">暂无匹配日志</div>
        ) : (
          entries.map((entry, index) => {
            const scopeMeta = SCOPE_META.find((scope) => scope.key === entry.scope);
            const tags = getEntryTags(entry);

            return (
              <div
                key={`${entry.ts}-${entry.scope}-${entry.event}-${index}`}
                className={`log-timeline-item level-${entry.level}`}
              >
                <div className="log-timeline-dot" />
                <div className="log-timeline-content">
                  <div className="log-timeline-meta">
                    <span className={`log-level-pill level-${entry.level}`}>
                      {entry.level.toUpperCase()}
                    </span>
                    <span className="log-timeline-scope">
                      {scopeMeta?.icon} {scopeMeta?.label || entry.scope}
                    </span>
                    <time className="log-time">
                      {formatTimestampLabel(entry.ts)}
                    </time>
                  </div>
                  <div className="log-timeline-message">{entry.event}</div>
                  {tags.length > 0 && (
                    <div className="log-timeline-tags">
                      {tags.map(([key, value]) => (
                        <span
                          key={`${entry.ts}-${key}`}
                          className={`log-kv-tag ${key === 'error' ? 'tag-error' : ''}`}
                        >
                          <span className="log-kv-key">{key}</span>
                          <span className="log-kv-value">{value}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function LogViewer({
  active,
  embedded = false,
  showCloseButton = true,
  onClose,
}: LogViewerProps) {
  const [tab, setTab] = useState<PanelTab>('overview');
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<LogStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [levelFilter, setLevelFilter] = useState('');
  const [scopeFilter, setScopeFilter] = useState('');
  const [platformFilter, setPlatformFilter] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    setLoading(true);

    const fetchEntries = async () => {
      const params = new URLSearchParams({ lines: String(ENTRY_LIMIT) });
      params.set('_ts', String(Date.now()));
      if (levelFilter) params.set('level', levelFilter);
      if (scopeFilter) params.set('scope', scopeFilter);
      if (platformFilter) params.set('platform', platformFilter);

      const response = await fetch(`/api/logs?${params.toString()}`, {
        cache: 'no-store',
      });
      const data = (await response.json()) as LogResponse;
      if (cancelled) return;
      setEntries(Array.isArray(data.entries) ? data.entries : []);
    };

    const fetchStats = async () => {
      const response = await fetch(`/api/logs/stats?_ts=${Date.now()}`, {
        cache: 'no-store',
      });
      const data = (await response.json()) as LogStats;
      if (cancelled) return;
      setStats(data);
    };

    Promise.all([fetchEntries(), fetchStats()])
      .catch(() => {
        if (cancelled) return;
        setEntries([]);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [active, levelFilter, scopeFilter, platformFilter]);

  useEffect(() => {
    if (!active) return;

    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/logs/stats?_ts=${Date.now()}`, {
          cache: 'no-store',
        });
        const data = (await response.json()) as LogStats;
        setStats(data);
      } catch {
        // Keep last stats snapshot on transient polling failures.
      }
    }, 8000);

    return () => clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (!active) return;

    const source = new EventSource('/api/sse');
    const onLogEntry = (event: MessageEvent<string>) => {
      try {
        const entry = JSON.parse(event.data) as LogEntry;
        if (
          !entryMatchesFilters(
            entry,
            levelFilter,
            scopeFilter,
            platformFilter,
          )
        ) {
          return;
        }
        setEntries((current) => [entry, ...current].slice(0, ENTRY_LIMIT));
      } catch {
        // Ignore malformed SSE payloads.
      }
    };

    source.addEventListener('log-entry', onLogEntry as EventListener);

    return () => {
      source.removeEventListener('log-entry', onLogEntry as EventListener);
      source.close();
    };
  }, [active, levelFilter, scopeFilter, platformFilter]);

  if (!active) return null;

  const fetchData = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ lines: String(ENTRY_LIMIT) });
      params.set('_ts', String(Date.now()));
      if (levelFilter) params.set('level', levelFilter);
      if (scopeFilter) params.set('scope', scopeFilter);
      if (platformFilter) params.set('platform', platformFilter);

      const [logsRes, statsRes] = await Promise.all([
        fetch(`/api/logs?${params.toString()}`, { cache: 'no-store' }),
        fetch(`/api/logs/stats?_ts=${Date.now()}`, { cache: 'no-store' }),
      ]);
      const [logsData, statsData] = (await Promise.all([
        logsRes.json(),
        statsRes.json(),
      ])) as [LogResponse, LogStats];
      setEntries(Array.isArray(logsData.entries) ? logsData.entries : []);
      setStats(statsData);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  const filteredEntries = entries.filter((entry) =>
    entryMatchesFilters(entry, levelFilter, scopeFilter, platformFilter),
  );

  const tabs: Array<{ key: PanelTab; label: string; icon: string }> = [
    { key: 'overview', label: '概览', icon: '📊' },
    { key: 'detail', label: '详情', icon: '📋' },
  ];

  const content = (
    <div className={`log-panel ${embedded ? 'log-panel-embedded' : ''}`}>
      <div className="log-panel-header">
        <div className="log-panel-title">
          <span className="log-panel-icon">📋</span>
          系统日志
        </div>
        <div className="log-panel-controls">
          <div className="log-tab-bar">
            {tabs.map((tabOption) => (
              <button
                key={tabOption.key}
                type="button"
                className={`log-tab-btn ${tab === tabOption.key ? 'active' : ''}`}
                onClick={() => setTab(tabOption.key)}
              >
                <span>{tabOption.icon}</span>
                <span>{tabOption.label}</span>
                {tab === tabOption.key && <span className="log-tab-indicator" />}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="log-refresh-btn"
            onClick={() => {
              void fetchData();
            }}
            disabled={loading}
            title="刷新"
          >
            {loading ? '⏳' : '↻'}
          </button>
          {showCloseButton && onClose && (
            <button type="button" className="log-close-btn" onClick={onClose}>
              ×
            </button>
          )}
        </div>
      </div>
      <div ref={containerRef} className="log-panel-body">
        {tab === 'overview' ? (
          <OverviewTab stats={stats} loading={loading} />
        ) : (
          <DetailTab
            entries={filteredEntries}
            levelFilter={levelFilter}
            setLevelFilter={setLevelFilter}
            scopeFilter={scopeFilter}
            setScopeFilter={setScopeFilter}
            platformFilter={platformFilter}
            setPlatformFilter={setPlatformFilter}
          />
        )}
      </div>
    </div>
  );

  if (embedded) {
    return content;
  }

  return (
    <div className="log-panel-overlay" onClick={onClose}>
      <div onClick={(event) => event.stopPropagation()}>{content}</div>
    </div>
  );
}

export function LogPanel({ visible, onClose }: LogPanelProps) {
  return (
    <LogViewer
      active={visible}
      embedded={false}
      showCloseButton
      onClose={onClose}
    />
  );
}

export { LogViewer };

export default LogPanel;
