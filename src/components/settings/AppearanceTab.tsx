'use client';

import { useEffect, useState } from 'react';
import { useTheme } from '@/contexts/ThemeContext';
import type {
  HomeIntentShortcutSettings,
  PlayerKeyboardModeSettings,
  ShowToast,
} from './shared';

interface AppearanceTabProps {
  showToast: ShowToast;
}

export default function AppearanceTab({ showToast }: AppearanceTabProps) {
  const { mode, setMode } = useTheme();
  const [playerKeyboardModeEnabled, setPlayerKeyboardModeEnabled] =
    useState(true);
  const [homeIntentShortcutsEnabled, setHomeIntentShortcutsEnabled] =
    useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [playerRes, homeRes] = await Promise.all([
          fetch('/api/settings/player-keyboard-mode', { cache: 'no-store' }),
          fetch('/api/settings/home-intent-shortcuts', { cache: 'no-store' }),
        ]);
        if (playerRes.ok) {
          const playerData =
            (await playerRes.json()) as PlayerKeyboardModeSettings;
          setPlayerKeyboardModeEnabled(playerData.enabled !== false);
        }
        if (homeRes.ok) {
          const homeData = (await homeRes.json()) as HomeIntentShortcutSettings;
          setHomeIntentShortcutsEnabled(homeData.enabled !== false);
        }
      } catch {
        showToast('无法读取外观设置', 'error');
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [showToast]);

  const togglePlayerKeyboardMode = async () => {
    const nextEnabled = !playerKeyboardModeEnabled;
    setSaving(true);
    try {
      const res = await fetch('/api/settings/player-keyboard-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      if (!res.ok) {
        showToast('切换播放器键盘模式失败', 'error');
        return;
      }
      const data = (await res.json()) as PlayerKeyboardModeSettings;
      setPlayerKeyboardModeEnabled(data.enabled !== false);
      showToast(nextEnabled ? '播放器键盘优先已开启' : '播放器键盘优先已关闭');
    } catch {
      showToast('切换播放器键盘模式失败，请稍后重试', 'error');
    } finally {
      setSaving(false);
    }
  };

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
        showToast('切换首页 intent 快捷键失败', 'error');
        return;
      }
      const data = (await res.json()) as HomeIntentShortcutSettings;
      setHomeIntentShortcutsEnabled(data.enabled !== false);
      showToast(
        nextEnabled ? '首页 intent 快捷键已开启' : '首页 intent 快捷键已关闭',
      );
    } catch {
      showToast('切换首页 intent 快捷键失败，请稍后重试', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-section-wrapper animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="settings-group">
        <h2 className="settings-group-title">播放器键盘行为</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">默认焦点落在播放器</span>
              <span className="setting-description">
                播放器打开后直接聚焦到真实播放器本身，`Space`
                等按键由播放器原生处理。
              </span>
            </div>
            <div className="setting-control-wrapper">
              <label className="premium-toggle">
                <input
                  type="checkbox"
                  checked={playerKeyboardModeEnabled}
                  onChange={togglePlayerKeyboardMode}
                  disabled={loading || saving}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>
          </div>

          <div className="setting-row" style={{ alignItems: 'flex-start' }}>
            <div className="setting-info" style={{ flex: 1 }}>
              <span className="setting-label">当前约定</span>
              <div style={{ marginTop: 10 }}>
                <table
                  style={{
                    fontSize: 13,
                    borderCollapse: 'collapse',
                    width: '100%',
                    maxWidth: 420,
                  }}
                >
                  <tbody>
                    {[
                      { key: 'Space', desc: '由播放器原生处理播放 / 暂停' },
                      { key: 'Esc', desc: '由页面关闭播放器弹层' },
                      {
                        key: 'Tab / ` / ·',
                        desc: '不再用于切换播放器内部焦点',
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
        </div>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title">首页快捷键</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">首页 intent 快捷键</span>
              <span className="setting-description">
                在首页视频流中按 Tab 切换到下一个 intent，按 ` / ·
                切换到上一个 intent。输入框聚焦时自动失效。
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
                <span className="setting-label">快捷键说明</span>
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
                        { key: 'Tab', desc: '切换到下一个 intent' },
                        { key: '` / ·', desc: '切换到上一个 intent' },
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
        <h2 className="settings-group-title">主题</h2>
        <div className="settings-card-group">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">颜色模式</span>
              <span className="setting-description">
                跟随系统时自动匹配操作系统的浅色 / 暗色设置。
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
                    borderColor: mode === m ? 'var(--accent-purple)' : 'var(--border)',
                    background: mode === m ? 'rgba(139,92,246,0.12)' : 'transparent',
                    color: mode === m ? 'var(--accent-purple)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                >
                  {m === 'system' ? '💻 跟随系统' : m === 'light' ? '☀️ 浅色' : '🌙 暗色'}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
