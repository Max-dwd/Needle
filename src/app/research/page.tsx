'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import PlayerModal from '@/components/PlayerModal';
import type { VideoWithMeta } from '@/types';
import { getSubtitleDisplayState, timeAgo } from '@/lib/format';
import { buildVideoUrl } from '@/lib/url-utils';
import ExternalVideoAddModal from '@/components/ExternalVideoAddModal';

interface ResearchFavorite {
  id: number;
  video_id: number;
  intent_type_name: string;
  note: string;
  created_at: string;
  title: string | null;
  platform: 'youtube' | 'bilibili';
  platform_video_id: string;
  thumbnail_url: string | null;
  channel_name: string | null;
  duration: string | null;
  subtitle_status: string | null;
  subtitle_error?: string | null;
  subtitle_cooldown_until?: string | null;
}

interface ResearchCollection {
  id: number;
  name: string;
  slug: string;
  item_count: number;
  created_at: string;
}

function getSubtitleBadgeMeta(
  favorite: Pick<ResearchFavorite, 'subtitle_status' | 'subtitle_cooldown_until'>,
) {
  switch (
    getSubtitleDisplayState({
      subtitle_status: favorite.subtitle_status ?? null,
      subtitle_cooldown_until: favorite.subtitle_cooldown_until ?? null,
    })
  ) {
    case 'ready':
      return { label: '已抓字幕', bg: 'rgba(34,197,94,0.14)', color: '#15803d' };
    case 'fetching':
      return { label: '抓取中', bg: 'rgba(59,130,246,0.14)', color: '#1d4ed8' };
    case 'cooldown':
      return { label: '冷却中', bg: 'rgba(245,158,11,0.16)', color: '#b45309' };
    case 'error':
      return { label: '抓取失败', bg: 'rgba(239,68,68,0.14)', color: '#b91c1c' };
    case 'missing':
      return { label: '无字幕', bg: 'rgba(249,115,22,0.16)', color: '#c2410c' };
    default:
      return { label: '未开始', bg: 'rgba(148,163,184,0.16)', color: '#475569' };
  }
}

export default function ResearchPage() {
  const [activeTab, setActiveTab] = useState<'unorganized' | 'collections'>('unorganized');
  const [favorites, setFavorites] = useState<ResearchFavorite[]>([]);
  const [collections, setCollections] = useState<ResearchCollection[]>([]);
  const [loading, setLoading] = useState(true);
  
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showAddCollectionForm, setShowAddCollectionForm] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');
  
  const [showAddToCollectionModal, setShowAddToCollectionModal] = useState(false);
  const [targetCollectionId, setTargetCollectionId] = useState<string>('');
  const [newTargetCollectionName, setNewTargetCollectionName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showExternalVideoModal, setShowExternalVideoModal] = useState(false);
  const [retryingSubtitleIds, setRetryingSubtitleIds] = useState<Set<number>>(new Set());
  const [openingFavoriteId, setOpeningFavoriteId] = useState<number | null>(null);
  const [playingVideo, setPlayingVideo] = useState<VideoWithMeta | null>(null);

  const normalizeCollections = (data: unknown): ResearchCollection[] => {
    if (Array.isArray(data)) {
      return data as ResearchCollection[];
    }
    if (
      data &&
      typeof data === 'object' &&
      'items' in data &&
      Array.isArray((data as { items?: unknown }).items)
    ) {
      return (data as { items: ResearchCollection[] }).items;
    }
    return [];
  };

  useEffect(() => {
    fetchData();
  }, [activeTab]);

  useEffect(() => {
    const es = new EventSource('/api/sse');

    const onSubtitleStatus = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as {
          videoId?: string;
          platform?: 'youtube' | 'bilibili';
          status?: string;
          error?: string | null;
          cooldownUntil?: string | null;
        };
        if (!payload.videoId || !payload.platform || !payload.status) return;

        setFavorites((prev) =>
          prev.map((item) =>
            item.platform_video_id === payload.videoId &&
            item.platform === payload.platform
              ? {
                  ...item,
                  subtitle_status: payload.status ?? item.subtitle_status,
                  subtitle_error:
                    payload.error === undefined
                      ? item.subtitle_error
                      : payload.error,
                  subtitle_cooldown_until:
                    payload.cooldownUntil === undefined
                      ? item.subtitle_cooldown_until
                      : payload.cooldownUntil,
                }
              : item,
          ),
        );
      } catch {
        // ignore malformed event
      }
    };

    es.addEventListener('subtitle-status', onSubtitleStatus);
    return () => {
      es.removeEventListener('subtitle-status', onSubtitleStatus);
      es.close();
    };
  }, []);

  const fetchData = async () => {
    setLoading(true);
    setSelectedIds(new Set());
    try {
      if (activeTab === 'unorganized') {
        const res = await fetch('/api/research/favorites?unorganized=1');
        const data = await res.json();
        setFavorites(data.items || []);
      } else {
        const res = await fetch('/api/research/collections');
        const data = await res.json();
        setCollections(normalizeCollections(data));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const triggerSubtitleRetry = async (
    favorite: Pick<ResearchFavorite, 'id' | 'platform' | 'platform_video_id'>,
  ) => {
    setRetryingSubtitleIds((prev) => new Set(prev).add(favorite.id));
    const params = new URLSearchParams({
      source: 'player',
      preferredMethod: favorite.platform === 'youtube' ? 'piped' : 'browser',
      async: '1',
      force: '1',
    });

    try {
      const lookupRes = await fetch(
        `/api/videos/lookup?video_id=${encodeURIComponent(favorite.platform_video_id)}&platform=${favorite.platform}`,
        { cache: 'no-store' },
      );
      if (!lookupRes.ok) throw new Error('视频不存在');
      const lookupData = (await lookupRes.json()) as { video?: { id?: number } };
      if (!lookupData.video?.id) throw new Error('视频不存在');

      await fetch(`/api/videos/${lookupData.video.id}/subtitle?${params.toString()}`, {
        method: 'POST',
      });
    } finally {
      setRetryingSubtitleIds((prev) => {
        const next = new Set(prev);
        next.delete(favorite.id);
        return next;
      });
    }
  };

  const openFavoriteInPlayer = async (
    favorite: Pick<ResearchFavorite, 'id' | 'platform' | 'platform_video_id'>,
  ) => {
    setOpeningFavoriteId(favorite.id);
    try {
      const lookupRes = await fetch(
        `/api/videos/lookup?video_id=${encodeURIComponent(favorite.platform_video_id)}&platform=${favorite.platform}`,
        { cache: 'no-store' },
      );
      const data = (await lookupRes.json().catch(() => null)) as
        | { video?: VideoWithMeta; error?: string }
        | null;
      if (!lookupRes.ok || !data?.video) {
        throw new Error(data?.error || '打开视频失败');
      }
      setPlayingVideo(data.video);
    } catch (error) {
      alert(error instanceof Error ? error.message : '打开视频失败');
    } finally {
      setOpeningFavoriteId((current) => (current === favorite.id ? null : current));
    }
  };

  const handleCreateCollection = async () => {
    if (!newCollectionName.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/research/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newCollectionName.trim() })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(
          typeof data?.error === 'string' ? data.error : '创建清单失败',
        );
      }
      setNewCollectionName('');
      setShowAddCollectionForm(false);
      await fetchData();
    } catch (error) {
      alert(error instanceof Error ? error.message : '创建清单失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddToCollection = async () => {
    if (selectedIds.size === 0) return;
    
    // Make sure we have collections loaded for the modal
    let availableCollections = collections;
    if (availableCollections.length === 0) {
      const res = await fetch('/api/research/collections');
      const data = await res.json();
      availableCollections = normalizeCollections(data);
      setCollections(availableCollections);
    }
    
    if (availableCollections.length === 0) {
      alert('请先创建一个清单！');
      return;
    }
    
    if (!targetCollectionId) {
      setTargetCollectionId(String(availableCollections[0].id));
    }
    
    setShowAddToCollectionModal(true);
  };

  const submitAddToCollection = async () => {
    if (selectedIds.size === 0) return;
    if (targetCollectionId === 'new' && !newTargetCollectionName.trim()) return;

    setSubmitting(true);
    try {
      let resolvedCollectionId = targetCollectionId;

      if (targetCollectionId === 'new') {
        const createRes = await fetch('/api/research/collections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newTargetCollectionName.trim() })
        });
        if (!createRes.ok) {
          const data = await createRes.json().catch(() => null);
          throw new Error(typeof data?.error === 'string' ? data.error : '创建清单失败');
        }
        const newCollection = await createRes.json();
        resolvedCollectionId = String(newCollection.id);
      }

      const res = await fetch(`/api/research/collections/${resolvedCollectionId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite_ids: Array.from(selectedIds) })
      });
      if (res.ok) {
        setShowAddToCollectionModal(false);
        setNewTargetCollectionName('');
        fetchData();
      } else {
        const errorData = await res.json().catch(() => null);
        throw new Error(errorData?.error || '添加失败');
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : '操作失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '40px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 30 }}>
        <h1 style={{ fontSize: 24, margin: 0, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 28 }}>🔬</span> 研究收藏
        </h1>
        <button 
          className="premium-button primary"
          onClick={() => setShowExternalVideoModal(true)}
        >
          添加外部视频
        </button>
      </div>

      <div style={{ display: 'flex', gap: 20, marginBottom: 30, borderBottom: '1px solid var(--border)' }}>
        <button
          onClick={() => setActiveTab('unorganized')}
          style={{
            padding: '12px 0',
            background: 'none',
            border: 'none',
            borderBottom: activeTab === 'unorganized' ? '2px solid var(--accent-purple)' : '2px solid transparent',
            color: activeTab === 'unorganized' ? 'var(--accent-purple)' : 'var(--text-secondary)',
            fontSize: 16,
            fontWeight: activeTab === 'unorganized' ? 600 : 500,
            cursor: 'pointer',
            marginRight: 20
          }}
        >
          未整理
        </button>
        <button
          onClick={() => setActiveTab('collections')}
          style={{
            padding: '12px 0',
            background: 'none',
            border: 'none',
            borderBottom: activeTab === 'collections' ? '2px solid var(--accent-purple)' : '2px solid transparent',
            color: activeTab === 'collections' ? 'var(--accent-purple)' : 'var(--text-secondary)',
            fontSize: 16,
            fontWeight: activeTab === 'collections' ? 600 : 500,
            cursor: 'pointer'
          }}
        >
          我的清单
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)' }}>加载中...</div>
      ) : activeTab === 'unorganized' ? (
        <div>
          {favorites.length > 0 && (
            <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
                已选 {selectedIds.size} 项 / 共 {favorites.length} 项
              </div>
              <button
                className="premium-button primary"
                onClick={handleAddToCollection}
                disabled={selectedIds.size === 0}
              >
                加入清单
              </button>
            </div>
          )}

          {favorites.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 80, background: 'var(--bg-secondary)', borderRadius: 12 }}>
              <div style={{ fontSize: 40, marginBottom: 16, opacity: 0.5 }}>📥</div>
              <div style={{ color: 'var(--text-secondary)' }}>太棒了！所有素材都已经整理完毕。</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {favorites.map(fav => {
                const subtitleBadge = getSubtitleBadgeMeta(fav);
                const subtitleState = getSubtitleDisplayState({
                  subtitle_status: fav.subtitle_status ?? null,
                  subtitle_cooldown_until: fav.subtitle_cooldown_until ?? null,
                });

                return (
                  <div 
                    key={fav.id} 
                    style={{ 
                      display: 'flex', 
                      background: 'var(--bg-secondary)', 
                      borderRadius: 12, 
                      overflow: 'hidden',
                      border: selectedIds.has(fav.id) ? '2px solid var(--accent-purple)' : '1px solid var(--border)',
                    }}
                  >
                  <div style={{ padding: '0 20px', display: 'flex', alignItems: 'center' }}>
                    <input 
                      type="checkbox" 
                      checked={selectedIds.has(fav.id)}
                      onChange={() => toggleSelect(fav.id)}
                      style={{ transform: 'scale(1.2)', cursor: 'pointer' }}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => void openFavoriteInPlayer(fav)}
                    disabled={openingFavoriteId === fav.id}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      padding: 0,
                      margin: 0,
                      cursor: openingFavoriteId === fav.id ? 'progress' : 'pointer',
                      flexShrink: 0,
                    }}
                    title="打开播放器"
                  >
                    {fav.thumbnail_url ? (
                       <img src={fav.thumbnail_url} style={{ width: 160, height: 90, objectFit: 'cover', display: 'block' }} alt="" />
                    ) : (
                       <div style={{ width: 160, height: 90, background: '#333', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {openingFavoriteId === fav.id ? '…' : fav.platform === 'youtube' ? '▶' : '🅱'}
                       </div>
                    )}
                  </button>
                  <div style={{ padding: '16px 20px', flex: 1, display: 'flex', flexDirection: 'column' }}>
                    <button
                      type="button"
                      onClick={() => void openFavoriteInPlayer(fav)}
                      disabled={openingFavoriteId === fav.id}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        padding: 0,
                        margin: '0 0 4px 0',
                        fontSize: 16,
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                        textAlign: 'left',
                        cursor: openingFavoriteId === fav.id ? 'progress' : 'pointer',
                      }}
                      title="打开播放器"
                    >
                      {fav.title}
                    </button>
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ color: fav.platform === 'youtube' ? 'var(--accent-yt)' : 'var(--accent-bili)' }}>
                        {fav.platform === 'youtube' ? 'YouTube' : 'Bilibili'}
                      </span>
                      <span>{fav.channel_name}</span>
                      <span style={{ background: 'var(--bg-hover)', padding: '2px 6px', borderRadius: 4 }}>
                        意图: {fav.intent_type_name}
                      </span>
                      <span
                        style={{
                          background: subtitleBadge.bg,
                          color: subtitleBadge.color,
                          padding: '2px 8px',
                          borderRadius: 999,
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      >
                        {subtitleBadge.label}
                      </span>
                    </div>
                    <div style={{ fontSize: 14, color: 'var(--text-primary)', opacity: 0.8, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      <span style={{ fontWeight: 600, opacity: 0.5 }}>笔记：</span> {fav.note}
                    </div>
                    <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                      <a
                        href={buildVideoUrl(fav.platform, fav.platform_video_id)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="premium-button"
                        style={{ fontSize: 12, padding: '4px 10px', textDecoration: 'none' }}
                      >
                        原始页
                      </a>
                    {subtitleState !== 'ready' && (
                        <button
                          className="premium-button"
                          style={{ fontSize: 12, padding: '4px 10px' }}
                          disabled={retryingSubtitleIds.has(fav.id)}
                          onClick={(event) => {
                            event.stopPropagation();
                            void triggerSubtitleRetry(fav);
                          }}
                        >
                          {retryingSubtitleIds.has(fav.id) ? '排队中...' : '重试字幕'}
                        </button>
                    )}
                    </div>
                  </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div>
          <div style={{ marginBottom: 24 }}>
            {!showAddCollectionForm ? (
              <button 
                className="premium-button primary"
                onClick={() => setShowAddCollectionForm(true)}
              >
                + 新建清单
              </button>
            ) : (
              <div style={{ display: 'flex', gap: 12, background: 'var(--bg-secondary)', padding: 16, borderRadius: 12, width: 'max-content' }}>
                <input 
                  type="text" 
                  className="premium-input"
                  placeholder="清单名称..."
                  value={newCollectionName}
                  onChange={(e) => setNewCollectionName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreateCollection()}
                  autoFocus
                />
                <button className="premium-button primary" onClick={handleCreateCollection} disabled={submitting || !newCollectionName.trim()}>确定</button>
                <button className="premium-button" onClick={() => setShowAddCollectionForm(false)}>取消</button>
              </div>
            )}
          </div>

          {collections.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 80, background: 'var(--bg-secondary)', borderRadius: 12 }}>
              <div style={{ color: 'var(--text-secondary)' }}>您还没有创建任何清单，点击上方按钮创建一个。</div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 20 }}>
              {collections.map(col => (
                <Link 
                  key={col.id} 
                  href={`/research/collections/${col.id}`}
                  style={{ 
                    display: 'block', 
                    padding: 24, 
                    background: 'var(--bg-secondary)', 
                    borderRadius: 12, 
                    border: '1px solid var(--border)',
                    textDecoration: 'none',
                    color: 'inherit',
                    transition: 'transform 0.2s, boxShadow 0.2s'
                  }}
                  className="hover-card"
                >
                  <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8, color: 'var(--text-primary)' }}>{col.name}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)', fontSize: 14 }}>
                    <span>共 {col.item_count} 个素材</span>
                    <span>{timeAgo(col.created_at)}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {showAddToCollectionModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000}}>
          <div style={{ background: 'var(--bg-primary)', padding: 24, borderRadius: 12, width: 400, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
            <h3 style={{ marginTop: 0, marginBottom: 20, fontSize: 18, color: 'var(--text-primary)' }}>添加到清单</h3>
            <div style={{ marginBottom: 24 }}>
              <select 
                className="premium-select"
                style={{ width: '100%', padding: '10px', marginBottom: targetCollectionId === 'new' ? 12 : 0 }}
                value={targetCollectionId}
                onChange={e => setTargetCollectionId(e.target.value)}
              >
                {collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                <option value="new" style={{ color: 'var(--accent-purple)', fontWeight: 600 }}>+ 新建清单...</option>
              </select>
              {targetCollectionId === 'new' && (
                <input
                  type="text"
                  className="premium-input"
                  style={{ width: '100%', padding: '10px' }}
                  placeholder="输入新清单名称..."
                  value={newTargetCollectionName}
                  onChange={e => setNewTargetCollectionName(e.target.value)}
                  autoFocus
                />
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
              <button className="premium-button" onClick={() => setShowAddToCollectionModal(false)}>取消</button>
              <button className="premium-button primary" onClick={submitAddToCollection} disabled={submitting}>
                {submitting ? '提交中...' : '确认添加'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showExternalVideoModal && (
        <ExternalVideoAddModal 
          onClose={() => setShowExternalVideoModal(false)}
          onSuccess={() => {
            setShowExternalVideoModal(false);
            fetchData();
          }}
        />
      )}

      {playingVideo && (
        <PlayerModal
          video={playingVideo}
          onClose={() => setPlayingVideo(null)}
        />
      )}

      <style dangerouslySetInnerHTML={{__html: `
        .hover-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(0,0,0,0.1);
          border-color: var(--accent-purple) !important;
        }
      `}} />
    </div>
  );
}
