'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/contexts/LanguageContext';
import { timeAgo } from '@/lib/format';
import type {
  ErrorHandlingSettings,
  ShowToast,
  TrackedErrorVideo,
} from './shared';

interface ErrorHandlingTabProps {
  showToast: ShowToast;
}

function getExternalUrl(video: TrackedErrorVideo): string {
  if (video.platform === 'youtube') {
    return `https://www.youtube.com/watch?v=${video.video_id}`;
  }
  return `https://www.bilibili.com/video/${video.video_id}`;
}

export default function ErrorHandlingTab({ showToast }: ErrorHandlingTabProps) {
  const [settings, setSettings] = useState<ErrorHandlingSettings | null>(null);
  const [trackedVideos, setTrackedVideos] = useState<TrackedErrorVideo[]>([]);
  const [hideUnavailableVideos, setHideUnavailableVideos] = useState(true);
  const [unavailableVideoBehavior, setUnavailableVideoBehavior] =
    useState<ErrorHandlingSettings['unavailableVideoBehavior']>('keep');
  const [loading, setLoading] = useState(true);
  const [videosLoading, setVideosLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const t = useT();

  const loadTrackedVideos = useCallback(async () => {
    setVideosLoading(true);
    try {
      const res = await fetch('/api/settings/error-handling/videos?limit=200', {
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error('READ_VIDEOS_FAILED');
      }
      const data = (await res.json()) as {
        videos?: TrackedErrorVideo[];
      };
      setTrackedVideos(data.videos ?? []);
    } catch {
      showToast(t.settings.errors.toastReadVideosFailed, 'error');
    } finally {
      setVideosLoading(false);
    }
  }, [showToast, t.settings.errors.toastReadVideosFailed]);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings/error-handling', {
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error('READ_FAILED');
      }
      const data = (await res.json()) as ErrorHandlingSettings;
      setSettings(data);
      setHideUnavailableVideos(data.hideUnavailableVideos !== false);
      setUnavailableVideoBehavior(data.unavailableVideoBehavior);
    } catch {
      showToast(t.settings.errors.toastReadFailed, 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast, t.settings.errors.toastReadFailed]);

  useEffect(() => {
    void loadSettings();
    void loadTrackedVideos();
  }, [loadSettings, loadTrackedVideos]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings/error-handling', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hideUnavailableVideos,
          unavailableVideoBehavior,
        }),
      });
      const data = (await res.json()) as ErrorHandlingSettings & {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || 'SAVE_FAILED');
      }
      setSettings(data);
      setHideUnavailableVideos(data.hideUnavailableVideos !== false);
      setUnavailableVideoBehavior(data.unavailableVideoBehavior);
      await loadTrackedVideos();
      showToast(t.settings.errors.toastSaveSuccess);
    } catch {
      showToast(t.settings.errors.toastSaveFailed, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-section-wrapper animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="settings-group">
        <h2 className="settings-group-title">{t.settings.errors.unavailableVideos}</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">
                {t.settings.errors.hideUnavailableVideos}
              </span>
              <span className="setting-description">
                {t.settings.errors.hideUnavailableVideosDesc}
              </span>
            </div>
            <div className="setting-control-wrapper">
              <label className="premium-toggle">
                <input
                  type="checkbox"
                  checked={hideUnavailableVideos}
                  onChange={() => setHideUnavailableVideos((value) => !value)}
                  disabled={loading || saving}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">
                {t.settings.errors.unavailableVideoBehavior}
              </span>
              <span className="setting-description">
                {t.settings.errors.unavailableVideoBehaviorDesc}
              </span>
            </div>
            <div className="setting-control-wrapper">
              <select
                className="premium-select"
                value={unavailableVideoBehavior}
                onChange={(event) =>
                  setUnavailableVideoBehavior(
                    event.target.value as ErrorHandlingSettings['unavailableVideoBehavior'],
                  )
                }
                disabled={loading || saving}
              >
                <option value="keep">{t.settings.errors.keepUnavailableVideos}</option>
                <option value="abandon">
                  {t.settings.errors.abandonUnavailableVideos}
                </option>
              </select>
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.settings.errors.currentStats}</span>
              <span className="setting-description">
                {t.settings.errors.currentStatsDesc}
              </span>
            </div>
            <div
              className="setting-control-wrapper"
              style={{ display: 'flex', gap: 16, fontSize: 13, color: '#52525b' }}
            >
              <span>
                {t.settings.errors.unavailableCount}: {settings?.counts.unavailable ?? 0}
              </span>
              <span>
                {t.settings.errors.abandonedCount}: {settings?.counts.abandoned ?? 0}
              </span>
            </div>
          </div>

          <div
            className="setting-row"
            style={{ justifyContent: 'flex-end', background: '#fafafa' }}
          >
            <button
              className="premium-button primary"
              onClick={save}
              disabled={loading || saving}
            >
              {saving ? t.settings.errors.saving : t.settings.errors.saveSettings}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-group" style={{ marginTop: 24 }}>
        <h2 className="settings-group-title">{t.settings.errors.trackedVideos}</h2>
        <div className="settings-card-group">
          <div className="setting-row" style={{ alignItems: 'flex-start' }}>
            <div className="setting-info">
              <span className="setting-label">{t.settings.errors.trackedVideos}</span>
              <span className="setting-description">
                {t.settings.errors.trackedVideosDesc}
              </span>
            </div>
          </div>

          {videosLoading ? (
            <div className="setting-row">
              <div className="setting-info">
                <span className="setting-description">
                  {t.settings.errors.trackedVideosLoading}
                </span>
              </div>
            </div>
          ) : trackedVideos.length === 0 ? (
            <div className="setting-row">
              <div className="setting-info">
                <span className="setting-description">
                  {t.settings.errors.trackedVideosEmpty}
                </span>
              </div>
            </div>
          ) : (
            trackedVideos.map((video) => {
              const externalUrl = getExternalUrl(video);
              const statusLabel =
                video.availability_status === 'abandoned'
                  ? t.settings.errors.statusAbandoned
                  : t.settings.errors.statusUnavailable;

              return (
                <div
                  key={video.id}
                  className="setting-row"
                  style={{
                    alignItems: 'stretch',
                    gap: 16,
                    paddingTop: 16,
                    paddingBottom: 16,
                  }}
                >
                  <a
                    href={externalUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      width: 160,
                      minWidth: 160,
                      borderRadius: 12,
                      overflow: 'hidden',
                      background:
                        video.platform === 'youtube'
                          ? 'linear-gradient(135deg, #ff0000 0%, #ff4444 100%)'
                          : 'linear-gradient(135deg, #00a1e4 0%, #34c5f3 100%)',
                      display: 'block',
                      alignSelf: 'flex-start',
                    }}
                    title={t.settings.errors.originalLink}
                  >
                    {video.thumbnail_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={video.thumbnail_url}
                        alt={video.title}
                        style={{
                          width: '100%',
                          aspectRatio: '16 / 9',
                          objectFit: 'cover',
                          display: 'block',
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          width: '100%',
                          aspectRatio: '16 / 9',
                          display: 'grid',
                          placeItems: 'center',
                          color: '#fff',
                          fontSize: 28,
                          fontWeight: 700,
                        }}
                      >
                        {video.platform === 'youtube' ? '▶' : 'B'}
                      </div>
                    )}
                  </a>

                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          borderRadius: 999,
                          padding: '4px 10px',
                          fontSize: 12,
                          fontWeight: 700,
                          background:
                            video.availability_status === 'abandoned'
                              ? 'rgba(120, 53, 15, 0.10)'
                              : 'rgba(180, 83, 9, 0.10)',
                          color:
                            video.availability_status === 'abandoned'
                              ? '#92400e'
                              : '#b45309',
                        }}
                      >
                        {statusLabel}
                      </span>
                      <span style={{ fontSize: 12, color: '#71717a' }}>
                        {video.channel_name}
                      </span>
                      <span style={{ fontSize: 12, color: '#a1a1aa' }}>•</span>
                      <span style={{ fontSize: 12, color: '#71717a' }}>
                        {video.platform === 'youtube' ? 'YouTube' : 'Bilibili'}
                      </span>
                    </div>

                    <div
                      style={{
                        fontSize: 15,
                        lineHeight: 1.5,
                        fontWeight: 600,
                        color: '#111827',
                      }}
                    >
                      {video.title || video.video_id}
                    </div>

                    <div
                      style={{
                        fontSize: 13,
                        lineHeight: 1.6,
                        color: '#52525b',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {video.availability_reason || t.settings.errors.reasonFallback}
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        gap: 16,
                        flexWrap: 'wrap',
                        fontSize: 12,
                        color: '#71717a',
                      }}
                    >
                      <span>
                        {t.settings.errors.checkedAt}:{' '}
                        {video.availability_checked_at
                          ? timeAgo(video.availability_checked_at)
                          : '--'}
                      </span>
                      <span>
                        {t.settings.errors.publishedAt}:{' '}
                        {video.published_at ? timeAgo(video.published_at) : '--'}
                      </span>
                    </div>

                    <div>
                      <a
                        href={externalUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="premium-button"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          textDecoration: 'none',
                        }}
                      >
                        {t.settings.errors.reopenVideo}
                      </a>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
