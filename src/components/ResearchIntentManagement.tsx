'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/contexts/LanguageContext';
import type { ShowToast, ToastType } from '@/components/settings/shared';

interface ResearchIntentType {
  id: number;
  name: string;
  slug: string;
  is_preset: number;
  export_template: string | null;
  sort_order: number;
  created_at: string;
}

interface ResearchIntentManagementProps {
  showToast?: ShowToast;
}

export default function ResearchIntentManagement({
  showToast: externalShowToast,
}: ResearchIntentManagementProps) {
  const [intents, setIntents] = useState<ResearchIntentType[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [messageType, setMessageType] = useState<'success' | 'error'>('success');

  // Add form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editTemplate, setEditTemplate] = useState('');
  const [editSortOrder, setEditSortOrder] = useState<number>(0);
  const [saving, setSaving] = useState(false);

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const t = useT();

  const showMessage = useCallback(
    (text: string, type: ToastType = 'success') => {
      if (externalShowToast) {
        externalShowToast(text, type);
        return;
      }
      setMessage(text);
      setMessageType(type);
      setTimeout(() => setMessage(null), 3000);
    },
    [externalShowToast],
  );

  const loadIntents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/research/intent-types', { cache: 'no-store' });
      if (!res.ok) throw new Error('加载失败');
      const data = await res.json() as ResearchIntentType[];
      setIntents(data);
    } catch {
      showMessage(t.settings.researchIntents.toastLoadFailed, 'error');
    } finally {
      setLoading(false);
    }
  }, [showMessage]);

  useEffect(() => {
    void loadIntents();
  }, [loadIntents]);

  const handleAdd = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      const res = await fetch('/api/research/intent-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
        }),
      });
      const data: ResearchIntentType & { error?: string } = await res.json();
      if (!res.ok) {
        showMessage(data.error || t.settings.researchIntents.toastCreateFailed, 'error');
        return;
      }
      setIntents((prev) => [...prev, data]);
      setNewName('');
      setShowAddForm(false);
      showMessage(`${t.settings.researchIntents.toastCreateSuccess}${data.name}`);
    } catch {
      showMessage(t.settings.researchIntents.toastCreateFailed, 'error');
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (intent: ResearchIntentType) => {
    setEditingId(intent.id);
    setEditName(intent.name);
    setEditTemplate(intent.export_template || '');
    setEditSortOrder(intent.sort_order || 0);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
    setEditTemplate('');
  };

  const handleSaveEdit = async (intent: ResearchIntentType) => {
    if (!editName.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/research/intent-types/${intent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          name: editName.trim(),
          export_template: editTemplate.trim() || null,
          sort_order: editSortOrder,
        }),
      });
      const data: ResearchIntentType & { error?: string } = await res.json();
      if (!res.ok) {
        showMessage(data.error || t.settings.researchIntents.toastSaveFailed, 'error');
        return;
      }
      setIntents((prev) => {
        const next = prev.map((i) => (i.id === intent.id ? data : i));
        return next.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
      });
      cancelEdit();
      showMessage(t.settings.researchIntents.toastUpdateSuccess);
    } catch {
      showMessage(t.settings.researchIntents.toastSaveFailed, 'error');
    } finally {
      setSaving(false);
    }
  };

  const openDeleteConfirm = (intent: ResearchIntentType) => {
    if (intent.is_preset === 1) return;
    setDeletingId(intent.id);
    setDeleteConfirmName(intent.name);
  };

  const cancelDelete = () => {
    setDeletingId(null);
    setDeleteConfirmName('');
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/research/intent-types/${deletingId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        showMessage(data.error || t.settings.researchIntents.toastDeleteFailed, 'error');
        return;
      }
      setIntents((prev) => prev.filter((i) => i.id !== deletingId));
      showMessage(`${t.settings.researchIntents.toastDeleteSuccess}${deleteConfirmName}`);
      cancelDelete();
    } catch {
      showMessage(t.settings.researchIntents.toastDeleteFailed, 'error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="settings-group" style={{ paddingBottom: 60 }}>
      {message && !externalShowToast && (
        <div style={{
          padding: '12px 20px',
          background: messageType === 'error' ? '#ef4444' : '#10b981',
          color: '#fff',
          borderRadius: 8,
          marginBottom: 16,
          fontSize: 14,
        }}>
          {message}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <h2 className="settings-group-title" style={{ margin: 0 }}>
          {t.settings.researchIntents.researchIntentConfig}
        </h2>
        {!showAddForm && (
          <button
            className="premium-button"
            onClick={() => setShowAddForm(true)}
            disabled={loading}
          >
            {t.settings.researchIntents.addIntent}
          </button>
        )}
      </div>

      {showAddForm && (
        <div
          className="settings-card-group"
          style={{ marginBottom: 16, padding: '16px 20px' }}
        >
          <div style={{ marginBottom: 12 }}>
            <label
              style={{
                display: 'block',
                fontSize: 13,
                fontWeight: 600,
                marginBottom: 6,
                color: '#1a1a1a',
              }}
            >
              {t.settings.researchIntents.configName}
            </label>
            <input
              className="premium-input"
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t.settings.researchIntents.configNamePlaceholder}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAdd();
                if (e.key === 'Escape') setShowAddForm(false);
              }}
              autoFocus
            />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="premium-button primary"
              onClick={() => void handleAdd()}
              disabled={adding || !newName.trim()}
            >
              {adding ? t.settings.researchIntents.creating : t.settings.researchIntents.confirmCreate}
            </button>
            <button
              className="premium-button"
              onClick={() => {
                setShowAddForm(false);
                setNewName('');
              }}
              disabled={adding}
            >
              {t.settings.researchIntents.cancel}
            </button>
          </div>
        </div>
      )}

      <div className="settings-card-group">
        {loading ? (
          <div
            style={{
              padding: 40,
              textAlign: 'center',
              color: '#888',
              fontSize: 13,
            }}
          >
            {t.settings.researchIntents.loading}
          </div>
        ) : intents.length === 0 ? (
          <div
            style={{
              padding: 40,
              textAlign: 'center',
              color: '#888',
              fontSize: 13,
            }}
          >
            {t.settings.researchIntents.noIntents}
          </div>
        ) : (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(120px, 1fr) 120px 80px 2fr 100px',
                padding: '10px 20px',
                borderBottom: '1px solid oklch(0.922 0 0)',
                background: '#fafafa',
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 600, color: '#888' }}>{t.settings.researchIntents.name}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#888' }}>{t.settings.researchIntents.slug}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#888' }}>{t.settings.researchIntents.sortItem}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#888' }}>{t.settings.researchIntents.exportTemplate}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#888', textAlign: 'center' }}>{t.settings.researchIntents.actions}</span>
            </div>

            {intents.map((intent) => {
              const isEditing = editingId === intent.id;

              return (
                <div
                  key={intent.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(120px, 1fr) 120px 80px 2fr 100px',
                    padding: '14px 20px',
                    borderBottom: '1px solid oklch(0.922 0 0)',
                    alignItems: 'center',
                    background: intent.is_preset === 1 ? '#fafafa' : '#fff',
                  }}
                >
                  <div style={{ minWidth: 0, paddingRight: 10 }}>
                    {isEditing ? (
                       <input
                         className="premium-input"
                         style={{ width: '100%', padding: '4px 8px' }}
                         type="text"
                         value={editName}
                         onChange={(e) => setEditName(e.target.value)}
                         autoFocus
                       />
                    ) : (
                      <span
                        style={{
                          fontSize: 14,
                          fontWeight: 600,
                          color: '#1a1a1a',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6
                        }}
                      >
                        {intent.name}
                        {intent.is_preset === 1 && (
                          <span style={{ fontSize: 10, background: '#e0e0e0', padding: '2px 6px', borderRadius: 4, fontWeight: 'normal' }}>
                            {t.settings.researchIntents.preset}
                          </span>
                        )}
                      </span>
                    )}
                  </div>

                  <div style={{ fontSize: 13, color: '#666', fontFamily: 'monospace' }}>
                    {intent.slug}
                  </div>

                  <div style={{ fontSize: 13, color: '#666', paddingRight: 10 }}>
                    {isEditing ? (
                      <input 
                        className="premium-input"
                        type="number"
                        style={{ width: '100%', padding: '4px 8px' }}
                        value={editSortOrder}
                        onChange={e => setEditSortOrder(parseInt(e.target.value) || 0)}
                      />
                    ) : (
                      intent.sort_order || 0
                    )}
                  </div>

                  <div style={{ paddingRight: 10 }}>
                    {isEditing ? (
                       <textarea
                         className="premium-input"
                         style={{ width: '100%', minHeight: 60, padding: '4px 8px', resize: 'vertical' }}
                         value={editTemplate}
                         onChange={(e) => setEditTemplate(e.target.value)}
                         placeholder="支持 {{title}}, {{channel_name}}, {{platform}}, {{url}}, {{note}}, {{intent_name}}"
                       />
                    ) : (
                       <div style={{ fontSize: 13, color: '#666', whiteSpace: 'pre-wrap', maxHeight: 80, overflowY: 'auto', background: '#f5f5f5', padding: '4px 8px', borderRadius: 4 }}>
                         {intent.export_template || t.settings.researchIntents.defaultTemplate}
                       </div>
                    )}
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    {isEditing ? (
                       <>
                         <button
                           className="premium-button primary"
                           style={{ padding: '4px 8px', fontSize: 12, width: '100%' }}
                           onClick={() => void handleSaveEdit(intent)}
                           disabled={saving || !editName.trim()}
                         >
                           {t.settings.researchIntents.save}
                         </button>
                         <button
                           className="premium-button"
                           style={{ padding: '4px 8px', fontSize: 12, width: '100%' }}
                           onClick={cancelEdit}
                           disabled={saving}
                         >
                           {t.settings.researchIntents.cancel}
                         </button>
                       </>
                    ) : (
                       <>
                         <button
                           title={t.settings.researchIntents.edit}
                           style={{
                             background: 'none',
                             border: '1px solid oklch(0.922 0 0)',
                             borderRadius: 6,
                             padding: '3px 7px',
                             fontSize: 13,
                             cursor: 'pointer',
                             lineHeight: 1,
                             width: '100%',
                           }}
                           onClick={() => startEdit(intent)}
                         >
                           {t.settings.researchIntents.edit}
                         </button>
                         {intent.is_preset !== 1 && (
                           <button
                             title={t.settings.researchIntents.delete}
                             style={{
                               background: 'none',
                               border: '1px solid #fca5a5',
                               borderRadius: 6,
                               padding: '3px 7px',
                               fontSize: 13,
                               cursor: 'pointer',
                               color: '#ef4444',
                               lineHeight: 1,
                               width: '100%',
                             }}
                             onClick={() => openDeleteConfirm(intent)}
                           >
                             {t.settings.researchIntents.delete}
                           </button>
                         )}
                       </>
                    )}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {deletingId !== null && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000,
          }}
        >
          <div
            style={{
              background: '#fff',
              borderRadius: 16,
              padding: 28,
              maxWidth: 400,
              width: '90%',
              boxShadow: '0 8px 32px rgba(0,0,0,0.16)',
            }}
          >
            <h3
              style={{
                fontSize: 17,
                fontWeight: 700,
                marginBottom: 12,
                color: '#1a1a1a',
                marginTop: 0,
              }}
            >
              {t.settings.researchIntents.deleteConfirmTitle}
            </h3>
            <p style={{ fontSize: 14, color: '#666', lineHeight: 1.5, marginBottom: 24 }}>
              {t.settings.researchIntents.deleteConfirmDesc.replace('{name}', deleteConfirmName)}
            </p>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button
                className="premium-button"
                onClick={cancelDelete}
                disabled={deleting}
              >
                {t.settings.researchIntents.cancel}
              </button>
              <button
                className="premium-button primary"
                style={{ background: '#ef4444', borderColor: '#ef4444' }}
                onClick={() => void handleDelete()}
                disabled={deleting}
              >
                {deleting ? t.settings.researchIntents.deleting : t.settings.researchIntents.confirmDelete}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
