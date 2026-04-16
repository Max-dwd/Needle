'use client';

import { useEffect, useMemo, useState } from 'react';
import { useT } from '@/contexts/LanguageContext';
import {
  DEFAULT_PLAYER_KEYBOARD_BINDINGS,
  PLAYER_KEYBOARD_ACTION_IDS,
  normalizeKeyboardKey,
} from '@/lib/player-keyboard-arbiter';
import type {
  PlayerKeyboardActionId,
  PlayerKeyboardBinding,
  PlayerKeyboardModeSettings,
  ShowToast,
} from './shared';

interface PlayerKeyboardSettingsPanelProps {
  showToast: ShowToast;
}

const DEFAULT_SETTINGS: PlayerKeyboardModeSettings = {
  enabled: true,
  bindings: DEFAULT_PLAYER_KEYBOARD_BINDINGS,
  rateTogglePreset: 2,
  rateStep: 0.1,
  seekSeconds: 10,
  rateMin: 0.5,
  rateMax: 3,
};

const BLOCKED_CAPTURE_KEYS = new Set([
  'Escape',
  'Tab',
  'Control',
  'Alt',
  'Meta',
  'Shift',
]);

function formatKey(key: string): string {
  if (key === ' ') return 'Space';
  return key.length === 1 ? key.toUpperCase() : key;
}

function mergeSettings(
  settings: Partial<PlayerKeyboardModeSettings>,
): PlayerKeyboardModeSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    bindings: settings.bindings?.length
      ? settings.bindings.map((binding) => ({ ...binding }))
      : DEFAULT_SETTINGS.bindings.map((binding) => ({ ...binding })),
  };
}

function replaceBindingKey(
  bindings: PlayerKeyboardBinding[],
  action: PlayerKeyboardActionId,
  key: string,
): PlayerKeyboardBinding[] {
  return PLAYER_KEYBOARD_ACTION_IDS.map((actionId) => {
    const existing =
      bindings.find((binding) => binding.action === actionId) ??
      DEFAULT_PLAYER_KEYBOARD_BINDINGS.find(
        (binding) => binding.action === actionId,
      )!;
    return {
      ...existing,
      key: actionId === action ? key : existing.key,
    };
  });
}

export default function PlayerKeyboardSettingsPanel({
  showToast,
}: PlayerKeyboardSettingsPanelProps) {
  const t = useT();
  const [draft, setDraft] = useState<PlayerKeyboardModeSettings>(() =>
    mergeSettings(DEFAULT_SETTINGS),
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      try {
        const res = await fetch('/api/settings/player-keyboard-mode', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('READ_FAILED');
        const data = (await res.json()) as PlayerKeyboardModeSettings;
        if (!controller.signal.aborted) {
          setDraft(mergeSettings(data));
        }
      } catch {
        if (!controller.signal.aborted) {
          showToast(t.settings.appearance.toastReadFailed, 'error');
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => controller.abort();
  }, [showToast, t.settings.appearance.toastReadFailed]);

  const duplicateKeys = useMemo(() => {
    const counts = new Map<string, number>();
    for (const binding of draft.bindings) {
      const normalized = normalizeKeyboardKey(binding.key);
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
    return new Set(
      Array.from(counts.entries())
        .filter(([, count]) => count > 1)
        .map(([key]) => key),
    );
  }, [draft.bindings]);

  const save = async (nextDraft = draft) => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings/player-keyboard-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextDraft),
      });
      const data = (await res.json()) as PlayerKeyboardModeSettings & {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || 'SAVE_FAILED');
      }
      setDraft(mergeSettings(data));
      showToast(t.settings.appearance.toastPlayerKeyboardSaved);
    } catch (error) {
      const message =
        error instanceof Error && error.message !== 'SAVE_FAILED'
          ? error.message
          : t.settings.appearance.toastPlayerKeyboardSaveFailed;
      showToast(message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = () => {
    const nextDraft = { ...draft, enabled: !draft.enabled };
    setDraft(nextDraft);
    void save(nextDraft);
  };

  const actionLabels: Record<PlayerKeyboardActionId, string> = {
    'play-pause': t.settings.appearance.actionPlayPause,
    'rate-toggle': t.settings.appearance.actionRateToggle,
    'rate-decrement': t.settings.appearance.actionRateDecrement,
    'rate-increment': t.settings.appearance.actionRateIncrement,
    'seek-backward': t.settings.appearance.actionSeekBackward,
    'seek-forward': t.settings.appearance.actionSeekForward,
  };

  return (
    <div className="settings-group">
      <h2 className="settings-group-title">
        {t.settings.appearance.playerKeyboardBehavior}
      </h2>
      <div className="settings-card-group">
        <div className="setting-row">
          <div className="setting-info">
            <span className="setting-label">
              {t.settings.appearance.enablePlayerKeyboard}
            </span>
            <span className="setting-description">
              {t.settings.appearance.enablePlayerKeyboardDesc}
            </span>
          </div>
          <div className="setting-control-wrapper">
            <label className="premium-toggle">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={toggleEnabled}
                disabled={loading || saving}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>
        </div>

        {draft.enabled && (
          <>
            <div className="setting-row" style={{ alignItems: 'flex-start' }}>
              <div className="setting-info" style={{ flex: 1 }}>
                <span className="setting-label">
                  {t.settings.appearance.shortcutBindings}
                </span>
                <div style={{ marginTop: 12, overflowX: 'auto' }}>
                  <table
                    style={{
                      width: '100%',
                      maxWidth: 560,
                      borderCollapse: 'collapse',
                      fontSize: 13,
                    }}
                  >
                    <tbody>
                      {PLAYER_KEYBOARD_ACTION_IDS.map((action) => {
                        const binding =
                          draft.bindings.find(
                            (item) => item.action === action,
                          ) ??
                          DEFAULT_PLAYER_KEYBOARD_BINDINGS.find(
                            (item) => item.action === action,
                          )!;
                        const isDuplicate = duplicateKeys.has(
                          normalizeKeyboardKey(binding.key),
                        );

                        return (
                          <tr key={action}>
                            <td
                              style={{
                                width: 220,
                                padding: '0 16px 10px 0',
                                color: 'var(--text-primary)',
                                fontWeight: 500,
                              }}
                            >
                              {actionLabels[action]}
                            </td>
                            <td style={{ paddingBottom: 10 }}>
                              <input
                                className="premium-input"
                                value={formatKey(binding.key)}
                                readOnly
                                disabled={loading || saving}
                                aria-label={actionLabels[action]}
                                onKeyDown={(event) => {
                                  if (event.key === 'Tab') return;
                                  event.preventDefault();
                                  event.stopPropagation();
                                  if (event.key === 'Escape') {
                                    event.currentTarget.blur();
                                    return;
                                  }
                                  if (BLOCKED_CAPTURE_KEYS.has(event.key)) {
                                    return;
                                  }
                                  setDraft((current) => ({
                                    ...current,
                                    bindings: replaceBindingKey(
                                      current.bindings,
                                      action,
                                      event.key,
                                    ),
                                  }));
                                  event.currentTarget.blur();
                                }}
                                style={{
                                  maxWidth: 160,
                                  fontFamily: 'monospace',
                                  textAlign: 'center',
                                  borderColor: isDuplicate
                                    ? 'var(--destructive)'
                                    : undefined,
                                }}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {duplicateKeys.size > 0 && (
                  <span
                    className="setting-description"
                    style={{ color: 'var(--destructive)' }}
                  >
                    {t.settings.appearance.duplicateKeyWarning}
                  </span>
                )}
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <span className="setting-label">
                  {t.settings.appearance.rateTogglePreset}
                </span>
                <span className="setting-description">
                  {t.settings.appearance.rateTogglePresetDesc}
                </span>
              </div>
              <div className="setting-control-wrapper">
                <input
                  className="premium-input"
                  type="number"
                  min={draft.rateMin}
                  max={draft.rateMax}
                  step="0.1"
                  value={draft.rateTogglePreset}
                  disabled={loading || saving}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      rateTogglePreset: Number(event.target.value),
                    }))
                  }
                  style={{ width: 110 }}
                />
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <span className="setting-label">
                  {t.settings.appearance.rateStep}
                </span>
                <span className="setting-description">
                  {t.settings.appearance.rateStepDesc}
                </span>
              </div>
              <div className="setting-control-wrapper">
                <input
                  className="premium-input"
                  type="number"
                  min="0.01"
                  step="0.05"
                  value={draft.rateStep}
                  disabled={loading || saving}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      rateStep: Number(event.target.value),
                    }))
                  }
                  style={{ width: 110 }}
                />
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <span className="setting-label">
                  {t.settings.appearance.seekSeconds}
                </span>
                <span className="setting-description">
                  {t.settings.appearance.seekSecondsDesc}
                </span>
              </div>
              <div className="setting-control-wrapper">
                <input
                  className="premium-input"
                  type="number"
                  min="1"
                  step="1"
                  value={draft.seekSeconds}
                  disabled={loading || saving}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      seekSeconds: Number(event.target.value),
                    }))
                  }
                  style={{ width: 110 }}
                />
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-info">
                <span className="setting-label">
                  {t.settings.appearance.rateRange}
                </span>
                <span className="setting-description">
                  {t.settings.appearance.rateRangeDesc}
                </span>
              </div>
              <div className="setting-control-wrapper">
                <input
                  className="premium-input"
                  type="number"
                  min="0.05"
                  step="0.1"
                  value={draft.rateMin}
                  disabled={loading || saving}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      rateMin: Number(event.target.value),
                    }))
                  }
                  style={{ width: 90 }}
                />
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  ~
                </span>
                <input
                  className="premium-input"
                  type="number"
                  min={draft.rateMin}
                  step="0.1"
                  value={draft.rateMax}
                  disabled={loading || saving}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      rateMax: Number(event.target.value),
                    }))
                  }
                  style={{ width: 90 }}
                />
              </div>
            </div>
          </>
        )}

        <div
          className="setting-row"
          style={{ justifyContent: 'flex-end', background: '#fafafa' }}
        >
          <button
            className="premium-button"
            type="button"
            onClick={() => setDraft(mergeSettings(DEFAULT_SETTINGS))}
            disabled={loading || saving}
          >
            {t.settings.appearance.resetDefaults}
          </button>
          <button
            className="premium-button primary"
            type="button"
            onClick={() => void save()}
            disabled={loading || saving}
          >
            {saving
              ? t.settings.appearance.saving
              : t.settings.appearance.savePlayerKeyboard}
          </button>
        </div>
      </div>
    </div>
  );
}
