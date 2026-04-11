import { createBrowserBridge, sendBrowserCommand } from './browser-runtime';
import {
  BROWSER_BILIBILI_FOLLOWING_WORKSPACE,
} from './browser-bilibili-source';
import {
  BROWSER_YOUTUBE_SUBSCRIPTIONS_WORKSPACE,
} from './browser-youtube-source';
import {
  getAppSetting,
  getAppSettingUpdatedAt,
  setAppSetting,
} from './app-settings';

const BROWSER_KEEPALIVE_PRESET_KEY = 'browser_keepalive_preset';

export type BrowserKeepalivePreset = 'off' | 'balanced' | 'aggressive';

export interface BrowserKeepalivePresetOption {
  value: BrowserKeepalivePreset;
  label: string;
  description: string;
}

export interface BrowserKeepaliveStatus {
  preset: BrowserKeepalivePreset;
  label: string;
  description: string;
  activeGraceMs: number;
  activeGraceLabel: string;
  daemonKeepalive: boolean;
  browserPrewarm: boolean;
  updatedAt: string | null;
  options: BrowserKeepalivePresetOption[];
}

interface BrowserKeepalivePresetConfig {
  label: string;
  description: string;
  activeGraceMs: number;
  daemonKeepalive: boolean;
  browserPrewarm: boolean;
}

const PRESET_CONFIG: Record<BrowserKeepalivePreset, BrowserKeepalivePresetConfig> =
  {
    off: {
      label: '关闭',
      description: '禁用浏览器 keepalive，不做后台保温。',
      activeGraceMs: 0,
      daemonKeepalive: false,
      browserPrewarm: false,
    },
    balanced: {
      label: '平衡',
      description: '保持 daemon 与扩展连接就绪，不主动创建自动化窗口。',
      activeGraceMs: 2 * 60 * 1000,
      daemonKeepalive: true,
      browserPrewarm: false,
    },
    aggressive: {
      label: '激进',
      description: '保持 daemon 就绪，并预热受控浏览器工作区窗口。',
      activeGraceMs: 5 * 60 * 1000,
      daemonKeepalive: true,
      browserPrewarm: true,
    },
  };

const PRESET_OPTIONS: BrowserKeepalivePresetOption[] = [
  {
    value: 'off',
    label: '关闭',
    description: '完全禁用浏览器保温。',
  },
  {
    value: 'balanced',
    label: '平衡',
    description: '默认推荐，只保温 daemon 和扩展连接。',
  },
  {
    value: 'aggressive',
    label: '激进',
    description: '额外预热 YouTube 和 B站的自动化窗口。',
  },
];

export function getBrowserKeepalivePreset(): BrowserKeepalivePreset {
  const raw = getAppSetting(BROWSER_KEEPALIVE_PRESET_KEY);
  if (raw === 'off' || raw === 'balanced' || raw === 'aggressive') {
    return raw;
  }
  return 'balanced';
}

export function setBrowserKeepalivePreset(preset: BrowserKeepalivePreset): void {
  setAppSetting(BROWSER_KEEPALIVE_PRESET_KEY, preset);
}

export function getBrowserKeepaliveStatus(): BrowserKeepaliveStatus {
  const preset = getBrowserKeepalivePreset();
  const config = PRESET_CONFIG[preset];

  return {
    preset,
    label: config.label,
    description: config.description,
    activeGraceMs: config.activeGraceMs,
    activeGraceLabel:
      config.activeGraceMs <= 0
        ? 'disabled'
        : `${Math.round(config.activeGraceMs / 60000)} min`,
    daemonKeepalive: config.daemonKeepalive,
    browserPrewarm: config.browserPrewarm,
    updatedAt: getAppSettingUpdatedAt(BROWSER_KEEPALIVE_PRESET_KEY),
    options: PRESET_OPTIONS,
  };
}

export async function ensureBrowserDaemonReady(): Promise<void> {
  const bridge = await createBrowserBridge();
  try {
    await bridge.connect({ timeout: 10 });
  } finally {
    await bridge.close().catch(() => {});
  }
}

export async function warmBrowserWorkspace(workspace: string): Promise<void> {
  await ensureBrowserDaemonReady();
  await sendBrowserCommand('warmup', { workspace });
}

export async function runBrowserKeepalive(): Promise<{
  preset: BrowserKeepalivePreset;
  warmedWorkspaces: string[];
}> {
  const preset = getBrowserKeepalivePreset();
  if (preset === 'off') {
    return { preset, warmedWorkspaces: [] };
  }

  await ensureBrowserDaemonReady();

  if (preset === 'balanced') {
    return { preset, warmedWorkspaces: [] };
  }

  const workspaces = [
    BROWSER_YOUTUBE_SUBSCRIPTIONS_WORKSPACE,
    BROWSER_BILIBILI_FOLLOWING_WORKSPACE,
  ];

  for (const workspace of workspaces) {
    await sendBrowserCommand('warmup', { workspace });
  }

  return {
    preset,
    warmedWorkspaces: workspaces,
  };
}
