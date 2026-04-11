import re

with open('/Users/h/ai/needle/needle/src/components/settings/AppearanceTab.tsx', 'r') as f:
    code = f.read()

code = code.replace("import { useTheme } from '@/contexts/ThemeContext';", "import { useTheme } from '@/contexts/ThemeContext';\nimport { useLanguage, useT } from '@/contexts/LanguageContext';")
code = code.replace("const { mode, setMode } = useTheme();", "const { mode, setMode } = useTheme();\n  const { language, setLanguage } = useLanguage();\n  const t = useT();")

code = code.replace("'无法读取外观设置'", "t.settings.appearance.toastReadFailed")
code = code.replace("'切换播放器键盘模式失败'", "t.settings.appearance.toastSwitchPlayerFailed")
code = code.replace("nextEnabled ? '播放器键盘优先已开启' : '播放器键盘优先已关闭'", "nextEnabled ? t.settings.appearance.toastPlayerOn : t.settings.appearance.toastPlayerOff")
code = code.replace("'切换播放器键盘模式失败，请稍后重试'", "t.settings.appearance.toastSwitchPlayerError")
code = code.replace("'切换首页 intent 快捷键失败'", "t.settings.appearance.toastSwitchHomeFailed")
code = code.replace("nextEnabled ? '首页 intent 快捷键已开启' : '首页 intent 快捷键已关闭'", "nextEnabled ? t.settings.appearance.toastHomeOn : t.settings.appearance.toastHomeOff")
code = code.replace("'切换首页 intent 快捷键失败，请稍后重试'", "t.settings.appearance.toastSwitchHomeError")

code = code.replace(">播放器键盘行为<", ">{t.settings.appearance.playerKeyboardBehavior}<")
code = code.replace(">默认焦点落在播放器<", ">{t.settings.appearance.defaultFocusPlayer}<")

desc1 = """                播放器打开后直接聚焦到真实播放器本身，`Space`
                等按键由播放器原生处理。"""
code = code.replace(desc1, "                {t.settings.appearance.defaultFocusPlayerDesc}")

code = code.replace(">当前约定<", ">{t.settings.appearance.currentConvention}<")
code = code.replace("'由播放器原生处理播放 / 暂停'", "t.settings.appearance.conventionSpace")
code = code.replace("'由页面关闭播放器弹层'", "t.settings.appearance.conventionEsc")
code = code.replace("'不再用于切换播放器内部焦点'", "t.settings.appearance.conventionTab")

code = code.replace(">首页快捷键<", ">{t.settings.appearance.homeIntentShortcutsSection}<")
code = code.replace(">首页 intent 快捷键<", ">{t.settings.appearance.homeIntentShortcutsLabel}<")
desc2 = """                在首页视频流中按 Tab 切换到下一个 intent，按 ` / ·
                切换到上一个 intent。输入框聚焦时自动失效。"""
code = code.replace(desc2, "                {t.settings.appearance.homeIntentShortcutsDesc}")

code = code.replace(">快捷键说明<", ">{t.settings.appearance.shortcutInstruction}<")
code = code.replace("'切换到下一个 intent'", "t.settings.appearance.shortcutTab")
code = code.replace("'切换到上一个 intent'", "t.settings.appearance.shortcutBacktick")

code = code.replace(">主题<", ">{t.settings.appearance.themeSection}<")
code = code.replace(">颜色模式<", ">{t.settings.appearance.themeLabel}<")
desc3 = """                跟随系统时自动匹配操作系统的浅色 / 暗色设置。"""
code = code.replace(desc3, "                {t.settings.appearance.themeDesc}")

code = code.replace("m === 'system' ? '💻 跟随系统' : m === 'light' ? '☀️ 浅色' : '🌙 暗色'", "m === 'system' ? t.theme.system : m === 'light' ? t.theme.light : t.theme.dark")

language_section = """
      <div className="settings-group">
        <h2 className="settings-group-title">{t.settings.appearance.languageSection}</h2>
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
                    borderColor: language === lang ? 'var(--accent-purple)' : 'var(--border)',
                    background: language === lang ? 'rgba(139,92,246,0.12)' : 'transparent',
                    color: language === lang ? 'var(--accent-purple)' : 'var(--text-secondary)',
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
"""
code = code.replace("    </div>\n  );\n}", language_section + "  );\n}")

with open('/Users/h/ai/needle/needle/src/components/settings/AppearanceTab.tsx', 'w') as f:
    f.write(code)

