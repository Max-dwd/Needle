'use client';

import { useEffect, useState } from 'react';
import { useTheme } from '@/contexts/ThemeContext';
import { useLanguage, useT } from '@/contexts/LanguageContext';
import PlayerKeyboardSettingsPanel from './PlayerKeyboardSettingsPanel';
import type { HomeIntentShortcutSettings, ShowToast } from './shared';

interface AppearanceTabProps {
  showToast: ShowToast;
}

export default function AppearanceTab({ showToast }: AppearanceTabProps) {
  const { mode, setMode } = useTheme();
  const { language, setLanguage } = useLanguage();
  const t = useT();
  const [homeIntentShortcutsEnabled, setHomeIntentShortcutsEnabled] =
    useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [homeRes] = await Promise.all([
          fetch('/api/settings/home-intent-shortcuts', { cache: 'no-store' }),
        ]);
        if (homeRes.ok) {
          const homeData = (await homeRes.json()) as HomeIntentShortcutSettings;
          setHomeIntentShortcutsEnabled(homeData.enabled !== false);
        }
      } catch {
        showToast(t.settings.appearance.toastReadFailed, 'error');
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [showToast, t.settings.appearance.toastReadFailed]);

  const toggleHomeIntentShortcuts = async () => {
    const nextEnabled = !homeIntentShortcutsEnabled;
    setSaving(true);
    try {
      const res = await fetch('/api/settings/home-intent-shortcuts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      if (!res.ok) {
        showToast(t.settings.appearance.toastSwitchHomeFailed, 'error');
        return;
      }
      const data = (await res.json()) as HomeIntentShortcutSettings;
      setHomeIntentShortcutsEnabled(data.enabled !== false);
      showToast(
        nextEnabled
          ? t.settings.appearance.toastHomeOn
          : t.settings.appearance.toastHomeOff,
      );
    } catch {
      showToast(t.settings.appearance.toastSwitchHomeError, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-section-wrapper animate-in fade-in slide-in-from-bottom-4 duration-300">
      <PlayerKeyboardSettingsPanel showToast={showToast} />

      <div className="settings-group">
        <h2 className="settings-group-title">
          {t.settings.appearance.homeIntentShortcutsSection}
        </h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">
                {t.settings.appearance.homeIntentShortcutsLabel}
              </span>
              <span className="setting-description">
                {t.settings.appearance.homeIntentShortcutsDesc}
              </span>
            </div>
            <div className="setting-control-wrapper">
              <label className="premium-toggle">
                <input
                  type="checkbox"
                  checked={homeIntentShortcutsEnabled}
                  onChange={toggleHomeIntentShortcuts}
                  disabled={loading || saving}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>
          </div>

          {homeIntentShortcutsEnabled && (
            <div className="setting-row" style={{ alignItems: 'flex-start' }}>
              <div className="setting-info" style={{ flex: 1 }}>
                <span className="setting-label">
                  {t.settings.appearance.shortcutInstruction}
                </span>
                <div style={{ marginTop: 10 }}>
                  <table
                    style={{
                      fontSize: 13,
                      borderCollapse: 'collapse',
                      width: '100%',
                      maxWidth: 400,
                    }}
                  >
                    <tbody>
                      {[
                        { key: 'Tab', desc: t.settings.appearance.shortcutTab },
                        {
                          key: '` / ·',
                          desc: t.settings.appearance.shortcutBacktick,
                        },
                      ].map(({ key, desc }) => (
                        <tr key={key}>
                          <td
                            style={{
                              paddingRight: 16,
                              paddingBottom: 8,
                              whiteSpace: 'nowrap',
                              verticalAlign: 'top',
                            }}
                          >
                            <kbd
                              style={{
                                display: 'inline-block',
                                padding: '2px 8px',
                                background: '#f4f4f5',
                                border: '1px solid #d4d4d8',
                                borderRadius: 4,
                                fontSize: 12,
                                fontFamily: 'monospace',
                                color: '#18181b',
                              }}
                            >
                              {key}
                            </kbd>
                          </td>
                          <td
                            style={{
                              paddingBottom: 8,
                              color: '#52525b',
                              lineHeight: 1.5,
                            }}
                          >
                            {desc}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title">
          {t.settings.appearance.themeSection}
        </h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">
                {t.settings.appearance.themeLabel}
              </span>
              <span className="setting-description">
                {t.settings.appearance.themeDesc}
              </span>
            </div>
            <div className="setting-control-wrapper">
              {(['system', 'light', 'dark'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 8,
                    fontSize: 13,
                    fontWeight: 500,
                    border: '1px solid',
                    borderColor:
                      mode === m ? 'var(--accent-purple)' : 'var(--border)',
                    background:
                      mode === m ? 'rgba(139,92,246,0.12)' : 'transparent',
                    color:
                      mode === m
                        ? 'var(--accent-purple)'
                        : 'var(--text-secondary)',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                >
                  {m === 'system'
                    ? t.theme.system
                    : m === 'light'
                      ? t.theme.light
                      : t.theme.dark}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title">
          {t.settings.appearance.languageSection}
        </h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{t.language.label}</span>
              <span className="setting-description">
                {t.settings.appearance.languageDesc}
              </span>
            </div>
            <div className="setting-control-wrapper">
              {(['zh', 'en'] as const).map((lang) => (
                <button
                  key={lang}
                  onClick={() => setLanguage(lang)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 8,
                    fontSize: 13,
                    fontWeight: 500,
                    border: '1px solid',
                    borderColor:
                      language === lang
                        ? 'var(--accent-purple)'
                        : 'var(--border)',
                    background:
                      language === lang
                        ? 'rgba(139,92,246,0.12)'
                        : 'transparent',
                    color:
                      language === lang
                        ? 'var(--accent-purple)'
                        : 'var(--text-secondary)',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                >
                  {lang === 'zh' ? t.language.zh : t.language.en}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
