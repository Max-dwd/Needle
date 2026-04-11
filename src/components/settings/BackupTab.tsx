'use client';

import { useT } from '@/contexts/LanguageContext';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ShowToast } from './shared';

interface BackupTabProps {
  showToast: ShowToast;
}

interface BackupArchiveInfo {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  createdAt: string;
}

interface BackupReadiness {
  canRestore: boolean;
  busyReasons: string[];
  schedulerEnabled: boolean;
  schedulerState: string;
  subtitleQueueLength: number;
  subtitleProcessing: boolean;
  summaryQueueLength: number;
  summaryProcessing: boolean;
}

interface BackupStatusPayload {
  latestBackup: BackupArchiveInfo | null;
  readiness: BackupReadiness;
}

type RestoreMode = 'full' | 'db-only' | 'files-only';

const restoreModeOptions: Array<{
  value: RestoreMode;
  label: string;
  description: string;
}> = [
  {
    value: 'full',
    label: '完整还原',
    description: '替换数据库、字幕和摘要文件。',
  },
  {
    value: 'db-only',
    label: '仅数据库',
    description: '只替换 SQLite 数据库。',
  },
  {
    value: 'files-only',
    label: '仅文件',
    description: '只替换字幕和摘要文件目录。',
  },
];

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function parseFilenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/filename="?([^"]+)"?/i);
  return match?.[1] || null;
}

export default function BackupTab({ showToast }: BackupTabProps) {
  const [status, setStatus] = useState<BackupStatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [backupRunning, setBackupRunning] = useState(false);
  const [restoreRunning, setRestoreRunning] = useState(false);
  const [includeSummaryMd, setIncludeSummaryMd] = useState(false);
  const [includeEnv, setIncludeEnv] = useState(false);
  const [restoreMode, setRestoreMode] = useState<RestoreMode>('full');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const t = useT();

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/backup/restore', { cache: 'no-store' });
      const data = (await res.json()) as BackupStatusPayload & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'READ_FAILED');
      }
      setStatus(data);
    } catch {
      showToast(t.settings.backup.toastReadFailed, 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const latestBackupLabel = useMemo(() => {
    if (!status?.latestBackup) {
      return t.settings.backup.noBackup;
    }

    return `${new Date(status.latestBackup.createdAt).toLocaleString()} · ${formatBytes(status.latestBackup.sizeBytes)} · ${status.latestBackup.fileName}`;
  }, [status]);

  const handleBackup = async () => {
    setBackupRunning(true);
    try {
      const params = new URLSearchParams();
      if (includeSummaryMd) {
        params.set('includeSummaryMd', '1');
      }
      if (includeEnv) {
        params.set('includeEnv', '1');
      }

      const url = params.toString()
        ? `/api/backup/download?${params.toString()}`
        : '/api/backup/download';
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(data?.error || '备份失败');
      }

      const blob = await res.blob();
      const fileName =
        parseFilenameFromDisposition(res.headers.get('Content-Disposition')) ||
        `needle-backup-${new Date().toISOString().slice(0, 19)}.tar.gz`;
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);

      showToast(t.settings.backup.toastBackupStarted);
      await loadStatus();
    } catch (error) {
      const message = error instanceof Error && error.message !== 'BACKUP_FAILED' ? error.message : t.settings.backup.toastBackupFailed;
      showToast(message, 'error');
    } finally {
      setBackupRunning(false);
    }
  };

  const handleRestore = async () => {
    if (!selectedFile) {
      showToast(t.settings.backup.toastSelectFileFirst, 'error');
      return;
    }

    const confirmMessage =
      restoreMode === 'full'
        ? t.settings.backup.confirmFullRestore
        : t.settings.backup.confirmPartialRestore;
    if (!window.confirm(confirmMessage)) {
      return;
    }

    setRestoreRunning(true);
    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('mode', restoreMode);

      const res = await fetch('/api/backup/restore', {
        method: 'POST',
        body: formData,
      });
      const data = (await res.json()) as
        | (BackupStatusPayload & {
            ok?: boolean;
            error?: string;
            schedulerRestarted?: boolean;
          })
        | null;

      if (!res.ok) {
        throw new Error(data?.error || '还原失败');
      }

      showToast(
        data?.schedulerRestarted
          ? t.settings.backup.toastRestoreScheduler
          : t.settings.backup.toastRestoreReload,
      );
      setSelectedFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      setStatus(data);
      window.setTimeout(() => {
        window.location.reload();
      }, 800);
    } catch (error) {
      const message = error instanceof Error && error.message !== 'RESTORE_FAILED' ? error.message : t.settings.backup.toastRestoreFailed;
      showToast(message, 'error');
      await loadStatus();
    } finally {
      setRestoreRunning(false);
    }
  };

  return (
    <div className="settings-section-wrapper animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="settings-group">
        <h2 className="settings-group-title">{t.settings.backup.downloadSection}</h2>
        <div className="settings-note-box">
          {t.settings.backup.latestBackup} {loading ? t.common.loading : latestBackupLabel}
        </div>
        <div className="settings-card-group" style={{ marginTop: 16 }}>
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.backup.includeSummaryMd}</span>
              <span className="setting-description">
                {t.settings.backup.includeSummaryMdDesc}
              </span>
            </div>
            <div className="setting-control-wrapper">
              <label className="premium-toggle">
                <input
                  type="checkbox"
                  checked={includeSummaryMd}
                  onChange={(event) => setIncludeSummaryMd(event.target.checked)}
                  disabled={backupRunning}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.backup.includeEnv}</span>
              <span className="setting-description">
                {t.settings.backup.includeEnvDesc}
              </span>
            </div>
            <div className="setting-control-wrapper">
              <label className="premium-toggle">
                <input
                  type="checkbox"
                  checked={includeEnv}
                  onChange={(event) => setIncludeEnv(event.target.checked)}
                  disabled={backupRunning}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>
          </div>

          <div
            className="setting-row"
            style={{ justifyContent: 'flex-end', background: '#fafafa' }}
          >
            <button
              className="premium-button primary"
              onClick={handleBackup}
              disabled={backupRunning}
            >
              {backupRunning ? t.settings.backup.packing : t.settings.backup.backupNow}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title">{t.settings.backup.restoreSection}</h2>
        <div className="settings-note-box">
          <p>{t.settings.backup.restoreWarning1}</p>
          <p style={{ marginTop: 8 }}>
            {t.settings.backup.currentState}
            {status?.readiness.canRestore
              ? t.settings.backup.systemIdle
              : status?.readiness.busyReasons.join('；') || t.common.loading}
          </p>
        </div>
        <div className="settings-card-group" style={{ marginTop: 16 }}>
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.backup.restoreMode}</span>
              <span className="setting-description">
                {t.settings.backup.restoreModeDesc}
              </span>
            </div>
            <div className="setting-control-wrapper">
              <select
                className="premium-select"
                value={restoreMode}
                onChange={(event) =>
                  setRestoreMode(event.target.value as RestoreMode)
                }
                disabled={restoreRunning}
              >
                {restoreModeOptions.map((option, i) => (
                  <option key={option.value} value={option.value}>
                    {t.options.restoreMode?.[i]?.label || option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="setting-row" style={{ alignItems: 'flex-start' }}>
            <div className="setting-info">
              <span className="setting-label">{t.settings.backup.backupPackage}</span>
              <span className="setting-description">
                {(() => {
                  const idx = restoreModeOptions.findIndex(o => o.value === restoreMode);
                  return idx !== -1 ? (t.options.restoreMode?.[idx]?.description || restoreModeOptions[idx].description) : '';
                })()}
              </span>
            </div>
            <div
              className="setting-control-wrapper"
              style={{ flexDirection: 'column', alignItems: 'flex-end', gap: 10 }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".tar.gz,application/gzip"
                onChange={(event) =>
                  setSelectedFile(event.target.files?.[0] || null)
                }
                disabled={restoreRunning}
              />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {selectedFile
                  ? `${selectedFile.name} · ${formatBytes(selectedFile.size)}`
                  : t.settings.backup.noFileSelected}
              </span>
            </div>
          </div>

          <div
            className="setting-row"
            style={{ justifyContent: 'flex-end', background: '#fafafa' }}
          >
            <button
              className="premium-button"
              onClick={() => {
                setSelectedFile(null);
                if (fileInputRef.current) {
                  fileInputRef.current.value = '';
                }
              }}
              disabled={restoreRunning || !selectedFile}
            >
              {t.settings.backup.clearSelection}
            </button>
            <button
              className="premium-button primary"
              onClick={handleRestore}
              disabled={restoreRunning || !selectedFile || !status?.readiness.canRestore}
            >
              {restoreRunning ? t.settings.backup.restoring : t.settings.backup.uploadAndRestore}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
