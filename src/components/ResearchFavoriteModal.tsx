'use client';

import { useState, useEffect } from 'react';
import type { VideoWithMeta } from '@/types';

interface ResearchFavoriteModalProps {
  video: VideoWithMeta;
  mode: 'add' | 'edit';
  existingFavorite?: {
    id: number;
    intent_type_id: number;
    note: string;
  };
  onClose: () => void;
  onSuccess: () => void;
}

interface IntentType {
  id: number;
  name: string;
}

export default function ResearchFavoriteModal({
  video,
  mode,
  existingFavorite,
  onClose,
  onSuccess,
}: ResearchFavoriteModalProps) {
  const [intentTypes, setIntentTypes] = useState<IntentType[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  
  const [selectedIntentTypeId, setSelectedIntentTypeId] = useState<number | null>(existingFavorite?.intent_type_id || null);
  const [note, setNote] = useState(existingFavorite?.note || '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch('/api/research/intent-types');
        if (!res.ok) throw new Error('获取研究意图失败');
        const data = await res.json();
        setIntentTypes(data);
        
        if (mode === 'add' && data.length > 0 && !selectedIntentTypeId) {
          setSelectedIntentTypeId(data[0].id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [mode, selectedIntentTypeId]);

  const handleSubmit = async () => {
    if (!selectedIntentTypeId) {
      setError('请选择一个研究意图');
      return;
    }
    if (!note.trim()) {
      setError('研究备注不能为空');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      if (mode === 'edit' && existingFavorite?.id) {
        const res = await fetch(`/api/research/favorites`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: existingFavorite.id,
            intent_type_id: selectedIntentTypeId,
            note: note.trim(),
          }),
        });
        if (!res.ok) throw new Error('更新失败');
      } else {
        const res = await fetch(`/api/research/favorites`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            video_id: video.id,
            intent_type_id: selectedIntentTypeId,
            note: note.trim(),
          }),
        });
        if (!res.ok) {
           const errData = await res.json().catch(() => ({}));
           throw new Error(errData.error || '添加失败');
        }
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async () => {
    if (mode !== 'edit' || !existingFavorite?.id) return;
    if (!confirm('确定要移除此视频的研究收藏吗？')) return;
    
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/research/favorites/${existingFavorite.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('移除失败');
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
          borderRadius: 12,
          padding: 24,
          width: '90%',
          maxWidth: 500,
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.2)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 18, color: 'var(--text-primary)' }}>
            {mode === 'edit' ? '编辑研究收藏' : '加入研究收藏'}
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: 20,
              cursor: 'pointer',
              color: 'var(--text-secondary)',
            }}
          >
            ×
          </button>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>
            加载中...
          </div>
        ) : (
          <div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', marginBottom: 8, fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
                选择意图类型 <span style={{ color: 'var(--destructive)' }}>*</span>
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {intentTypes.map((intent) => (
                  <label
                    key={intent.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '8px 12px',
                      borderRadius: 8,
                      border: selectedIntentTypeId === intent.id ? '2px solid var(--accent-purple)' : '1px solid var(--border)',
                      background: selectedIntentTypeId === intent.id ? 'var(--bg-hover)' : 'transparent',
                      cursor: 'pointer',
                      fontSize: 14,
                      color: 'var(--text-primary)'
                    }}
                  >
                    <input
                      type="radio"
                      name="intentType"
                      value={intent.id}
                      checked={selectedIntentTypeId === intent.id}
                      onChange={() => setSelectedIntentTypeId(intent.id)}
                      style={{ display: 'none' }}
                    />
                    {intent.name}
                  </label>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', marginBottom: 8, fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
                研究备注 <span style={{ color: 'var(--destructive)' }}>*</span>
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="记录为什么收藏这个视频作为研究素材..."
                style={{
                  width: '100%',
                  minHeight: 120,
                  padding: 12,
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  background: 'var(--bg-input)',
                  color: 'var(--text-primary)',
                  fontSize: 14,
                  resize: 'vertical',
                  fontFamily: 'inherit',
                }}
                autoFocus
              />
            </div>

            {error && (
              <div style={{ color: 'var(--destructive)', fontSize: 14, marginBottom: 16 }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
              {mode === 'edit' && (
                <button
                  type="button"
                  onClick={handleRemove}
                  disabled={submitting}
                  style={{
                    padding: '8px 16px',
                    borderRadius: 8,
                    border: '1px solid var(--destructive)',
                    background: 'transparent',
                    color: 'var(--destructive)',
                    cursor: submitting ? 'not-allowed' : 'pointer',
                    fontSize: 14,
                    marginRight: 'auto',
                  }}
                >
                  移除收藏
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                style={{
                  padding: '8px 16px',
                  borderRadius: 8,
                  border: '1px solid var(--borderStrong)',
                  background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  cursor: submitting ? 'not-allowed' : 'pointer',
                  fontSize: 14,
                }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting}
                className="premium-button primary"
                style={{
                  padding: '8px 16px',
                  borderRadius: 8,
                  border: 'none',
                  background: 'var(--accent-purple)',
                  color: '#fff',
                  cursor: submitting ? 'not-allowed' : 'pointer',
                  fontSize: 14,
                }}
              >
                {submitting ? '提交中...' : '确定'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
