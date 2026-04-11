'use client';

import { useState, useEffect } from 'react';

interface ExternalVideoAddModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

interface IntentType {
  id: number;
  name: string;
}

interface VideoMetadata {
  platform: 'youtube' | 'bilibili';
  video_id: string;
  title: string;
  thumbnail_url: string;
  channel_name?: string;
  published_at?: string;
  duration?: string;
  exists?: boolean;
}

export default function ExternalVideoAddModal({
  onClose,
  onSuccess,
}: ExternalVideoAddModalProps) {
  const [url, setUrl] = useState('');
  const [stage, setStage] = useState<'url' | 'details'>('url');
  const [loading, setLoading] = useState(false);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [intentTypes, setIntentTypes] = useState<IntentType[]>([]);
  const [selectedIntentTypeId, setSelectedIntentTypeId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    async function fetchIntents() {
      try {
        const res = await fetch('/api/research/intent-types');
        const data = await res.json();
        setIntentTypes(data);
        if (data.length > 0) {
          setSelectedIntentTypeId(data[0].id);
        }
      } catch (err) {
        console.error('Failed to fetch intent types', err);
      }
    }
    fetchIntents();
  }, []);

  const handleResolve = async () => {
    if (!url.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/research/videos/resolve?url=${encodeURIComponent(url.trim())}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '解析失败');
      
      setMetadata(data.video);
      if (data.exists) {
        // If already in research_favorites (not just videos table), we should tell user
        const favRes = await fetch(`/api/research/favorites?video_id=${data.video.id}`);
        const favData = await favRes.json();
        if (favData.items && favData.items.length > 0) {
            setError('该视频已在研究收藏中');
            setLoading(false);
            return;
        }
      }
      
      setStage('details');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!selectedIntentTypeId || !note.trim()) {
      setError('意图和备注不能为空');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/research/favorites/from-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url.trim(),
          intent_type_id: selectedIntentTypeId,
          note: note.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '添加失败');
      
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100000,
        backdropFilter: 'blur(4px)',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg-primary)',
          borderRadius: 16,
          padding: 32,
          width: '90%',
          maxWidth: 550,
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.3)',
          border: '1px solid var(--border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 22, color: 'var(--text-primary)', fontWeight: 700 }}>
            {stage === 'url' ? '添加外部视频' : '完善研究收藏信息'}
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: 24,
              cursor: 'pointer',
              color: 'var(--text-secondary)',
            }}
          >
            ×
          </button>
        </div>

        {stage === 'url' ? (
          <div>
            <div style={{ marginBottom: 24 }}>
              <label style={{ display: 'block', marginBottom: 12, fontSize: 15, fontWeight: 500, color: 'var(--text-primary)' }}>
                粘贴 YouTube 或 Bilibili 视频链接
              </label>
              <div style={{ display: 'flex', gap: 12 }}>
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=... 或 https://www.bilibili.com/video/..."
                  className="premium-input"
                  style={{ flex: 1, padding: '12px 16px', fontSize: 15 }}
                  autoFocus
                  onKeyDown={e => e.key === 'Enter' && handleResolve()}
                />
                <button
                  onClick={handleResolve}
                  disabled={loading || !url.trim()}
                  className="premium-button primary"
                  style={{ padding: '0 24px', height: 46 }}
                >
                  {loading ? '解析中...' : '解析'}
                </button>
              </div>
              <p style={{ marginTop: 12, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                解析成功后，视频元数据将被自动捕获并存入本地数据库作为研究素材。
              </p>
            </div>
            {error && (
              <div style={{ color: 'var(--destructive)', fontSize: 14, background: 'rgba(255, 0, 0, 0.05)', padding: '12px', borderRadius: 8, marginBottom: 16 }}>
                ⚠️ {error}
              </div>
            )}
          </div>
        ) : (
          <div>
            {metadata && (
              <div style={{ 
                display: 'flex', 
                gap: 16, 
                marginBottom: 24, 
                padding: 16, 
                background: 'var(--bg-secondary)', 
                borderRadius: 12,
                border: '1px solid var(--border)' 
              }}>
                <img 
                  src={metadata.thumbnail_url} 
                  style={{ width: 140, height: 80, objectFit: 'cover', borderRadius: 8 }} 
                  alt="" 
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ 
                    fontSize: 15, 
                    fontWeight: 600, 
                    color: 'var(--text-primary)', 
                    marginBottom: 4,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden'
                  }}>
                    {metadata.title}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                    {metadata.channel_name || '未知频道'}
                  </div>
                   <div style={{ fontSize: 11, color: metadata.platform === 'youtube' ? 'var(--accent-yt)' : 'var(--accent-bili)', marginTop: 4, fontWeight: 700, textTransform: 'uppercase' }}>
                    {metadata.platform}
                  </div>
                </div>
              </div>
            )}

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', marginBottom: 8, fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                研究意图 <span style={{ color: 'var(--destructive)' }}>*</span>
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {intentTypes.map((intent) => (
                  <label
                    key={intent.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '8px 16px',
                      borderRadius: 100,
                      border: selectedIntentTypeId === intent.id ? '2px solid var(--accent-purple)' : '1px solid var(--border)',
                      background: selectedIntentTypeId === intent.id ? 'rgba(168, 85, 247, 0.1)' : 'transparent',
                      cursor: 'pointer',
                      fontSize: 14,
                      color: selectedIntentTypeId === intent.id ? 'var(--accent-purple)' : 'var(--text-secondary)',
                      fontWeight: selectedIntentTypeId === intent.id ? 600 : 400,
                      transition: 'all 0.2s'
                    }}
                  >
                    <input
                      type="radio"
                      name="intentType"
                      checked={selectedIntentTypeId === intent.id}
                      onChange={() => setSelectedIntentTypeId(intent.id)}
                      style={{ display: 'none' }}
                    />
                    {intent.name}
                  </label>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 24 }}>
              <label style={{ display: 'block', marginBottom: 8, fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                研究笔记 <span style={{ color: 'var(--destructive)' }}>*</span>
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="记录此素材的独特价值..."
                style={{
                  width: '100%',
                  minHeight: 120,
                  padding: 16,
                  borderRadius: 12,
                  border: '1px solid var(--border)',
                  background: 'var(--bg-input)',
                  color: 'var(--text-primary)',
                  fontSize: 14,
                  resize: 'vertical',
                  fontFamily: 'inherit',
                  lineHeight: 1.6
                }}
                autoFocus
              />
            </div>

            {error && (
              <div style={{ color: 'var(--destructive)', fontSize: 14, marginBottom: 20, textAlign: 'center' }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
              <button
                type="button"
                onClick={() => setStage('url')}
                disabled={submitting}
                className="premium-button"
              >
                返回
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || !selectedIntentTypeId || !note.trim()}
                className="premium-button primary"
                style={{ minWidth: 120 }}
              >
                {submitting ? '提交中...' : '确认添加'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
