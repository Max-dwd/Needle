# Player Bottom Bar

桌面 `PlayerModal` 的统一底部控制条，替换现有仅 B 站可见的控制栏，把 YouTube 与 Bilibili 两个平台的基础播放控件与"章节分段进度条"收敛到一个组件里。

## 目标

- 在播放器区域底部给两个平台都加上同一个控制条，视觉一致。
- 显示当前倍速（纯展示，不是按钮）、播放/暂停按钮、时间戳标签。
- 进度条按摘要里的章节时间戳分块，点击跳转。
- 鼠标 hover 某一段：显示该段标题。
- 按住 `Shift` 再 hover：显示标题 + 正文内容。

## 非目标

- 不改 header、左侧 `VideoInfoPanel`、整体配色与阴影（用户已明确不动）。
- 不新增倍速调节按钮；倍速仍然仅通过键盘快捷键修改（见 `player-keyboard-shortcuts.md`）。
- 不影响 `AudioModeOverlay` 与 `MobileVideoSheet`（它们各自有独立 UI，底部条仅在桌面播放器可见）。
- 不负责摘要生成 / 触发，只消费已存在的摘要 markdown。

## 依赖与前置约定

- **章节时间戳来源**：摘要 markdown 的 `##` / `###` / `####` section 下只要出现至少一个指向本视频的时间链接（YouTube `?t=` 或 Bilibili `?t=`），就把该 section 作为一个章节；章节起始时间取 section 内第一个可由 `parseSeekSeconds` 解析出的时间戳。标题本身可以不带时间戳。
- **没有章节时**：进度条退化为一整段，仍支持点击跳转，hover 不出 tooltip。
- **摘要尚未生成时**：底部条仍渲染（播放按钮 + 时间 + 倍速 + 无分段的进度条），只是没有章节信息。
- **键盘焦点**：键盘快捷键继续由 `player-keyboard-arbiter` 统一管理；底部条的按钮使用鼠标点击，不抢焦点（`onMouseDown` 里 `e.preventDefault()` 避免焦点从 `modalContentRef` 漂走）。

## 数据流

```
PlayerModal
  ├─ fetch /api/videos/:id/summary   → summaryMarkdown
  ├─ extractSummaryChapters(md, video) → chapters: SummaryChapter[]
  ├─ 已有 state：playerStartSeconds / playerDuration / isPlayerPlaying /
  │              nativePlaybackRate / youtubeIframePlaybackRate
  └─ <PlayerBottomBar
       isPlaying
       onTogglePlay                     ← 复用现有 toggleNativePlayback / postYouTubeCommand 分支
       currentSeconds={playerStartSeconds}
       duration={playerDuration}
       playbackRate={usesNativeVideo ? nativePlaybackRate : youtubeIframePlaybackRate}
       chapters
       onSeek={handleTimestampClick}    ← 已有，处理 native + iframe 两条路径
       trailing={bilibiliStatusNode}    ← 可选，B 站质量/错误/重试挤在右侧
    />
```

## 新增 / 修改文件

### `src/lib/summary-chapters.ts`（新）

```ts
export interface SummaryChapter {
  seconds: number;   // 起始时间（来自 section 内第一个可解析时间戳链接）
  title: string;     // 去掉 Markdown 装饰后的纯文本标题
  body: string;      // 到下一个同级/更高级标题之前的正文（原文，可能含行内 markdown）
}

export function extractSummaryChapters(
  markdown: string | null | undefined,
  video: { platform: 'youtube' | 'bilibili'; video_id: string },
): SummaryChapter[]
```

规则：

1. 先剥离 YAML frontmatter（`---\n...\n---\n`）。
2. 扫描所有 `^(#{1,4})\s+(.+)$` 行，把每个标题到下一个同级或更高级标题之前的内容视为一个 section。子标题仍属于自己的 section；父 section 的 `body` 到子标题前结束。
3. 对 section 标题和正文里的 `[label](href)` 逐个试 `parseSeekSeconds`，按文档出现顺序取第一个命中的时间作为 `seconds`。这样“标题无时间戳、正文有时间戳”的现有摘要也能生成章节。
4. `title` = 标题文本去掉行内 Markdown 链接、粗体等轻量装饰后的纯文本；前后残留的分隔符（`·•-—|`）修掉。若标题里的链接就是章节时间戳，也从显示文本中抠掉。
5. `body` = 本 section 标题下、直到下一个同级/更高级标题之前的所有正文行（`join('\n')` 后 `trim`）。如果 section 下出现更深一级子标题，父 section 的 `body` 不吞掉子标题及其正文。
6. 结果按 `seconds` 升序排序；过滤掉负数或 `NaN`。如果多个 section 的第一个时间戳相同，保留文档中更早出现的 section。
7. 不解析 `>` 引用、嵌套列表的结构语义；只按文本顺序找 Markdown 链接。`body` 直接是原文，由消费方按需 truncate。

单测放在 `src/lib/summary-chapters.test.ts`，覆盖：
- frontmatter 剥离
- 标题无时间戳、section 正文有时间戳 → 使用正文第一个时间戳作为章节起点
- section 标题里有时间戳 → 仍可解析，且优先于该 section 正文里的时间戳
- section 内多个时间戳 → 取文档顺序第一个可解析时间戳
- 多个 section + 按 `seconds` 排序
- 父 section 遇到子标题时 body 截断；子标题若有自己的时间戳则生成独立章节
- 平台错配（Bilibili 摘要里有 YouTube 链接）→ 忽略
- section 无任何可解析时间戳 → 不生成章节

### `src/components/player/PlayerBottomBar.tsx`（新）

纯展示组件，无外部数据获取。

Props：

```ts
interface PlayerBottomBarProps {
  isPlaying: boolean;
  onTogglePlay: () => void;
  currentSeconds: number;
  duration: number;            // 0 表示未知
  playbackRate: number;
  chapters: SummaryChapter[];
  onSeek: (seconds: number) => void;
  disabled?: boolean;          // 播放源尚未就绪时置灰
  trailing?: React.ReactNode;  // B 站画质/错误/重试按钮插槽
}
```

布局（从左到右）：

```
[▶/⏸]  12:34 / 45:67   1.5×   [——章节分段进度条———]   {trailing?}
```

- 高度 ~48px，`padding: 10px 16px`，`border-top: 1px solid var(--border)`，背景 `var(--bg-secondary)`。
- 播放按钮：32×32 圆形，`var(--bg-hover)` 底色，hover 提亮。`disabled` 时 `cursor: not-allowed` + 半透明。
- 时间标签：`formatSecondsLabel(currentSeconds) / formatSecondsLabel(duration)`，字号 12，等宽数字（`font-variant-numeric: tabular-nums`）。
- 倍速标签：`{rate.toFixed(rate % 1 === 0 ? 0 : 2)}×`；`1.0×` 时用弱色（`--text-muted`），非 1× 用强调色（`--accent-purple`）。
- 进度条见下。
- `trailing` 放在最右，`margin-left: auto`。

### 章节分段进度条

**无章节 / `duration <= 0`**：

- 渲染一条 `height: 6px, border-radius: 3px` 的轨道（`var(--bg-hover)`）。
- 已播放部分绝对定位覆盖层，宽度 = `currentSeconds / duration * 100%`。
- `onClick`：计算点击位置 ratio，`onSeek(ratio * duration)`；`duration = 0` 时不响应。
- 不出 tooltip。

**有章节**：

- 轨道容器 `position: relative`，flex 渲染 `N` 个段（`N = chapters.length`），段之间留 2px gap。
- 每段宽度比例 = `(nextSeconds - thisSeconds) / duration`；末段到 `duration`。
- 每段自身是 `var(--bg-hover)` 底色。
- 整体"已播放"覆盖层仍然是一个绝对定位的长条（不按段分裂），颜色 `var(--accent-purple)`、`opacity: 0.75`、`border-radius: 3px`、`pointer-events: none`、`mix-blend-mode: normal`，宽度 = `currentSeconds / duration * 100%`。这样"分段视觉"由底层轨道的 gap 呈现，"进度视觉"由上层覆盖层连续推进，两者独立。
- 段级 `onMouseEnter / onMouseLeave` 记录 `hoveredChapterIndex`；`onClick` 调 `onSeek(chapter.seconds)`（跳到该段起点，而不是鼠标像素位置——点击精确跳章节，符合"章节导航"语义）。
- 轨道空白处（gap 之间）不可点击，交给段承接。

**Tooltip**（`hoveredChapterIndex !== null` 时渲染）：

- 绝对定位，`bottom: 100% + 8px`，`left` 跟随鼠标 clientX 相对于轨道容器的偏移，加 `transform: translateX(-50%)`；左右两端用 `clamp(8px, X, containerWidth - 8px - tooltipWidth)` 防溢出。
- 容器：`max-width: 320px`，背景 `var(--bg-primary)`，边框 `1px solid var(--border)`，`border-radius: 8px`，`padding: 10px 12px`，`box-shadow: 0 4px 12px rgba(0,0,0,0.24)`，`pointer-events: none`，`z-index: 20`。
- 默认内容：
  - 第一行：`formatSecondsLabel(chapter.seconds)`（`--text-muted`，字号 11）。
  - 第二行：`chapter.title`（`--text-primary`，字号 13，`font-weight: 600`，最多 2 行省略）。
- 按住 Shift 时扩展：
  - 追加第三行：`chapter.body`，字号 12，`--text-secondary`，`white-space: pre-wrap`，最多 8 行省略（`-webkit-line-clamp: 8`）；`body` 为空时不渲染这一行。
  - tooltip `max-width` 扩到 420px；宽度变化用 `transition: max-width 120ms`。

**Shift 监听**：

- 组件内部维护 `isShiftHeld` state。
- 在 `hoveredChapterIndex !== null` 的 effect 里绑定 `window` 的 `keydown` / `keyup`：按下 / 松开 `Shift` 时切换 `isShiftHeld`。未 hover 时不绑定（避免全局常驻监听）。
- 鼠标离开进度条时强制 `isShiftHeld = false` 防状态漂移。

### `PlayerModal.tsx` 修改

1. **新增 summary state**：

   ```ts
   const [summaryMarkdown, setSummaryMarkdown] = useState<string>('');
   ```

   加一个 effect：`video.id` 变化时 `fetch(/api/videos/${video.id}/summary)`；拿到 `data.markdown` 则 set，错误/404 静默置空。此 fetch 与 `VideoInfoPanel` 内部的同名 fetch 并行发生（两者都用 `no-store`，成本可接受；如后续要合并可把 summary 状态提升到 PlayerModal 再下传，但这不在本次 scope 内）。

2. **章节提取**：

   ```ts
   const chapters = useMemo(
     () => extractSummaryChapters(summaryMarkdown, {
       platform: video.platform,
       video_id: video.video_id,
     }),
     [summaryMarkdown, video.platform, video.video_id],
   );
   ```

3. **右侧播放器区域结构调整**：把当前 `flex: 1` 的视频区重构成：

   ```
   <div flex-col>
     <div flex-1 relative>    {/* 现有 AudioModeOverlay + iframe/native video 结构保留 */}
       ...
     </div>
     <PlayerBottomBar ... />
   </div>
   ```

   两个平台都包在这个 flex-col 里，底部条始终存在。

4. **移除现有 B 站底部控制栏**（`PlayerModal.tsx:1262-1376` 那段），把其中仍需要保留的信息（`qualityLabel` / `authUsed` / `limitations` / 错误提示 / 重试按钮）封装成一个 `bilibiliStatusNode`，通过 `trailing` 传给 `PlayerBottomBar`。原先的"倍速 `<select>`"删除——倍速改为只读展示 + 键盘快捷键调整，与用户的需求一致。

5. **`onTogglePlay` 统一**：

   ```ts
   const togglePlay = useCallback(() => {
     if (usesNativeVideo) {
       toggleNativePlayback();
       return;
     }
     if (youtubePlayerState === 1) {
       postYouTubeCommand('pauseVideo');
     } else {
       postYouTubeCommand('playVideo');
     }
   }, [usesNativeVideo, toggleNativePlayback, youtubePlayerState, postYouTubeCommand]);
   ```

   `AudioModeOverlay` 里那段重复的内联逻辑也替换成 `togglePlay`。

6. **`playbackRate` 传入**：`usesNativeVideo ? nativePlaybackRate : youtubeIframePlaybackRate`。

7. **`disabled`**：
   - YouTube：`isYt && shouldAttemptNativeYouTube && youtubePlaybackLoading && !youtubePlayerLoaded` → `true`。
   - Bilibili：`!bilibiliPlayback?.proxyUrl` → `true`。

## 交互边界

- **进度条点击 vs 章节点击**：章节段 `onClick` 直接跳 `chapter.seconds`（章节起点）。用户想精确跳某秒时仍然可以点 `VideoInfoPanel` 里的时间戳链接或用键盘 `z` / `x`。这是刻意设计——进度条以章节为一等公民。
- **iframe 模式下的 currentTime**：YouTube iframe 的 `playerStartSeconds` 由 postMessage 轮询更新（已有），进度条覆盖层会随之推进，无需额外改动。
- **duration 尚未就绪**：`duration = 0` 时进度条轨道仍渲染但无覆盖层、不可点击、段宽按均分回退（章节信息即使有也展示不了比例，此时走无章节分支）。
- **章节跨越 duration**：章节的 `seconds` 若 ≥ `duration`（摘要脏数据），截断到 `duration - 1`；末段不会越界。
- **tooltip 在最左 / 最右段**：`clamp` 已处理位置约束；左对齐时显示 `left: 0`，右对齐时 `right: 0`，`transform` 相应调整。
- **键盘快捷键冲突**：Shift 在 `player-keyboard-arbiter` 现有绑定里无独立动作，监听 `keydown` 不会触发 `preventDefault`，兼容。

## 可达性

- 播放按钮 `aria-label="播放"` / `"暂停"` 随状态切换。
- 进度条容器 `role="slider"`，`aria-valuemin={0}`，`aria-valuemax={duration}`，`aria-valuenow={currentSeconds}`，`aria-valuetext={formatSecondsLabel(currentSeconds)}`。
- 章节段 `role="button"`，`aria-label="跳转到章节：{title}（{时间}）"`。
- Tooltip `role="tooltip"`，`aria-hidden` 由 hover 状态驱动。

## 验证

- 手动：打开 YouTube 视频 → 底部条出现播放按钮 + 时间 + 倍速 + 进度条；生成摘要后进度条出现分段；hover 见标题；按 Shift 见标题 + 正文。
- 手动：B 站视频同上；原先的质量 / 错误 / 重试在 `trailing` 中仍可见。
- 单测：`summary-chapters.test.ts` 覆盖解析边界。
- typecheck + lint。

## 后续

- 可选优化摘要模板：鼓励每个可导航 section 至少在正文首段放一个完整时间戳链接，便于章节进度条稳定生成。
- 章节深链：URL hash `#t=123` 打开 PlayerModal 时自动 seek 到最近章节起点（未来 nice-to-have）。
- 进度条拖拽（非点击）：当前版本只支持点击跳转；拖拽 scrub 需要单独设计手势 + iframe 节流。
