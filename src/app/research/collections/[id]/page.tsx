'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import PlayerModal from '@/components/PlayerModal';
import type { VideoWithMeta } from '@/types';
import { getSubtitleDisplayState, hasSubtitleReady } from '@/lib/format';
import { buildVideoUrl } from '@/lib/url-utils';

interface ResearchFavorite {
  id: number;
  favorite_id: number;
  video_id: number;
  intent_type_id: number;
  intent_type_name: string;
  note: string;
  created_at: string;
  title: string | null;
  platform: 'youtube' | 'bilibili';
  platform_video_id: string;
  thumbnail_url: string | null;
  channel_name: string | null;
  duration: string | null;
  override_note?: string | null;
  override_intent_type_id?: number | null;
  subtitle_status?: string | null;
  subtitle_error?: string | null;
  subtitle_cooldown_until?: string | null;
  sort_order: number;
}

interface ResearchCollection {
  id: number;
  name: string;
  slug: string;
  goal: string | null;
  description: string | null;
}

interface ResearchIntentType {
  id: number;
  name: string;
  slug: string;
  export_template: string | null;
  sort_order: number;
}

const DEFAULT_EXPORT_TEMPLATE = `# {{title}}

- Channel: {{channel_name}}
- Platform: {{platform}}
- URL: {{url}}
- Intent: {{intent_name}}

## Note

{{note}}`;

function getVideoUrl(platform: 'youtube' | 'bilibili', platformVideoId: string): string {
  if (platform === 'youtube') {
    return `https://www.youtube.com/watch?v=${platformVideoId}`;
  }
  return `https://www.bilibili.com/video/${platformVideoId}/`;
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '');
}

function getSubtitleBadgeMeta(
  item: Pick<ResearchFavorite, 'subtitle_status' | 'subtitle_cooldown_until'>,
) {
  switch (getSubtitleDisplayState({
    subtitle_status: item.subtitle_status ?? null,
    subtitle_cooldown_until: item.subtitle_cooldown_until ?? null,
  })) {
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

// Inline editable text field
function InlineEditText({
  value,
  onSave,
  multiline,
  placeholder,
  style,
}: {
  value: string;
  onSave: (val: string) => Promise<void>;
  multiline?: boolean;
  placeholder?: string;
  style?: React.CSSProperties;
}) {
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState(value);
  const [saving, setSaving] = useState(false);
  const originalRef = useRef(value);

  useEffect(() => {
    setCurrent(value);
    originalRef.current = value;
  }, [value]);

  const handleBlur = async () => {
    setEditing(false);
    if (current === originalRef.current) return;
    setSaving(true);
    try {
      await onSave(current);
      originalRef.current = current;
    } catch {
      setCurrent(originalRef.current);
    } finally {
      setSaving(false);
    }
  };

  const baseStyle: React.CSSProperties = {
    color: 'var(--text-primary)',
    background: 'transparent',
    border: 'none',
    outline: 'none',
    width: '100%',
    font: 'inherit',
    cursor: 'text',
    ...style,
  };

  if (editing) {
    const editStyle: React.CSSProperties = {
      ...baseStyle,
      background: 'var(--bg-hover)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      padding: '4px 8px',
      cursor: 'text',
    };
    if (multiline) {
      return (
        <span style={{ position: 'relative', display: 'block' }}>
          <textarea
            autoFocus
            value={current}
            onChange={e => setCurrent(e.target.value)}
            onBlur={handleBlur}
            rows={3}
            style={{ ...editStyle, resize: 'vertical', display: 'block' }}
          />
          {saving && (
            <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 4 }}>
              保存中…
            </span>
          )}
        </span>
      );
    }
    return (
      <span style={{ position: 'relative', display: 'block' }}>
        <input
          autoFocus
          value={current}
          onChange={e => setCurrent(e.target.value)}
          onBlur={handleBlur}
          style={{ ...editStyle, display: 'block' }}
        />
        {saving && (
          <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 4 }}>
            保存中…
          </span>
        )}
      </span>
    );
  }

  return (
    <span
      style={{ ...style, cursor: 'text', display: 'block' }}
      onClick={() => setEditing(true)}
      title="点击编辑"
    >
      {current || <span style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>{placeholder}</span>}
      {saving && (
        <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 6 }}>
          保存中…
        </span>
      )}
    </span>
  );
}

// Preview modal for a single item
function PreviewModal({
  item,
  intentTypes,
  onClose,
}: {
  item: ResearchFavorite;
  intentTypes: ResearchIntentType[];
  onClose: () => void;
}) {
  const effectiveIntentTypeId = item.override_intent_type_id ?? item.intent_type_id;
  const intentType = intentTypes.find(t => t.id === effectiveIntentTypeId);
  const template = intentType?.export_template ?? DEFAULT_EXPORT_TEMPLATE;
  const note = item.override_note ?? item.note;
  const url = getVideoUrl(item.platform, item.platform_video_id);
  const rendered = renderTemplate(template, {
    title: item.title ?? '',
    channel_name: item.channel_name ?? '',
    platform: item.platform,
    url,
    note,
    intent_name: item.intent_type_name,
  });

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg-primary)',
          padding: 24,
          borderRadius: 12,
          width: 600,
          maxWidth: '90vw',
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0, marginBottom: 16, fontSize: 16, color: 'var(--text-primary)' }}>
          预览导出 — {item.title}
        </h3>
        <pre
          style={{
            background: 'var(--bg-secondary)',
            padding: 16,
            borderRadius: 8,
            overflow: 'auto',
            maxHeight: 400,
            fontSize: 13,
            color: 'var(--text-primary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            margin: '0 0 12px 0',
          }}
        >
          {rendered}
        </pre>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16 }}>
          字幕内容将在导出时附加
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="premium-button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CollectionDetailPage() {
  const params = useParams();
  const collectionId = params.id as string;

  const [collection, setCollection] = useState<ResearchCollection | null>(null);
  const [items, setItems] = useState<ResearchFavorite[]>([]);
  const [loading, setLoading] = useState(true);
  const [intentTypes, setIntentTypes] = useState<ResearchIntentType[]>([]);

  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{
    pack_path: string;
    items_count: number;
    skipped_count: number;
  } | null>(null);

  const [missingModal, setMissingModal] = useState<{
    needs_confirmation: boolean;
    missing_count: number;
    missing: { video_id: string; title: string }[];
  } | null>(null);

  const [previewItem, setPreviewItem] = useState<ResearchFavorite | null>(null);

  // Per-item saving state: itemSaving[favorite_id] = true|false
  const [itemSaving, setItemSaving] = useState<Record<number, boolean>>({});
  const [retryingSubtitleIds, setRetryingSubtitleIds] = useState<Set<number>>(new Set());
  const [openingFavoriteId, setOpeningFavoriteId] = useState<number | null>(null);
  const [playingVideo, setPlayingVideo] = useState<VideoWithMeta | null>(null);

  const normalizeCollectionPayload = (
    data: unknown,
  ): { collection: ResearchCollection | null; items: ResearchFavorite[] } => {
    if (!data || typeof data !== 'object') {
      return { collection: null, items: [] };
    }

    const payload = data as Record<string, unknown>;
    const rawItems = Array.isArray(payload.items)
      ? (payload.items as ResearchFavorite[])
      : [];

    // Normalize favorite_id: items may expose it directly or as id from favorites join
    const normalizedItems = rawItems.map(item => ({
      ...item,
      favorite_id: item.favorite_id ?? item.id,
    }));

    if (
      payload.collection &&
      typeof payload.collection === 'object' &&
      !Array.isArray(payload.collection)
    ) {
      return {
        collection: payload.collection as ResearchCollection,
        items: normalizedItems,
      };
    }

    if (
      typeof payload.id === 'number' &&
      typeof payload.name === 'string' &&
      typeof payload.slug === 'string'
    ) {
      return {
        collection: {
          id: payload.id,
          name: payload.name,
          slug: payload.slug,
          goal: (payload.goal as string | null) ?? null,
          description: (payload.description as string | null) ?? null,
        },
        items: normalizedItems,
      };
    }

    return { collection: null, items: normalizedItems };
  };

  const fetchCollection = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/research/collections/${collectionId}`);
      if (!res.ok) throw new Error('Failed to load collection');
      const data = await res.json();
      const normalized = normalizeCollectionPayload(data);
      setCollection(normalized.collection);
      setItems(normalized.items);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const fetchIntentTypes = async () => {
    try {
      const res = await fetch('/api/research/intent-types');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) setIntentTypes(data as ResearchIntentType[]);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchCollection();
    fetchIntentTypes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionId]);

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

        setItems((prev) =>
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

  const triggerSubtitleRetry = async (
    item: Pick<ResearchFavorite, 'favorite_id' | 'platform' | 'platform_video_id'>,
  ) => {
    setRetryingSubtitleIds((prev) => new Set(prev).add(item.favorite_id));
    const params = new URLSearchParams({
      source: 'player',
      preferredMethod: item.platform === 'youtube' ? 'piped' : 'browser',
      async: '1',
      force: '1',
    });

    try {
      const lookupRes = await fetch(
        `/api/videos/lookup?video_id=${encodeURIComponent(item.platform_video_id)}&platform=${item.platform}`,
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
        next.delete(item.favorite_id);
        return next;
      });
    }
  };

  const openItemInPlayer = async (
    item: Pick<ResearchFavorite, 'favorite_id' | 'platform' | 'platform_video_id'>,
  ) => {
    setOpeningFavoriteId(item.favorite_id);
    try {
      const lookupRes = await fetch(
        `/api/videos/lookup?video_id=${encodeURIComponent(item.platform_video_id)}&platform=${item.platform}`,
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
      setOpeningFavoriteId((current) =>
        current === item.favorite_id ? null : current,
      );
    }
  };

  const handleExport = async (skipMissingSubtitles = false) => {
    setExporting(true);
    setMissingModal(null);
    setExportResult(null);
    try {
      const res = await fetch('/api/research/exports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collection_id: Number(collectionId),
          skip_missing_subtitles: skipMissingSubtitles,
        }),
      });
      const data = await res.json();

      if (data.needs_confirmation) {
        setMissingModal(data);
        return;
      }

      if (!res.ok) {
        alert('导出失败: ' + (data.error || '未知错误'));
        return;
      } else {
        setExportResult(data);
      }
    } catch {
      alert('导出时发生错误');
    } finally {
      setExporting(false);
    }
  };

  // Collection meta inline save
  const saveCollectionField = async (field: 'name' | 'goal' | 'description', value: string) => {
    if (!collection) return;
    if (field === 'name' && !value.trim()) return;
    const res = await fetch(`/api/research/collections/${collectionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    });
    if (!res.ok) throw new Error('保存失败');
    const updated = await res.json();
    setCollection(prev =>
      prev
        ? {
            ...prev,
            name: updated.name ?? prev.name,
            goal: updated.goal ?? prev.goal,
            description: updated.description ?? prev.description,
          }
        : prev,
    );
  };

  // Item field patch
  const patchItem = async (favoriteId: number, patch: { override_note?: string | null; override_intent_type_id?: number | null }) => {
    setItemSaving(s => ({ ...s, [favoriteId]: true }));
    try {
      const res = await fetch(`/api/research/collections/${collectionId}/items`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite_id: favoriteId, ...patch }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '保存失败');
      }
      // Update local state
      setItems(prev =>
        prev.map(item => {
          if (item.favorite_id !== favoriteId) return item;
          return { ...item, ...patch };
        }),
      );
    } catch (err) {
      alert('保存失败: ' + (err instanceof Error ? err.message : '未知错误'));
      throw err;
    } finally {
      setItemSaving(s => ({ ...s, [favoriteId]: false }));
    }
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 80, color: 'var(--text-secondary)' }}>
        加载中...
      </div>
    );
  }

  if (!collection) {
    return (
      <div style={{ textAlign: 'center', padding: 80, color: 'var(--text-secondary)' }}>
        未找到清单
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '40px 20px' }}>
      <div style={{ marginBottom: 30 }}>
        <Link
          href="/research"
          style={{
            color: 'var(--text-secondary)',
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            marginBottom: 16,
          }}
        >
          ← 返回研究收藏
        </Link>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, marginRight: 24 }}>
            {/* Inline editable name */}
            <InlineEditText
              value={collection.name}
              onSave={val => saveCollectionField('name', val)}
              placeholder="清单名称"
              style={{ fontSize: 28, fontWeight: 700, marginBottom: 12 }}
            />
            {/* Inline editable goal */}
            <div style={{ color: 'var(--text-secondary)', fontSize: 15, marginBottom: 8, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
              <strong style={{ whiteSpace: 'nowrap', marginTop: 2 }}>研究目标：</strong>
              <InlineEditText
                value={collection.goal ?? ''}
                onSave={val => saveCollectionField('goal', val)}
                multiline
                placeholder="点击添加研究目标"
                style={{ flex: 1, fontSize: 15, color: 'var(--text-secondary)' }}
              />
            </div>
            {/* Inline editable description */}
            <div style={{ color: 'var(--text-secondary)', fontSize: 14, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
              <strong style={{ whiteSpace: 'nowrap', marginTop: 2 }}>描述：</strong>
              <InlineEditText
                value={collection.description ?? ''}
                onSave={val => saveCollectionField('description', val)}
                multiline
                placeholder="点击添加描述"
                style={{ flex: 1, fontSize: 14, color: 'var(--text-secondary)' }}
              />
            </div>
          </div>

          <button
            className="premium-button primary"
            onClick={() => handleExport(false)}
            disabled={exporting || items.length === 0}
            style={{ padding: '10px 20px', fontSize: 15, background: 'var(--accent-purple)', flexShrink: 0 }}
          >
            {exporting ? '导出中...' : '📦 导出研究包'}
          </button>
        </div>
      </div>

      {exportResult && (
        <div
          style={{
            background: 'var(--bg-hover)',
            padding: '20px 24px',
            borderRadius: 12,
            marginBottom: 30,
            border: '1px solid var(--accent-purple)',
          }}
        >
          <h3
            style={{
              margin: '0 0 12px 0',
              color: 'var(--accent-purple)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            ✅ 导出成功
          </h3>
          <div style={{ fontSize: 14, color: 'var(--text-primary)', marginBottom: 8 }}>
            共导出 {exportResult.items_count} 个素材记录。(跳过了 {exportResult.skipped_count}{' '}
            个无字幕素材)
          </div>
          <div style={{ fontSize: 14, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
            <span style={{ fontWeight: 600 }}>保存路径：</span> {exportResult.pack_path}
          </div>
        </div>
      )}

      <div>
        <h2 style={{ fontSize: 18, marginBottom: 20, color: 'var(--text-primary)' }}>
          包含素材 ({items.length})
        </h2>
        {items.length === 0 ? (
          <div
            style={{
              textAlign: 'center',
              padding: 60,
              background: 'var(--bg-secondary)',
              borderRadius: 12,
              color: 'var(--text-secondary)',
            }}
          >
            {'此清单暂无素材，请在"未整理"中添加。'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {items.map(item => {
              const effectiveNote = item.override_note ?? item.note;
              const effectiveIntentTypeId = item.override_intent_type_id ?? item.intent_type_id;
              const missingSubtitle = !hasSubtitleReady({
                subtitle_status: item.subtitle_status ?? null,
                subtitle_cooldown_until: item.subtitle_cooldown_until ?? null,
              });
              const saving = itemSaving[item.favorite_id];
              const subtitleBadge = getSubtitleBadgeMeta(item);

              return (
                <div
                  key={item.favorite_id}
                  style={{
                    display: 'flex',
                    background: 'var(--bg-secondary)',
                    borderRadius: 12,
                    overflow: 'hidden',
                    border: '1px solid var(--border)',
                    position: 'relative',
                  }}
                >
                  {/* Thumbnail */}
                  <button
                    type="button"
                    onClick={() => void openItemInPlayer(item)}
                    disabled={openingFavoriteId === item.favorite_id}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      padding: 0,
                      margin: 0,
                      cursor:
                        openingFavoriteId === item.favorite_id ? 'progress' : 'pointer',
                      flexShrink: 0,
                    }}
                    title="打开播放器"
                  >
                    {item.thumbnail_url ? (
                      <img
                        src={item.thumbnail_url}
                        style={{ width: 160, height: 90, objectFit: 'cover', flexShrink: 0, display: 'block' }}
                        alt=""
                      />
                    ) : (
                      <div
                        style={{
                          width: 160,
                          height: 90,
                          background: '#333',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        {openingFavoriteId === item.favorite_id
                          ? '…'
                          : item.platform === 'youtube'
                            ? '▶'
                            : '🅱'}
                      </div>
                    )}
                  </button>

                  <div
                    style={{
                      padding: '16px 20px',
                      flex: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      minWidth: 0,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => void openItemInPlayer(item)}
                      disabled={openingFavoriteId === item.favorite_id}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        padding: 0,
                        margin: '0 0 4px 0',
                        fontSize: 16,
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                        textAlign: 'left',
                        cursor:
                          openingFavoriteId === item.favorite_id ? 'progress' : 'pointer',
                      }}
                      title="打开播放器"
                    >
                      {item.title}
                    </button>
                    <div
                      style={{
                        fontSize: 13,
                        color: 'var(--text-secondary)',
                        marginBottom: 12,
                        display: 'flex',
                        gap: 12,
                        flexWrap: 'wrap',
                        alignItems: 'center',
                      }}
                    >
                      <span
                        style={{
                          color:
                            item.platform === 'youtube'
                              ? 'var(--accent-yt)'
                              : 'var(--accent-bili)',
                        }}
                      >
                        {item.platform === 'youtube' ? 'YouTube' : 'Bilibili'}
                      </span>
                      <span>{item.channel_name}</span>
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

                      {/* Inline intent type select */}
                      <select
                        value={effectiveIntentTypeId}
                        disabled={saving}
                        onChange={async e => {
                          const val = Number(e.target.value);
                          await patchItem(item.favorite_id, {
                            override_intent_type_id: val,
                          }).catch(() => {});
                        }}
                        style={{
                          background: 'var(--bg-hover)',
                          border: '1px solid var(--border)',
                          borderRadius: 4,
                          color: 'var(--text-primary)',
                          fontSize: 12,
                          padding: '2px 6px',
                          cursor: 'pointer',
                        }}
                      >
                        {intentTypes.map(t => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>

                      {saving && (
                        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                          保存中…
                        </span>
                      )}
                    </div>

                    {/* Inline note textarea */}
                    <div style={{ marginBottom: 8 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: 'var(--text-secondary)',
                          marginBottom: 4,
                          opacity: 0.7,
                        }}
                      >
                        笔记
                      </div>
                      <NoteTextarea
                        key={item.favorite_id}
                        defaultValue={effectiveNote}
                        disabled={saving}
                        onSave={async val => {
                          await patchItem(item.favorite_id, { override_note: val });
                        }}
                      />
                    </div>

                    {/* Preview button */}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4, gap: 8 }}>
                      <a
                        href={buildVideoUrl(item.platform, item.platform_video_id)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="premium-button"
                        style={{ fontSize: 12, padding: '4px 10px', textDecoration: 'none' }}
                      >
                        原始页
                      </a>
                      {missingSubtitle && (
                        <button
                          className="premium-button"
                          style={{ fontSize: 12, padding: '4px 10px' }}
                          disabled={retryingSubtitleIds.has(item.favorite_id)}
                          onClick={() => {
                            void triggerSubtitleRetry(item);
                          }}
                        >
                          {retryingSubtitleIds.has(item.favorite_id) ? '排队中...' : '重试字幕'}
                        </button>
                      )}
                      <button
                        className="premium-button"
                        style={{ fontSize: 12, padding: '4px 10px' }}
                        onClick={() => setPreviewItem(item)}
                      >
                        预览导出
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Missing subtitles modal */}
      {missingModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: 'var(--bg-primary)',
              padding: 24,
              borderRadius: 12,
              width: 500,
              boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
            }}
          >
            <h3 style={{ marginTop: 0, marginBottom: 16, fontSize: 18, color: 'var(--text-primary)' }}>
              ⚠️ 部分素材缺失字幕
            </h3>
            <div
              style={{
                marginBottom: 20,
                fontSize: 14,
                color: 'var(--text-secondary)',
                lineHeight: 1.5,
              }}
            >
              清单中有 <strong>{missingModal.missing_count}</strong>{' '}
              个素材当前还没有提取完成字幕。如果你继续导出，这些素材将被跳过。
            </div>
            <div
              style={{
                maxHeight: 200,
                overflowY: 'auto',
                background: 'var(--bg-secondary)',
                padding: 12,
                borderRadius: 8,
                marginBottom: 24,
              }}
            >
              {missingModal.missing.map(m => (
                <div
                  key={m.video_id}
                  style={{
                    fontSize: 13,
                    color: 'var(--text-primary)',
                    padding: '4px 0',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  {m.title || m.video_id}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
              <button
                className="premium-button"
                onClick={() => setMissingModal(null)}
                disabled={exporting}
              >
                取消导出
              </button>
              <button
                className="premium-button primary"
                onClick={() => handleExport(true)}
                disabled={exporting}
                style={{ background: 'var(--accent-purple)' }}
              >
                仅导出有字幕的素材
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview export modal */}
      {previewItem && (
        <PreviewModal
          item={previewItem}
          intentTypes={intentTypes}
          onClose={() => setPreviewItem(null)}
        />
      )}

      {playingVideo && (
        <PlayerModal
          video={playingVideo}
          onClose={() => setPlayingVideo(null)}
        />
      )}
    </div>
  );
}

// Separate component to manage textarea state independently per item.
// Rendered with key={favoriteId} so it remounts if the parent item changes.
function NoteTextarea({
  defaultValue,
  onSave,
  disabled,
}: {
  defaultValue: string;
  onSave: (val: string) => Promise<void>;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(defaultValue);
  const originalRef = useRef(defaultValue);

  const handleBlur = async () => {
    if (value === originalRef.current) return;
    try {
      await onSave(value);
      originalRef.current = value;
    } catch {
      setValue(originalRef.current);
    }
  };

  return (
    <textarea
      value={value}
      onChange={e => setValue(e.target.value)}
      onBlur={handleBlur}
      disabled={disabled}
      rows={3}
      style={{
        width: '100%',
        minHeight: 60,
        resize: 'vertical',
        background: 'var(--bg-hover)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '6px 8px',
        fontSize: 14,
        color: 'var(--text-primary)',
        font: 'inherit',
        boxSizing: 'border-box',
      }}
    />
  );
}
