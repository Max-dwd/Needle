'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildChannelUrl } from '@/lib/url-utils';

/* ─── Types ─────────────────────────────────────────────────────────────── */

interface YoutubeChannel {
  channel_id: string;
  name: string;
  avatar_url?: string;
  description?: string;
  subscribed: boolean;
}

interface BilibiliFollowing {
  mid: number;
  uname: string;
  face: string;
  sign: string;
  subscribed: boolean;
}

type YtPhase =
  | 'opening-browser'
  | 'await-login'
  | 'loading'
  | 'loaded'
  | 'importing'
  | 'done'
  | 'error';
type BiliPhase =
  | 'opening-browser'
  | 'await-login'
  | 'loading-following'
  | 'select'
  | 'importing'
  | 'done'
  | 'fallback';

export interface UnifiedImportModalProps {
  hasCookiesBrowser: boolean;
  onClose: () => void;
  onImported: () => void;
  variant?: 'modal' | 'inline';
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function getYoutubeUrl(channelId: string) {
  const value = String(channelId || '').trim();
  if (!value) return 'https://www.youtube.com/';
  return buildChannelUrl('youtube', normalizeYoutubeChannelId(value));
}

function normalizeYoutubeChannelId(channelId: string) {
  const value = String(channelId || '')
    .trim()
    .replace(/^https?:\/\/(?:www\.)?youtube\.com/i, '')
    .replace(/^\/+/, '');
  if (!value) return '';
  if (value.startsWith('@')) return value;
  if (value.startsWith('channel/')) return value.slice('channel/'.length);
  return value;
}
const getBilibiliUrl = (mid: number) => `https://space.bilibili.com/${mid}`;

async function requestJson<T>(
  input: RequestInfo,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(
      (payload as { error?: string }).error || `请求失败 (${res.status})`,
    );
  }
  return res.json() as Promise<T>;
}

function formatBiliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Failed to fetch/i.test(message))
    return '无法连接导入接口。通常是 Needle Browser daemon 没启动或 Browser Bridge 未连接。';
  return message || '未知错误';
}

function getBiliErrorHint(message: string): string {
  if (
    /账号未登录|登录态|SESSDATA|Not logged in|Requires browser|cookie/i.test(
      message,
    )
  )
    return '请先在 Needle Browser 受控浏览器里登录 B 站；如果仍失败，去设置页更新 SESSDATA 作为兜底。';
  if (/chrome:\/\/extensions|browser-bridge\/extension|browser:bridge:(?:build|prepare)/i.test(message))
    return message;
  if (/Browser Bridge|daemon/i.test(message))
    return '请确认 Needle Browser Bridge 扩展已在受控浏览器中连接。';
  return '如果浏览器登录流程走不通，直接去设置页更新 SESSDATA 也可以完成导入。';
}

function formatYoutubeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Failed to fetch/i.test(message))
    return '无法连接 YouTube 导入接口。通常是 Needle Browser daemon 没启动或 Browser Bridge 未连接。';
  return message || '未知错误';
}

function getYoutubeErrorHint(message: string): string {
  if (/YouTube|Sign in|登录/i.test(message))
    return '请先在 Needle Browser 受控浏览器里登录 YouTube，然后再继续抓取订阅列表。';
  if (/chrome:\/\/extensions|browser-bridge\/extension|browser:bridge:(?:build|prepare)/i.test(message))
    return message;
  if (/Browser Bridge|daemon/i.test(message))
    return '请确认 Needle Browser Bridge 扩展已在受控浏览器中连接。';
  return '如果受控浏览器流程不通，可以改用 OPML，或配置 YOUTUBE_COOKIES_BROWSER 后走 yt-dlp 导入。';
}

/* ─── Channel Card ────────────────────────────────────────────────────────── */

interface CardProps {
  avatarUrl?: string;
  name: string;
  channelUrl: string;
  isSelected: boolean;
  isSubscribed: boolean;
  isDisabled: boolean;
  onToggle: () => void;
  subtitle?: string;
  placeholder: string;
  isCompact?: boolean;
  platform?: 'youtube' | 'bilibili';
  channelId?: string;
  onDragStart?: (e: React.DragEvent) => void;
}

function ChannelCard({
  avatarUrl,
  name,
  channelUrl,
  isSelected,
  isSubscribed,
  isDisabled,
  onToggle,
  subtitle,
  placeholder,
  isCompact = false,
  platform,
  channelId,
  onDragStart: onDragStartProp,
}: CardProps) {
  const checked = isSelected && !isSubscribed;
  const subtitleLines = 2;
  const subtitleLineHeight = 1.25;
  const subtitleMinHeight = `${subtitleLines * subtitleLineHeight}em`;
  return (
    <div
      onClick={isDisabled || isSubscribed ? undefined : onToggle}
      draggable={!isSubscribed && !!platform && !!channelId}
      title={subtitle || name}
      onDragStart={(e) => {
        if (onDragStartProp) {
          onDragStartProp(e);
        } else if (!isSubscribed && platform && channelId) {
          localStorage.setItem('drag-account-info', JSON.stringify({
            platform,
            channel_id: channelId,
            name,
            avatar_url: avatarUrl || '',
          }));
        }
      }}
      onDragEnd={() => {
        localStorage.removeItem('drag-account-info');
        localStorage.removeItem('drag-accounts-info');
      }}
      style={{
        position: 'relative',
        border: `1.5px solid ${checked ? 'var(--accent-primary, #60a5fa)' : 'var(--border)'}`,
        borderRadius: 10,
        padding: isCompact ? '8px' : '9px 8px 7px',
        cursor: isDisabled || isSubscribed ? 'default' : 'pointer',
        opacity: isSubscribed ? 0.5 : 1,
        background: checked
          ? 'rgba(96,165,250,0.07)'
          : 'var(--bg-card, var(--bg-hover))',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: isCompact ? 'center' : 'flex-start',
        gap: isCompact ? 6 : 6,
        transition: 'border-color 0.12s, background 0.12s, transform 0.2s',
        userSelect: 'none',
        minWidth: 0,
        minHeight: isCompact ? 0 : 142,
        boxSizing: 'border-box',
        overflow: 'hidden',
        textAlign: 'center',
      }}
    >
      {/* Checkbox badge */}
      <div
        style={{
          position: 'absolute',
          top: isCompact ? 6 : 7,
          right: isCompact ? 6 : 7,
          width: isCompact ? 14 : 17,
          height: isCompact ? 14 : 17,
          borderRadius: 5,
          border: `2px solid ${checked ? 'var(--accent-primary, #60a5fa)' : 'var(--border)'}`,
          background: checked
            ? 'var(--accent-primary, #60a5fa)'
            : 'var(--bg-card, var(--bg))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: isCompact ? 9 : 10,
          color: '#fff',
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        {checked ? '✓' : ''}
      </div>

      {/* Avatar → opens channel */}
      <a
        href={channelUrl}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{ display: 'flex', flexShrink: 0 }}
      >
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt={name}
            style={{
              width: isCompact ? 32 : 42,
              height: isCompact ? 32 : 42,
              borderRadius: '50%',
              objectFit: 'cover',
            }}
            referrerPolicy="no-referrer"
          />
        ) : (
          <div
            style={{
              width: isCompact ? 32 : 42,
              height: isCompact ? 32 : 42,
              borderRadius: '50%',
              background: 'var(--bg-hover)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: isCompact ? 14 : 16,
              flexShrink: 0,
            }}
          >
            {placeholder}
          </div>
        )}
      </a>

      {/* Name → opens channel */}
      <a
        href={channelUrl}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{
          fontSize: isCompact ? 11 : 11,
          fontWeight: isCompact ? 500 : 500,
          textAlign: 'center',
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: isCompact ? 1 : 2,
          WebkitBoxOrient: 'vertical',
          color: 'var(--text-primary)',
          textDecoration: 'none',
          lineHeight: 1.25,
          maxWidth: '100%',
        }}
      >
        {name}
      </a>

      {isSubscribed && (
        <span
          style={{
            fontSize: 9,
            color: 'var(--text-muted)',
            background: 'var(--bg-hover)',
            borderRadius: 4,
            padding: '1px 5px',
          }}
        >
          已订阅
        </span>
      )}
      {!isSubscribed && !isCompact && (
        <div
          style={{
            fontSize: 10,
            color: 'var(--text-muted)',
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: subtitleLines,
            WebkitBoxOrient: 'vertical',
            maxWidth: '100%',
            textAlign: 'center',
            lineHeight: subtitleLineHeight,
            minHeight: subtitleMinHeight,
            visibility: subtitle ? 'visible' : 'hidden',
          }}
        >
          {subtitle || '占位'}
        </div>
      )}
    </div>
  );
}

/* ─── YouTube Tab ────────────────────────────────────────────────────────── */

interface YoutubeTabProps {
  hasCookiesBrowser: boolean;
  onImported: () => void;
  onClose: () => void;
  variant?: 'modal' | 'inline';
}

function YoutubeTab({ hasCookiesBrowser, onImported, onClose, variant }: YoutubeTabProps) {
  const isCompact = variant === 'inline';
  const [phase, setPhase] = useState<YtPhase>('opening-browser');
  const [list, setList] = useState<YoutubeChannel[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [result, setResult] = useState<{
    created: number;
    skipped: number;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadViaBridge = async () => {
    setPhase('loading');
    setErrorMsg('');
    try {
      const data = await requestJson<{ list?: YoutubeChannel[] }>(
        '/api/subscriptions/youtube?source=bridge',
      );
      applyList(data.list ?? []);
    } catch (err) {
      setErrorMsg(formatYoutubeError(err));
      setPhase('error');
    }
  };

  const openControlledBrowser = async () => {
    setPhase('opening-browser');
    setErrorMsg('');
    try {
      await requestJson<{ ok: true }>('/api/subscriptions/youtube/browser', {
        method: 'POST',
      });
      setPhase('await-login');
    } catch (err) {
      setErrorMsg(formatYoutubeError(err));
      setPhase('error');
    }
  };

  const loadViaYtDlp = async () => {
    setPhase('loading');
    setErrorMsg('');
    try {
      const data = await requestJson<{ list?: YoutubeChannel[] }>(
        '/api/subscriptions/youtube?source=ytdlp',
      );
      applyList(data.list ?? []);
    } catch (err) {
      setErrorMsg(formatYoutubeError(err));
      setPhase('error');
    }
  };

  const loadViaOpml = async (file: File) => {
    setPhase('loading');
    setErrorMsg('');
    try {
      const text = await file.text();
      const data = await requestJson<{ list?: YoutubeChannel[] }>(
        '/api/subscriptions/youtube',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ opml: text }),
        },
      );
      applyList(data.list ?? []);
    } catch (err) {
      setErrorMsg(formatYoutubeError(err));
      setPhase('error');
    }
  };

  const applyList = (items: YoutubeChannel[]) => {
    setList(items);
    setSelected(
      new Set(items.filter((i) => !i.subscribed).map((i) => i.channel_id)),
    );
    setPhase('loaded');
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter((i) => i.name.toLowerCase().includes(q));
  }, [list, search]);

  const unsubscribedCount = list.filter((i) => !i.subscribed).length;
  const allFilteredUnsubscribed = filtered.filter((i) => !i.subscribed);
  const allFilteredSelected =
    allFilteredUnsubscribed.length > 0 &&
    allFilteredUnsubscribed.every((i) => selected.has(i.channel_id));

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected)
        allFilteredUnsubscribed.forEach((i) => next.delete(i.channel_id));
      else allFilteredUnsubscribed.forEach((i) => next.add(i.channel_id));
      return next;
    });
  };

  const toggle = (id: string | number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const sid = String(id);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  };

  const handleImport = async () => {
    if (selected.size === 0) return;
    setPhase('importing');
    const toImport = list
      .filter((i) => selected.has(i.channel_id))
      .map((i) => ({
        platform: 'youtube',
        channel_id: normalizeYoutubeChannelId(i.channel_id),
        name: i.name,
        avatar_url: i.avatar_url ?? '',
      }));
    try {
      const data = await requestJson<{ created: number; skipped: number }>(
        '/api/subscriptions/import',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channels: toImport }),
        },
      );
      setResult(data);
      setPhase('done');
      onImported();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '导入失败');
      setPhase('error');
    }
  };

  const reset = () => {
    setPhase('opening-browser');
    setList([]);
    setSelected(new Set());
    setSearch('');
    setErrorMsg('');
    setResult(null);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void openControlledBrowser();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const showSteps = ['opening-browser', 'await-login', 'loading'].includes(
    phase,
  );

  if (showSteps)
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
            display: 'grid',
            gap: 10,
            flexShrink: 0,
          }}
        >
          <StepItem
            index={1}
            title="正在打开 Needle Browser 受控浏览器"
            active={phase === 'opening-browser'}
            done={phase !== 'opening-browser'}
          />
          <StepItem
            index={2}
            title="请在受控浏览器里完成 YouTube 登录"
            active={phase === 'await-login'}
            done={
              phase === 'loading' ||
              phase === 'loaded' ||
              phase === 'importing' ||
              phase === 'done'
            }
          />
          <StepItem
            index={3}
            title="正在抓取 YouTube 订阅列表"
            active={phase === 'loading'}
            done={
              phase === 'loaded' || phase === 'importing' || phase === 'done'
            }
          />
        </div>

        {phase === 'opening-browser' && (
          <div className="loading-spinner" style={{ flex: 1 }}>
            <div className="spinner" />
            正在打开 Needle Browser 受控浏览器…
          </div>
        )}

        {phase === 'await-login' && (
          <div
            style={{
              padding: 24,
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
            }}
          >
            <div style={{ fontSize: 14, lineHeight: 1.7 }}>
              请在刚刚打开的 Needle Browser 受控浏览器里前往{' '}
              <strong>youtube.com</strong>，完成登录。
            </div>
            <div className="form-hint">
              登录完成后，点击下方按钮继续抓取订阅列表。
            </div>
            <div
              style={{
                display: 'flex',
                gap: 10,
                flexWrap: 'wrap',
                marginTop: 'auto',
              }}
            >
              <button
                className="btn btn-primary"
                onClick={() => void loadViaBridge()}
              >
                确认已在受控浏览器登录 YouTube
              </button>
              {hasCookiesBrowser && (
                <button
                  className="btn btn-ghost"
                  onClick={() => void loadViaYtDlp()}
                >
                  改用 yt-dlp
                </button>
              )}
              <button
                className="btn btn-ghost"
                onClick={() => fileInputRef.current?.click()}
              >
                上传 OPML
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".opml,.xml"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void loadViaOpml(f);
              }}
            />
          </div>
        )}

        {phase === 'loading' && (
          <div className="loading-spinner" style={{ flex: 1 }}>
            <div className="spinner" />
            获取订阅列表中…
          </div>
        )}
      </div>
    );

  if (phase === 'error')
    return (
      <div
        style={{
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div className="error-msg">⚠ {errorMsg}</div>
        <div className="form-hint">{getYoutubeErrorHint(errorMsg)}</div>
        <div
          style={{
            display: 'flex',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <button
            className="btn btn-primary"
            onClick={() => void openControlledBrowser()}
          >
            重新打开受控浏览器
          </button>
          {hasCookiesBrowser && (
            <button
              className="btn btn-ghost"
              onClick={() => void loadViaYtDlp()}
            >
              改用 yt-dlp
            </button>
          )}
          <button
            className="btn btn-ghost"
            onClick={() => fileInputRef.current?.click()}
          >
            上传 OPML
          </button>
          <button className="btn btn-ghost" onClick={reset}>
            重置
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".opml,.xml"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void loadViaOpml(f);
          }}
        />
      </div>
    );

  if (phase === 'done' && result)
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: 32,
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 36 }}>✅</div>
        <div style={{ fontWeight: 600, fontSize: 15 }}>导入完成</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          新增 <strong>{result.created}</strong> 个，跳过 {result.skipped}{' '}
          个已订阅
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={reset}>
            重新导入
          </button>
          <button className="btn btn-primary btn-sm" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    );

  // loaded | importing
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          padding: '10px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexShrink: 0,
        }}
      >
        <input
          className="text-input"
          style={{ flex: 1, padding: '6px 10px', fontSize: 13 }}
          placeholder="搜索频道…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 13,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            userSelect: 'none',
          }}
        >
          <input
            type="checkbox"
            checked={allFilteredSelected}
            onChange={toggleAll}
            disabled={allFilteredUnsubscribed.length === 0}
          />
          全选
        </label>
      </div>

      {/* Grid */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {filtered.length === 0 ? (
          <div
            style={{
              padding: 40,
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: 13,
            }}
          >
            {list.length === 0 ? '订阅列表为空' : '无匹配结果'}
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(auto-fill, minmax(${isCompact ? '120px' : '160px'}, 1fr))`,
              gap: isCompact ? 10 : 10,
              gridAutoRows: '1fr',
              alignItems: 'stretch',
              padding: '12px',
              borderRadius: 12,
              background: isCompact ? 'rgba(0,0,0,0.015)' : 'transparent',
            }}
          >
            {filtered.map((item) => (
              <ChannelCard
                key={item.channel_id}
                name={item.name}
                avatarUrl={item.avatar_url}
                channelUrl={getYoutubeUrl(item.channel_id)}
                isSelected={selected.has(item.channel_id)}
                isSubscribed={item.subscribed}
                isDisabled={phase === 'importing'}
                onToggle={() => toggle(item.channel_id)}
                subtitle={item.description || undefined}
                placeholder="▶"
                isCompact={isCompact}
                platform="youtube"
                channelId={item.channel_id}
                onDragStart={() => {
                  if (selected.has(item.channel_id)) {
                    const toDrag = list
                      .filter((i) => selected.has(i.channel_id))
                      .map((i) => ({
                        platform: 'youtube',
                        channel_id: normalizeYoutubeChannelId(i.channel_id),
                        name: i.name,
                        avatar_url: i.avatar_url ?? '',
                      }));
                    localStorage.setItem('drag-accounts-info', JSON.stringify(toDrag));
                  } else {
                    localStorage.setItem('drag-account-info', JSON.stringify({
                      platform: 'youtube',
                      channel_id: normalizeYoutubeChannelId(item.channel_id),
                      name: item.name,
                      avatar_url: item.avatar_url ?? '',
                    }));
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div
        style={{
          padding: '10px 16px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          已选 <strong>{selected.size}</strong> / {unsubscribedCount} 个新频道
        </span>
        <button
          className="btn btn-primary"
          disabled={selected.size === 0 || phase === 'importing'}
          onClick={handleImport}
        >
          {phase === 'importing' ? (
            <>
              <span
                className="spinner"
                style={{ width: 14, height: 14, borderWidth: 2 }}
              />
              导入中…
            </>
          ) : (
            '导入选中'
          )}
        </button>
      </div>
    </div>
  );
}

/* ─── Bilibili Tab ───────────────────────────────────────────────────────── */

interface BilibiliTabProps {
  onImported: () => void;
  onClose: () => void;
  variant?: 'modal' | 'inline';
}

function StepItem({
  index,
  title,
  active,
  done,
}: {
  index: number;
  title: string;
  active: boolean;
  done: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        opacity: active || done ? 1 : 0.5,
      }}
    >
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: 999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
          fontWeight: 700,
          background: done
            ? 'rgba(34,197,94,0.16)'
            : active
              ? 'rgba(59,130,246,0.16)'
              : 'var(--bg-hover)',
          color: done ? '#22c55e' : active ? '#60a5fa' : 'var(--text-muted)',
          border: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        {done ? '✓' : index}
      </div>
      <div
        style={{
          fontSize: 13,
          color: active ? 'var(--text-primary)' : 'var(--text-muted)',
        }}
      >
        {title}
      </div>
    </div>
  );
}

function BilibiliTab({ onImported, onClose, variant }: BilibiliTabProps) {
  const isCompact = variant === 'inline';
  const [phase, setPhase] = useState<BiliPhase>('opening-browser');
  const [list, setList] = useState<BilibiliFollowing[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [result, setResult] = useState<{
    created: number;
    skipped: number;
  } | null>(null);

  async function openControlledBrowser() {
    setErrorMsg('');
    setPhase('opening-browser');
    try {
      await requestJson<{ ok: true }>('/api/bilibili/following/browser', {
        method: 'POST',
      });
      setPhase('await-login');
    } catch (error) {
      setErrorMsg(formatBiliError(error));
      setPhase('fallback');
    }
  }

  async function loadFollowingList() {
    setErrorMsg('');
    setPhase('loading-following');
    try {
      const data = await requestJson<{ list?: BilibiliFollowing[] }>(
        '/api/bilibili/following',
      );
      const items = data.list ?? [];
      setList(items);
      setSelected(
        new Set(items.filter((i) => !i.subscribed).map((i) => i.mid)),
      );
      setPhase('select');
    } catch (error) {
      setErrorMsg(formatBiliError(error));
      setPhase('fallback');
    }
  }

  useEffect(() => {
    const t = window.setTimeout(() => {
      void openControlledBrowser();
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter((i) => i.uname.toLowerCase().includes(q));
  }, [list, search]);

  const unsubscribedCount = list.filter((i) => !i.subscribed).length;
  const allFilteredUnsubscribed = filtered.filter((i) => !i.subscribed);
  const allFilteredSelected =
    allFilteredUnsubscribed.length > 0 &&
    allFilteredUnsubscribed.every((i) => selected.has(i.mid));

  const step2Done = [
    'loading-following',
    'select',
    'importing',
    'done',
  ].includes(phase);
  const step3Done = ['select', 'importing', 'done'].includes(phase);

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected)
        allFilteredUnsubscribed.forEach((i) => next.delete(i.mid));
      else allFilteredUnsubscribed.forEach((i) => next.add(i.mid));
      return next;
    });
  };

  const toggle = (id: string | number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const mid = Number(id);
      if (next.has(mid)) next.delete(mid);
      else next.add(mid);
      return next;
    });
  };

  const handleImport = async () => {
    if (selected.size === 0) return;
    setPhase('importing');
    const channels = list
      .filter((i) => selected.has(i.mid))
      .map((i) => ({ mid: i.mid, uname: i.uname, face: i.face }));
    try {
      const data = await requestJson<{ created: number; skipped: number }>(
        '/api/bilibili/following',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channels }),
        },
      );
      setResult(data);
      setPhase('done');
      onImported();
    } catch (error) {
      setErrorMsg(formatBiliError(error));
      setPhase('fallback');
    }
  };

  const showSteps = !['select', 'importing', 'done'].includes(phase);

  if (phase === 'done' && result)
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: 32,
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 36 }}>✅</div>
        <div style={{ fontWeight: 600, fontSize: 15 }}>导入完成</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          新增 <strong>{result.created}</strong> 个，跳过 {result.skipped}{' '}
          个已订阅
        </div>
        <button
          className="btn btn-primary"
          style={{ marginTop: 8 }}
          onClick={onClose}
        >
          关闭
        </button>
      </div>
    );

  if (phase === 'fallback')
    return (
      <div
        style={{
          padding: 24,
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 15 }}>改用 SESSDATA 兜底</div>
        {errorMsg && <div className="error-msg">⚠ {errorMsg}</div>}
        <div className="form-hint">{getBiliErrorHint(errorMsg)}</div>
        <div
          style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.7 }}
        >
          去设置页更新 Bilibili 的 <code>SESSDATA</code>
          ，然后重新打开导入面板再试。
        </div>
        <div
          style={{
            display: 'flex',
            gap: 10,
            flexWrap: 'wrap',
            marginTop: 'auto',
          }}
        >
          <Link
            className="btn btn-primary"
            href="/settings?tab=bilibili-summary"
            onClick={onClose}
          >
            去设置页更新 SESSDATA
          </Link>
          <button
            className="btn btn-ghost"
            onClick={() => {
              void openControlledBrowser();
            }}
          >
            重新打开受控浏览器
          </button>
        </div>
      </div>
    );

  if (showSteps)
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
            display: 'grid',
            gap: 10,
            flexShrink: 0,
          }}
        >
          <StepItem
            index={1}
            title="正在打开 Needle Browser 受控浏览器"
            active={phase === 'opening-browser'}
            done={phase !== 'opening-browser'}
          />
          <StepItem
            index={2}
            title="请在受控浏览器里完成 Bilibili 登录"
            active={phase === 'await-login'}
            done={step2Done}
          />
          <StepItem
            index={3}
            title="正在抓取 B 站关注列表"
            active={phase === 'loading-following'}
            done={step3Done}
          />
        </div>

        {phase === 'opening-browser' && (
          <div className="loading-spinner" style={{ flex: 1 }}>
            <div className="spinner" />
            正在打开 Needle Browser 受控浏览器…
          </div>
        )}

        {phase === 'await-login' && (
          <div
            style={{
              padding: 24,
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
            }}
          >
            <div style={{ fontSize: 14, lineHeight: 1.7 }}>
              请在刚刚打开的 Needle Browser 受控浏览器里前往{' '}
              <strong>bilibili.com</strong>，完成登录。
            </div>
            <div className="form-hint">
              登录完成后，点击下方按钮，系统会继续抓取你的关注列表。
            </div>
            <div
              style={{
                display: 'flex',
                gap: 10,
                flexWrap: 'wrap',
                marginTop: 'auto',
              }}
            >
              <button
                className="btn btn-primary"
                onClick={() => {
                  void loadFollowingList();
                }}
              >
                确认已在受控浏览器登录 Bilibili
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setErrorMsg('已取消浏览器登录。');
                  setPhase('fallback');
                }}
              >
                改用 SESSDATA 兜底
              </button>
            </div>
          </div>
        )}

        {phase === 'loading-following' && (
          <div className="loading-spinner" style={{ flex: 1 }}>
            <div className="spinner" />
            正在抓取 B 站关注列表…
          </div>
        )}
      </div>
    );

  // select | importing
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '10px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexShrink: 0,
        }}
      >
        <input
          className="text-input"
          style={{ flex: 1, padding: '6px 10px', fontSize: 13 }}
          placeholder="搜索UP主…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 13,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            userSelect: 'none',
          }}
        >
          <input
            type="checkbox"
            checked={allFilteredSelected}
            onChange={toggleAll}
            disabled={allFilteredUnsubscribed.length === 0}
          />
          全选
        </label>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {filtered.length === 0 ? (
          <div
            style={{
              padding: 40,
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: 13,
            }}
          >
            {list.length === 0 ? '关注列表为空' : '无匹配结果'}
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(auto-fill, minmax(${isCompact ? '120px' : '160px'}, 1fr))`,
              gap: isCompact ? 10 : 10,
              gridAutoRows: '1fr',
              alignItems: 'stretch',
              padding: '12px',
              borderRadius: 12,
              background: isCompact ? 'rgba(0,0,0,0.015)' : 'transparent',
            }}
          >
            {filtered.map((item) => (
              <ChannelCard
                key={item.mid}
                name={item.uname}
                avatarUrl={item.face || undefined}
                channelUrl={getBilibiliUrl(item.mid)}
                isSelected={selected.has(item.mid)}
                isSubscribed={item.subscribed}
                isDisabled={phase === 'importing'}
                onToggle={() => toggle(item.mid)}
                subtitle={item.sign || undefined}
                placeholder="🅱"
                isCompact={isCompact}
                platform="bilibili"
                channelId={String(item.mid)}
                onDragStart={() => {
                  if (selected.has(item.mid)) {
                    const toDrag = list
                      .filter((i) => selected.has(i.mid))
                      .map((i) => ({
                        platform: 'bilibili',
                        channel_id: String(i.mid),
                        name: i.uname,
                        avatar_url: i.face || '',
                      }));
                    localStorage.setItem('drag-accounts-info', JSON.stringify(toDrag));
                  } else {
                    localStorage.setItem('drag-account-info', JSON.stringify({
                      platform: 'bilibili',
                      channel_id: String(item.mid),
                      name: item.uname,
                      avatar_url: item.face || '',
                    }));
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>

      <div
        style={{
          padding: '10px 16px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          已选 <strong>{selected.size}</strong> / {unsubscribedCount} 个新关注
        </span>
        <button
          className="btn btn-primary"
          disabled={selected.size === 0 || phase === 'importing'}
          onClick={handleImport}
        >
          {phase === 'importing' ? (
            <>
              <span
                className="spinner"
                style={{ width: 14, height: 14, borderWidth: 2 }}
              />
              导入中…
            </>
          ) : (
            '导入选中'
          )}
        </button>
      </div>
    </div>
  );
}

/* ─── Main Modal ─────────────────────────────────────────────────────────── */

export default function UnifiedImportModal({
  hasCookiesBrowser,
  onClose,
  onImported,
  variant,
}: UnifiedImportModalProps) {
  const [tab, setTab] = useState<'youtube' | 'bilibili' | null>(null);

  const isInline = variant === 'inline';

  const containerStyles: React.CSSProperties = isInline
    ? {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-card)',
        borderRadius: 16,
        border: '1px solid var(--border)',
        overflow: 'hidden',
        boxShadow: 'var(--shadow-sm)',
      }
    : {
        width: 'calc(100vw - 32px)',
        height: 'calc(100vh - 32px)',
        maxWidth: 'none',
        maxHeight: 'none',
        display: 'flex',
        flexDirection: 'column',
      };

  const content = (
    <div
      className={isInline ? "" : "log-panel"}
      style={containerStyles}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: isInline ? '12px 16px' : '14px 20px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
          background: isInline ? 'rgba(139, 92, 246, 0.05)' : 'transparent',
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {isInline ? '🔍 账号/登录抓取' : '导入订阅'}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          ✕
        </button>
      </div>

      {/* Tabs - Only show when a platform is selected */}
      {tab && (
        <div
          style={{
            display: 'flex',
            gap: 2,
            padding: '4px 16px 0',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}
        >
          {(['youtube', 'bilibili'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: '6px 12px',
                fontSize: 12,
                fontWeight: tab === t ? 600 : 400,
                background: 'none',
                border: 'none',
                borderBottom:
                  tab === t
                    ? '2px solid var(--accent-primary, #60a5fa)'
                    : '2px solid transparent',
                color: tab === t ? 'var(--text-primary)' : 'var(--text-muted)',
                cursor: 'pointer',
                marginBottom: -1,
              }}
            >
              {t === 'youtube' ? '▶ YouTube' : '🅱 B站'}
            </button>
          ))}
        </div>
      )}

      {/* Tab content */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {!tab ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: isInline ? 20 : 40,
              gap: isInline ? 16 : 32,
            }}
          >
            <div style={{ textAlign: 'center' }}>
              <h2 style={{ fontSize: isInline ? 18 : 24, fontWeight: 700, marginBottom: 4, color: 'var(--text-primary)' }}>账号管理</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>请选择要开始导入的平台</p>
            </div>
            
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: isInline ? '1fr' : 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: isInline ? 12 : 20,
                width: '100%',
                maxWidth: 600,
              }}
            >
              <div
                className="platform-select-card"
                onClick={() => setTab('youtube')}
                style={{
                  display: 'flex',
                  flexDirection: isInline ? 'row' : 'column',
                  alignItems: 'center',
                  padding: isInline ? '16px 20px' : '40px 24px',
                  borderRadius: 16,
                  border: '2px solid var(--border)',
                  background: 'var(--bg-card)',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  textAlign: isInline ? 'left' : 'center',
                  gap: isInline ? 16 : 16,
                }}
              >
                <div style={{ fontSize: isInline ? 24 : 48, color: '#FF0000' }}>▶</div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 16 }}>YouTube</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>从你的 YouTube 订阅列表导入</div>
                </div>
              </div>

              <div
                className="platform-select-card"
                onClick={() => setTab('bilibili')}
                style={{
                  display: 'flex',
                  flexDirection: isInline ? 'row' : 'column',
                  alignItems: 'center',
                  padding: isInline ? '16px 20px' : '40px 24px',
                  borderRadius: 16,
                  border: '2px solid var(--border)',
                  background: 'var(--bg-card)',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  textAlign: isInline ? 'left' : 'center',
                  gap: isInline ? 16 : 16,
                }}
              >
                <div style={{ fontSize: isInline ? 24 : 48, color: '#00A1D6' }}>🅱</div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 16 }}>Bilibili</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>从你的 B 站关注列表导入</div>
                </div>
              </div>
            </div>
            
            {isInline && (
              <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 8, background: 'rgba(139, 92, 246, 0.03)', border: '1px dashed rgba(139, 92, 246, 0.1)' }}>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4, margin: 0 }}>
                  💡 导入过程将由本地 Needle Browser 完成，抓取的列表将显示在此处，方便你与右侧已有订阅核对。
                </p>
              </div>
            )}
          </div>
        ) : tab === 'youtube' ? (
          <YoutubeTab
            hasCookiesBrowser={hasCookiesBrowser}
            onImported={onImported}
            onClose={() => setTab(null)}
            variant={variant}
          />
        ) : (
          <BilibiliTab onImported={onImported} onClose={() => setTab(null)} variant={variant} />
        )}
      </div>
    </div>
  );

  if (isInline) return content;

  return (
    <div className="log-panel-overlay" onClick={onClose}>
      {content}
    </div>
  );
}
