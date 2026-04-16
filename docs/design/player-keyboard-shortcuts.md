# Player Keyboard Shortcuts

桌面 `PlayerModal` 内的可配置快捷键系统，用于直接控制播放器的倍速与跳转。

## 目标

- 在 `PlayerModal` 打开时，应用接管所有播放器键位，iframe 不处理任何快捷键。
- 支持倍速切换（a）、倍速微调（s / d）、跳转（z / x），按键与数值均可配置。
- 复用现有的 `PlayerKeyboardMode` 设置（目前只有开/关），扩展为完整绑定表。

## 范围

- **仅桌面 `PlayerModal`**（不含 `AudioModeOverlay` / `MobileVideoSheet`）。
- 两个平台：YouTube（iframe，postMessage API）+ Bilibili（原生 `<video>`）。
- 不改变移动端现有行为。

## Action 集合

| Action            | 默认键  | 行为                                       |
| ----------------- | ------- | ------------------------------------------ |
| `play-pause`      | `Space` | 播放 / 暂停切换                            |
| `rate-toggle`     | `a`     | 在 1x 与"目标速率"之间切换（见下方语义）   |
| `rate-decrement`  | `s`     | `playbackRate -= step`                     |
| `rate-increment`  | `d`     | `playbackRate += step`                     |
| `seek-backward`   | `z`     | `currentTime -= seekSeconds`               |
| `seek-forward`    | `x`     | `currentTime += seekSeconds`               |

`play-pause` 在原生 `<video>` 路径下直接调用 `video.play()`/`pause()`；在 iframe 兜底路径下根据 `youtubePlayerState` 调 `postYouTubeCommand('playVideo' | 'pauseVideo')`。`e.preventDefault()` 抑制浏览器默认滚动。

**可配置数值**

| 字段                 | 默认值 | 说明                               |
| -------------------- | ------ | ---------------------------------- |
| `rateTogglePreset`   | `2.0`  | 未用过 s/d 时，a 切到的目标倍速    |
| `rateStep`           | `0.1`  | s / d 每次调整的增量               |
| `seekSeconds`        | `10`   | z / x 每次跳转的秒数               |
| `rateMin`            | `0.5`  | 倍速下限                           |
| `rateMax`            | `3.0`  | 倍速上限                           |

## `rate-toggle` 语义

维护一个 `lastManualRate`（初始 `null`）：

- 每次 `rate-decrement` / `rate-increment` 修改后：`lastManualRate = 当前速率`（如果等于 1x 则置 `null`）。
- 按 `rate-toggle`：
  - 当前速率 ≠ 1x → 切到 1x（不改 `lastManualRate`）。
  - 当前速率 = 1x → 切到 `lastManualRate ?? rateTogglePreset`。
- 关闭 PlayerModal 时重置（不跨视频持久化）。

这样用户调到 1.3x 后按 a 可在 1x ↔ 1.3x 来回切；没调过就是 1x ↔ 2x。

## 边界

- 倍速触顶/触底 → 静默停在上下限（`Math.max(rateMin, Math.min(rateMax, next))`）。
- seek 越界 → 不动。具体：
  - `next < 0` → 放弃。
  - `next > duration - 0.25` → 放弃（duration 未知时不判上界）。
- typing context（input/textarea/contentEditable）→ 全部放行，不拦截。
- 修饰键（Ctrl/Meta/Alt）按下时 → 放行，不触发快捷键。

## iframe 接管策略

### 硬边界

YouTube iframe 在 `youtube-nocookie.com` 域，同源策略禁止父页面访问内部 `<video>` 或 document。唯一通道是 postMessage，而 `setPlaybackRate` 硬编码了离散集 `[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]`，0.1 步进会被四舍五入。加载 YT.Player SDK 无用（底层同一播放器）。

**结论：精准倍速必须放弃 iframe，走原生 `<video>`**。

### YouTube 原生 `<video>` 路径（新增）

镜像 Bilibili 现有结构：

| Bilibili（已有）                         | YouTube（新增）                          |
| ---------------------------------------- | ---------------------------------------- |
| `src/lib/bilibili-playback.ts`           | `src/lib/youtube-playback.ts`            |
| `src/app/api/bilibili/playback/route.ts` | `src/app/api/youtube/playback/route.ts`  |
| `src/app/api/bilibili/media/route.ts`    | `src/app/api/youtube/media/route.ts`     |

- **解析**：`yt-dlp -g -f "best[ext=mp4][height<=720]/best" -- <videoId>` 取 progressive mp4 直链。最高 720p（不上 DASH/MSE）。
- **代理**：直链带签名且绑定 IP，不暴露给前端；服务端代理字节流，透传 Range 头。参考 `bilibili-media` 的实现。
- **过期**：typical 6h。`<video>` 的 `error` 事件 / 403 时，记录 `currentTime`，重新调 playback API 拿新 URL，restore 时间点继续播。
- **缓存**：`app_settings` 里存 `{ videoId → { url, proxyUrl, expiresAt } }`，10 分钟 TTL，接近过期时主动刷新。
- **降级**：yt-dlp 解析失败 → 回退到 iframe，并在 UI 提示"精准倍速不可用"。

### 键位接管

对**原生 `<video>` 路径**（YouTube 启用键盘模式 + Bilibili）：
- 焦点 focus modal 根容器（`tabIndex={-1}`），`window` capture 监听 keydown，完全自控。

对**iframe 兜底路径**（YouTube 解析失败 / 用户关闭键盘模式）：
- iframe URL 加 `disablekb=1` 禁用 YouTube 内置键盘。
- 但父页面无法注入精准倍速，退化为离散集就近选择。

### 平台渲染开关

`EmbeddedPlayer` YouTube 分支根据 `useNativeVideo = keyboardSettings.enabled && youtubePlaybackAvailable` 决定：
- `true` → 渲染原生 `<video>`，复用 Bilibili 现有 `bilibiliVideoRef` 的 rate / seek / play 逻辑。抽成平台无关的 `nativeVideoRef` + `nativePlayback` 状态。
- `false` → 现有 iframe 路径，维持向后兼容。

`setBilibiliRate` 的 clamp（0.5–2）改为读设置里的 `rateMin` / `rateMax`，同一函数服务两个平台（更名 `setNativeRate`）。

## 数据模型

扩展 `src/lib/player-keyboard-mode.ts`：

```ts
export type PlayerKeyboardActionId =
  | 'play-pause'
  | 'rate-toggle'
  | 'rate-decrement'
  | 'rate-increment'
  | 'seek-backward'
  | 'seek-forward';

export interface PlayerKeyboardBinding {
  action: PlayerKeyboardActionId;
  key: string; // e.g. 'a', 'ArrowLeft' — matches KeyboardEvent.key (case-insensitive compare)
}

export interface PlayerKeyboardModeSettings {
  enabled: boolean;
  bindings: PlayerKeyboardBinding[];
  rateTogglePreset: number;
  rateStep: number;
  seekSeconds: number;
  rateMin: number;
  rateMax: number;
}
```

**存储**：沿用单个 `app_settings` 行，key = `player_keyboard_mode_enabled` 不变（语义扩展），value 改成 JSON。

读取时做一次性迁移：如果 value 是 `'0'` / `'1'` / `'true'` / `'false'`（旧格式），返回默认 bindings + 解析出的 enabled。保存时总是写 JSON。

**不引入新的 settings key**（避免破坏备份恢复脚本的 key 列表）。

## API 扩展

`src/app/api/settings/player-keyboard-mode/route.ts` 的 POST body 改成接收完整 `PlayerKeyboardModeSettings`（所有字段 optional，用于部分更新 / 逐字段校验）：

- `bindings` 必须覆盖全部 6 个 action，且 key 不能重复（后端校验，重复返回 400）。
- 数值字段校验：`rateStep > 0`，`rateTogglePreset ∈ [rateMin, rateMax]`，`seekSeconds > 0`。

## UI 改动

设置页保持在现有 tab 内（`PerformanceTab.tsx` 已经放了 `PlayerKeyboardMode` 开关 —— 在那里展开为表格）：

```
启用播放器键盘模式  [开关]
  ├─ 快捷键绑定
  │    [Action 列] [Key 捕获输入框]（点击后按任意键录入）
  ├─ 目标倍速        [数字输入]  默认 2.0
  ├─ 倍速步进        [数字输入]  默认 0.1
  ├─ 跳转秒数        [数字输入]  默认 10
  └─ 倍速范围        [min] ~ [max]
```

Key 捕获输入框：focus 后 `onKeyDown` 捕获 `e.key`，显示并存储。拒绝 Escape / Tab / 修饰键单独使用。

## 实现清单

**A. 快捷键系统（core）**
1. `src/lib/player-keyboard-mode.ts` — 扩展数据结构 + JSON 迁移 + 默认值常量。
2. `src/lib/player-keyboard-arbiter.ts` — 引入 `resolvePlayerKeyboardAction` 的新分支：接收 `bindings` 参数，返回带 payload 的 action（如 `{ type: 'rate-step', delta: -0.1 }`）。保留 `close-modal` 分支。纯函数 + 对应单测。
3. `src/app/api/settings/player-keyboard-mode/route.ts` — POST 支持完整 settings；400 校验。
4. `src/components/settings/PerformanceTab.tsx` — 展开 UI；新增 key 捕获控件（小组件放 `settings/` 下）。
5. `src/lib/__tests__/player-keyboard-arbiter.test.ts` — 覆盖分派、typing 跳过、修饰键跳过。

**B. YouTube 原生播放（解锁精准倍速）**
6. `src/lib/youtube-playback.ts` — `resolveYouTubeStream(videoId) → { url, expiresAt }`，调 `YT_DLP_BIN` 子进程，stdin/stdout 流式。缓存（`app_settings` 内 JSON map，10 分钟 TTL）。
7. `src/app/api/youtube/playback/route.ts` — `GET ?videoId=` 返回 `{ proxyUrl, expiresAt }`，不返回原始 URL。
8. `src/app/api/youtube/media/route.ts` — Range-aware 字节代理，token 里编码 videoId，服务端查缓存拿直链。参考 `bilibili/media`。
9. `EmbeddedPlayer.tsx` 重构：
   - 抽 `nativeVideoRef` + `nativePlayback` 状态（平台中立）。
   - YouTube 分支新增 `useNativeVideo` 条件，为真时走原生 `<video>`，为假时保留现有 iframe 路径。
   - `setBilibiliRate` 改名 `setNativeRate`，clamp 改用 settings 的 min/max。
   - URL 过期 / 403 → 重新 fetch playback API，记录 `currentTime` 后 restore。
10. `PlayerModal.tsx`：
    - 挂载时 `GET /api/settings/player-keyboard-mode`，缓存到 ref。
    - `handleKeyDown` 分派新 action，调用 `setNativeRate` / `seekNative`。
    - 维护 `lastManualRateRef`（跨快捷键但不跨视频）。
    - `useNativeVideo = keyboardSettings.enabled && youtubePlaybackAvailable`。
    - `getEmbedUrl` 加 `disablekb=1`；`focusPlayer` 在原生路径下聚焦父容器。

**C. 兜底**
11. yt-dlp 解析失败 → 降级 iframe + UI 轻提示（例："精准倍速不可用，使用 YouTube 内置倍速"）。

## 非目标

- 不做全局快捷键（仅 Modal 作用域）。
- 不做多键组合（shift+a 等）—— 单键即可满足需求，避免 UI 复杂度。
- 不做跨视频的速率记忆（关闭 Modal 即重置）。
- 不动移动端（`AudioModeOverlay` 无键盘场景）。

## 开放项

- YouTube 走 yt-dlp + 原生 `<video>` 后，最高 720p（progressive mp4）。1080p+ 需要 DASH + MSE（dash.js / MediaSource），复杂度大增，本次不做。
- YouTube live 直播 yt-dlp 能解析但 seek 行为不同，暂不支持原生路径，live 视频自动走 iframe 兜底。
- Bilibili `<video>.playbackRate` 无离散限制，完全尊重 min/max。
- 如果将来要支持 `AudioModeOverlay`，复用同一份 settings + arbiter 即可。
