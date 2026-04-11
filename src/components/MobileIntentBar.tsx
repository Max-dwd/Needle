'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Intent {
  id: number;
  name: string;
  sort_order: number;
}

interface Channel {
  id: number;
  platform: 'youtube' | 'bilibili';
  name: string;
  channel_id: string;
  avatar_url: string;
  video_count: number;
  intent: string;
}

interface MobileIntentBarProps {
  intents: Intent[];
  currentIntent: string | null;
  currentPlatform: string | null;
}

export default function MobileIntentBar({
  intents,
  currentIntent,
  currentPlatform,
}: MobileIntentBarProps) {
  const router = useRouter();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load channels for dropdown
  useEffect(() => {
    if (!dropdownOpen) return;
    fetch('/api/channels')
      .then((r) => r.json())
      .then((data: Channel[]) => setChannels(data))
      .catch(() => {});
  }, [dropdownOpen]);

  // Scroll active tab into view
  useEffect(() => {
    if (!scrollRef.current) return;
    const activeEl = scrollRef.current.querySelector<HTMLElement>('[data-active="true"]');
    activeEl?.scrollIntoView({ inline: 'center', behavior: 'smooth', block: 'nearest' });
  }, [currentIntent]);

  const channelsForIntent = currentIntent
    ? channels.filter((c) => c.intent === currentIntent)
    : channels;

  const isAllActive = !currentIntent;

  return (
    <div className="mobile-intent-bar">
      {/* Intent tab strip */}
      <div 
        ref={scrollRef} 
        className="mobile-intent-tabs"
        onTouchStart={(e) => e.stopPropagation()}
      >
        <button
          data-active={isAllActive ? 'true' : 'false'}
          className={`mobile-intent-tab ${isAllActive ? 'active' : ''}`}
          onClick={() => {
            if (isAllActive) {
              setDropdownOpen(!dropdownOpen);
            } else {
              router.replace('/', { scroll: false });
              setDropdownOpen(false);
            }
          }}
        >
          全部
        </button>
        {intents.map((intent) => (
          <button
            key={intent.id}
            data-active={currentIntent === intent.name ? 'true' : 'false'}
            className={`mobile-intent-tab ${currentIntent === intent.name ? 'active' : ''}`}
            onClick={() => {
              const isCurrent = currentIntent === intent.name;
              router.replace(`/?intent=${encodeURIComponent(intent.name)}`, { scroll: false });
              setDropdownOpen(isCurrent ? !dropdownOpen : false);
            }}
          >
            {intent.name}
          </button>
        ))}
      </div>

      {/* Channel dropdown */}
      {dropdownOpen && (
        <div 
          className="mobile-channel-dropdown"
          onTouchStart={(e) => e.stopPropagation()}
          onTouchMove={(e) => e.stopPropagation()}
          onTouchEnd={(e) => e.stopPropagation()}
        >
          {isAllActive && (
            <>
              <button
                className={`mobile-channel-item ${(!currentPlatform) ? 'active' : ''}`}
                onClick={() => {
                  router.replace('/', { scroll: false });
                  setDropdownOpen(false);
                }}
                style={(!currentPlatform) ? { background: 'var(--bg-hover)', fontWeight: '600' } : undefined}
              >
                <span className="mobile-channel-icon">🌌</span>
                <span className="mobile-channel-name">全部视频 (不限平台)</span>
              </button>
              <button
                className={`mobile-channel-item ${currentPlatform === 'youtube' ? 'active' : ''}`}
                onClick={() => {
                  router.replace('/?platform=youtube', { scroll: false });
                  setDropdownOpen(false);
                }}
                style={currentPlatform === 'youtube' ? { background: 'var(--bg-hover)', fontWeight: '600' } : undefined}
              >
                <span className="mobile-channel-icon" style={{ color: 'var(--accent-yt)' }}>▶</span>
                <span className="mobile-channel-name">YouTube 全部视频</span>
              </button>
              <button
                className={`mobile-channel-item ${currentPlatform === 'bilibili' ? 'active' : ''}`}
                onClick={() => {
                  router.replace('/?platform=bilibili', { scroll: false });
                  setDropdownOpen(false);
                }}
                style={currentPlatform === 'bilibili' ? { background: 'var(--bg-hover)', fontWeight: '600' } : undefined}
              >
                <span className="mobile-channel-icon" style={{ color: 'var(--accent-bili)' }}>🅱</span>
                <span className="mobile-channel-name">B站 全部视频</span>
              </button>
              <div style={{ height: '1px', background: 'var(--border)', margin: '4px 0', opacity: 0.5 }} />
            </>
          )}

          {channelsForIntent.length === 0 && !isAllActive ? (
            <div className="mobile-channel-empty">该意图下暂无频道</div>
          ) : (
            channelsForIntent.map((ch) => (
              <button
                key={ch.id}
                className="mobile-channel-item"
                onClick={() => {
                  const params = new URLSearchParams({ channel_id: String(ch.id) });
                  if (currentIntent) params.set('intent', currentIntent);
                  router.replace(`/?${params.toString()}`, { scroll: false });
                  setDropdownOpen(false);
                }}
              >
                {ch.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={ch.avatar_url}
                    alt=""
                    className="mobile-channel-avatar"
                  />
                ) : (
                  <span className="mobile-channel-icon">
                    {ch.platform === 'youtube' ? '▶' : '🅱'}
                  </span>
                )}
                <span className="mobile-channel-name">{ch.name || ch.channel_id}</span>
                {ch.video_count > 0 && (
                  <span className="mobile-channel-count">{ch.video_count}</span>
                )}
              </button>
            ))
          )}
        </div>
      )}

      {/* Backdrop to close dropdown */}
      {dropdownOpen && (
        <div
          className="mobile-dropdown-backdrop"
          onClick={() => setDropdownOpen(false)}
        />
      )}
    </div>
  );
}
