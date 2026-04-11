'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState, Suspense } from 'react';
import { useTheme } from '@/contexts/ThemeContext';
import { useT } from '@/contexts/LanguageContext';
import { useDraggableWidth } from '@/hooks/useDraggableWidth';

interface Intent {
  id: number;
  name: string;
  auto_subtitle: number;
  auto_summary: number;
  sort_order: number;
}

interface Channel {
  id: number;
  platform: 'youtube' | 'bilibili';
  channel_id: string;
  name: string;
  avatar_url: string;
  video_count: number;
  intent: string;
  topics: string[];
}

interface IntentGroup {
  name: string;
  sort_order: number;
  channels: Channel[];
}

function AppSidebarContent() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { mode, setMode } = useTheme();
  const t = useT();

  const cycleTheme = () => {
    const next = mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system';
    setMode(next);
  };

  const themeIcon = mode === 'light' ? '☀️' : mode === 'dark' ? '🌙' : '💻';
  const themeTitle = mode === 'light' ? t.theme.tooltipLight : mode === 'dark' ? t.theme.tooltipDark : t.theme.tooltipSystem;

  const { width: sidebarWidth, handleRef } = useDraggableWidth(
    'sidebar-width',
    240,
    { min: 180, max: 380 },
  );

  // Sync CSS variable so the grid layout updates
  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
  }, [sidebarWidth]);
  const currentPlatform = searchParams.get('platform');
  const currentIntent = searchParams.get('intent');
  const currentChannel = searchParams.get('channel_id');

  const [intents, setIntents] = useState<Intent[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [totalVideos, setTotalVideos] = useState<number>(0);
  const [sidebarRefresh, setSidebarRefresh] = useState(0);

  // Listen for sidebar refresh events dispatched after channel mutations
  useEffect(() => {
    const handler = () => setSidebarRefresh((v) => v + 1);
    window.addEventListener('sidebar:refresh', handler);
    return () => window.removeEventListener('sidebar:refresh', handler);
  }, []);

  // Fetch intents and channels
  useEffect(() => {
    Promise.all([
      fetch('/api/settings/intents').then((res) => res.json()),
      fetch('/api/channels').then((res) => res.json()),
    ])
      .then(([intentsData, channelsData]: [Intent[], Channel[]]) => {
        setIntents(intentsData);
        setChannels(channelsData);

        // Calculate total videos
        const total = channelsData.reduce(
          (sum, ch) => sum + (ch.video_count || 0),
          0,
        );
        setTotalVideos(total);

        // Auto-expand logic: expand only one group matching current intent filter or channel's intent
        const validIntentNames = new Set(intentsData.map((i) => i.name));
        setExpandedGroups(() => {
          if (currentIntent) return new Set([currentIntent]);
          if (currentChannel) {
            const ch = channelsData.find(
              (x) => x.id.toString() === currentChannel,
            );
            if (ch) {
              const intentName = ch.intent || '未分类';
              if (intentName === '未分类' || validIntentNames.has(intentName)) {
                return new Set([intentName]);
              }
              return new Set(['未分类']);
            }
          }
          return new Set();
        });
      })
      .catch((err) => console.error('Failed to load sidebar data', err));
  }, [currentIntent, currentChannel, sidebarRefresh]);

  // Group channels by intent, orphaned intents go to 未分类
  const getIntentGroups = (): IntentGroup[] => {
    // Build a map of valid intent names from the intents table
    const validIntentNames = new Set(intents.map((i) => i.name));

    // Separate channels into their intended groups or 未分类
    const grouped = new Map<string, Channel[]>();
    const orphaned: Channel[] = [];

    for (const ch of channels) {
      const intentName = ch.intent || '未分类';
      // Check if this intent still exists in the intents table
      if (intentName === '未分类' || validIntentNames.has(intentName)) {
        if (!grouped.has(intentName)) grouped.set(intentName, []);
        grouped.get(intentName)!.push(ch);
      } else {
        // Orphaned channel - intent name doesn't exist anymore
        orphaned.push(ch);
      }
    }

    // Add orphaned channels to 未分类
    if (orphaned.length > 0) {
      if (!grouped.has('未分类')) grouped.set('未分类', []);
      grouped.get('未分类')!.push(...orphaned);
    }

    // Convert to array and calculate video counts
    const groups: IntentGroup[] = [];

    // Add groups for each intent in the intents table (except 未分类 which goes last)
    for (const intent of intents) {
      if (intent.name !== '未分类') {
        const chs = grouped.get(intent.name) || [];
        groups.push({
          name: intent.name,
          sort_order: intent.sort_order,
          channels: chs.sort((a, b) => b.video_count - a.video_count),
        });
      }
    }

    // Add 未分类 at the end if it exists in the intents table (always render it per contract)
    const weifenleiIntent = intents.find((i) => i.name === '未分类');
    if (weifenleiIntent) {
      const weifenleiChannels = grouped.get('未分类') || [];
      groups.push({
        name: '未分类',
        sort_order: weifenleiIntent.sort_order,
        channels: weifenleiChannels.sort(
          (a, b) => b.video_count - a.video_count,
        ),
      });
    }

    return groups;
  };

  const intentGroups = getIntentGroups();

  // Calculate video count for a group
  const getGroupVideoCount = (group: IntentGroup): number => {
    return group.channels.reduce((sum, ch) => sum + (ch.video_count || 0), 0);
  };

  const toggleExpand = (e: React.MouseEvent, groupName: string) => {
    e.preventDefault();
    e.stopPropagation();
    setExpandedGroups((prev) => {
      if (prev.has(groupName)) return new Set();
      return new Set([groupName]);
    });
  };

  const isExpanded = (groupName: string) => expandedGroups.has(groupName);

  const isGroupActive = (groupName: string) => currentIntent === groupName;

  // Topic badge component - max 2 visible + overflow
  const TopicBadges = ({ topics }: { topics: string[] }) => {
    if (!topics || topics.length === 0) return null;
    const visible = topics.slice(0, 2);
    const overflow = topics.length - 2;
    return (
      <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        {visible.map((topic, i) => (
          <span
            key={i}
            style={{
              fontSize: 10,
              padding: '1px 6px',
              borderRadius: 10,
              background: 'var(--bg-hover)',
              color: 'var(--text-secondary)',
              whiteSpace: 'nowrap',
            }}
          >
            {topic}
          </span>
        ))}
        {overflow > 0 && (
          <span
            style={{
              fontSize: 10,
              padding: '1px 4px',
              borderRadius: 10,
              background: 'var(--bg-hover)',
              color: 'var(--text-secondary)',
            }}
          >
            +{overflow}
          </span>
        )}
      </span>
    );
  };

  return (
    <aside className="app-sidebar" style={{ position: 'relative', width: sidebarWidth, minWidth: sidebarWidth, maxWidth: sidebarWidth }}>
      {/* Logo and actions */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 4px 12px 4px',
          marginBottom: 4,
        }}
      >
        <Link href="/" className="topbar-logo" style={{ fontSize: 18, gap: 8 }}>
          <img 
            src="/logo.jpeg" 
            alt="Needle Logo" 
            style={{ 
              width: 24, 
              height: 24, 
              borderRadius: 6,
              objectFit: 'cover'
            }} 
          />
          Needle
        </Link>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={cycleTheme}
            title={themeTitle}
            style={{
              padding: '4px',
              borderRadius: 6,
              fontSize: 14,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              opacity: 0.7,
              transition: 'opacity 0.15s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.7')}
          >
            {themeIcon}
          </button>
          <Link
            href="/channels"
            className="btn-ghost"
            style={{
              padding: '4px',
              borderRadius: 6,
              fontSize: 14,
              border: 'none',
              background: 'transparent',
            }}
            title={t.sidebar.channels}
          >
            ➕
          </Link>
          <Link
            href="/settings"
            className="btn-ghost"
            style={{
              padding: '4px',
              borderRadius: 6,
              fontSize: 14,
              border: 'none',
              background: 'transparent',
            }}
            title={t.sidebar.settings}
          >
            ⚙️
          </Link>
        </div>
      </div>

      {/* Top-level nav: All videos and platform shortcuts */}
      <div className="sidebar-nav-group">
        <Link
          href="/"
          className={`sidebar-nav-item ${pathname === '/' && !currentIntent && !currentChannel && !currentPlatform ? 'active' : ''}`}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 16 }}>📹</span> {t.sidebar.allVideos}
          </span>
          <span className="sidebar-nav-count">{totalVideos}</span>
        </Link>
        <div
          style={{
            paddingLeft: 22,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <Link
            href="/?platform=youtube"
            className={`sidebar-nav-item ${currentPlatform === 'youtube' ? 'active' : ''}`}
            style={{ padding: '6px 8px', fontSize: 13 }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12 }}>▶</span> YouTube
            </span>
          </Link>
          <Link
            href="/?platform=bilibili"
            className={`sidebar-nav-item ${currentPlatform === 'bilibili' ? 'active' : ''}`}
            style={{ padding: '6px 8px', fontSize: 13 }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12 }}>🅱</span> B站
            </span>
          </Link>
        </div>
      </div>

      <hr
        style={{
          border: 'none',
          borderTop: '1px solid var(--border)',
          margin: '4px 0',
        }}
      />

      {/* Intent groups */}
      <div className="sidebar-nav-group">
        {intentGroups.map((group) => (
          <div
            key={group.name}
            style={{ display: 'flex', flexDirection: 'column' }}
          >
            {/* Intent group header - clicking name navigates, clicking chevron toggles */}
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <span
                onClick={(e) => toggleExpand(e, group.name)}
                style={{
                  fontSize: 14,
                  opacity: 0.5,
                  cursor: 'pointer',
                  width: 16,
                  display: 'inline-block',
                  textAlign: 'center',
                  transform: isExpanded(group.name) ? 'rotate(90deg)' : 'none',
                  transition: 'transform 0.2s',
                  userSelect: 'none',
                  padding: '8px 4px',
                }}
              >
                ›
              </span>
              <Link
                href={`/?intent=${encodeURIComponent(group.name)}`}
                className={`sidebar-nav-item ${isGroupActive(group.name) ? 'active' : ''}`}
                style={{
                  flex: 1,
                  paddingRight: 8,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {group.name === '未分类' ? t.sidebar.unclassified : group.name}
                  <span
                    style={{
                      fontSize: 12,
                      opacity: 0.5,
                    }}
                  >
                    ({getGroupVideoCount(group)})
                  </span>
                </span>
              </Link>
            </div>

            {/* Expanded: show channels */}
            {isExpanded(group.name) && (
              <div
                style={{
                  paddingLeft: 22,
                  marginTop: 2,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                {group.channels.map((ch) => (
                  <Link
                    key={ch.id}
                    href={`/?channel_id=${ch.id}&intent=${encodeURIComponent(group.name)}`}
                    className={`sidebar-nav-item ${currentChannel === ch.id.toString() ? 'active' : ''}`}
                    style={{
                      padding: '6px 8px',
                      fontSize: 13,
                      gap: 8,
                      justifyContent: 'flex-start',
                    }}
                  >
                    {ch.avatar_url ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={ch.avatar_url}
                        alt=""
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: '50%',
                          objectFit: 'cover',
                          flexShrink: 0,
                        }}
                      />
                    ) : (
                      <span
                        style={{ fontSize: 12, opacity: 0.5, flexShrink: 0 }}
                      >
                        {ch.platform === 'youtube' ? '▶' : '🅱'}
                      </span>
                    )}
                    <span
                      style={{
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        flex: 1,
                      }}
                    >
                      {ch.name || ch.channel_id}
                    </span>
                    <TopicBadges topics={ch.topics} />
                  </Link>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ marginTop: 'auto' }}>
        <hr
          style={{
            border: 'none',
            borderTop: '1px solid var(--border)',
            margin: '8px 0',
          }}
        />
        <div className="sidebar-nav-group" style={{ paddingBottom: 8 }}>
          <Link
            href="/research"
            className={`sidebar-nav-item ${pathname.startsWith('/research') ? 'active' : ''}`}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 16 }}>🔬</span> {t.sidebar.research}
            </span>
          </Link>
        </div>
      </div>

      {/* Drag handle */}
      <div
        ref={handleRef}
        className="sidebar-resize-handle"
      />
    </aside>
  );
}

export default function AppSidebar() {
  const t = useT();
  return (
    <Suspense
      fallback={
        <aside className="app-sidebar">
          <div className="sidebar-nav-group">
            <span className="sidebar-nav-item">{t.common.loading}</span>
          </div>
        </aside>
      }
    >
      <AppSidebarContent />
    </Suspense>
  );
}
