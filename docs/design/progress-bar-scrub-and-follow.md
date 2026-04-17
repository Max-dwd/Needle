# Progress Bar Scrub + Summary Follow Mode

本文档在 [`player-bottom-bar.md`](./player-bottom-bar.md) 基础上，调整章节进度条的点击与 hover 语义，并新增 "追随模式"（左侧总结面板跟随播放进度 / 进度条悬停滚动）。不替换原设计，只修订章节交互 + 扩充一个新功能块。

## 背景

当前 [`PlayerBottomBar.tsx`](../../src/components/player/PlayerBottomBar.tsx) 的章节覆盖层 `onClick` 里调用 `e.stopPropagation()` + `onSeek(ch.seconds)`，把外层按"光标比例跳转"的行为拦下来，结果点击进度条永远跳到当前章节**起点**而不是点击位置，用户无法在章节内部精确 scrub。同时 Shift hover 显示的是章节起始时间戳，和鼠标位置无关；tooltip 居中基于章节段而不是鼠标光标。

追随模式的动机：长视频 + 带章节的总结笔记场景下，用户眼睛在视频和左侧 `VideoInfoPanel` 的摘要区之间来回跳。让摘要面板自动滚动到当前播放章节，能显著减少手动定位。

## 目标

1. **hover 行为**：进度条任意位置 hover → 上方 tooltip 显示 `<光标所指时间>` + `<光标所在章节的标题>`；hover 所在的那一段进度条**视觉变粗**。
2. **点击行为**：点击任意位置 → seek 到**光标所指秒数**（不再跳章节起点）。
3. **Shift 行为**：保持现有"详情浮窗"（标题 + 正文），只是显示的时间改成光标时间，详情体仍来自光标所在章节。
4. **tooltip 居中**：以光标 clientX 为中心（`translateX(-50%)`），必要时 clamp 防止**浏览器视口**溢出（不只是轨道容器）。
5. **追随模式**：按 `F` 切换，状态视觉提示显示在底部条上；开启时
    - 播放进度推进 → 左侧总结面板滚动到当前章节，章节标题对齐面板顶部；
    - 鼠标 hover 进度条 → 面板滚动到 hover 所在章节（hover 优先于播放进度）；
    - 鼠标离开进度条 → 回到跟随播放进度。
6. **非目标**：
   - 不做拖拽 scrub（和 `player-bottom-bar.md` 原非目标一致）。
   - 追随模式不做平滑跟随小节内偏移；以章节为最小粒度。
   - 不改键盘仲裁器的整体架构，只新增一个 action。

## 章节进度条修订

### 交互语义

| 动作 | 当前 | 修订后 |
| --- | --- | --- |
| 点击章节段 | `stopPropagation()` + `onSeek(chapter.seconds)` | **不拦截**，外层 `handleProgressClick` 按光标 ratio seek |
| 点击章节间隙 | 外层 seek 到光标位置 | 同左，不变 |
| hover tooltip 时间行 | `formatSecondsLabel(chapter.seconds)` | `formatSecondsLabel(cursorSeconds)` |
| hover tooltip 标题行 | `chapter.title`（hovered 段） | `chapter.title` of chapter **containing cursor** |
| hover tooltip 水平位置 | `translateX(-50%)` 基于轨道内 clamp 到 `[8, trackWidth - 8]` | 基于**视口**再做一次 clamp，保证浮窗整个盒子不越过 `window.innerWidth - 8` |
| hover 段视觉 | 无区分 | 光标所在段轨道**变粗** |
| Shift 详情 | 展示当前 hovered 段正文 | 展示光标所在段正文；其余行为保留 |

### 光标时间与光标章节

在 `handleMouseMove` 里基于 `trackRef` 的 `rect` 同时计算：

```ts
const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
const cursorSeconds = ratio * duration;
// 段查找：找最后一个 seconds ≤ cursorSeconds 的章节；若没有章节或 cursor 在第 0 段之前，取第 0 段或 null。
const cursorChapterIndex = findChapterIndexForSeconds(chapters, cursorSeconds);
```

`findChapterIndexForSeconds` 是纯函数，放在 `src/lib/summary-chapters.ts` 里，便于单测。规则：

- `chapters` 为空 → `-1`。
- 二分（或线性，章节通常很少）找到最大 `i` 使 `chapters[i].seconds ≤ seconds`；若 `seconds < chapters[0].seconds` 则返回 `0`（光标在第一章节前的时段按第一章处理，保持 UI 恒有标题显示）。

这样无论 `duration` 是否就绪、`chapters` 是否存在，都能稳定得到一个当前段索引或 `-1`。

### "hover 段变粗" 视觉

不改轨道整体高度（6px），而是在当前 hovered chapter 的那一段**上面再叠一层**：

- 轨道容器高度仍 6px，交互 hitbox `padding-top/bottom: 8px`（hit area 扩展到 ~22px），保证竖直方向贴合不容易丢 hover。
- 在 Visual Layer 里，当 `cursorChapterIndex !== -1` 时额外渲染一个 `<div>`：
  - `left: startPct%`、`width: widthPct%`（和该章节 interaction overlay 对齐）
  - `top: -2px`、`bottom: -2px` → 视觉高度 10px
  - `background: var(--accent-purple)`、`opacity: 0.9`（进度部分已经有 0.75 的紫色覆盖；hover 段用更亮一点的 overlay 叠上去）
  - `border-radius: 3px`
  - `transition: top 80ms, bottom 80ms, opacity 80ms`
  - `pointer-events: none`
  - `mix-blend-mode` 保持默认；段间 2px gap 由现有分隔符保持
- 未播放段的 hover 高亮走同一个 div；已播放区域上 hover 由于 progress fill 已经是同色，变粗表现为"整段浮出"，视觉上仍清晰可辨。

这个"加粗段"是独立的第 3 视觉层，不影响 `progress fill` 和 `separators`。

### tooltip 位置 clamp

当前实现：

```ts
setTooltipLeft(Math.max(8, Math.min(x, rect.width - 8)));
// ...
left: Math.max(8, Math.min(tooltipLeft, Math.max(8, trackWidth - 8))),
transform: 'translateX(-50%)',
```

问题：`tooltipLeft` 是 track 内坐标，且 `translateX(-50%)` 让盒子左右各伸出 `tooltipWidth/2`；`clamp` 只限制了 anchor point 在 track 内部，tooltip 盒子在窄 track + 长标题时仍可能溢出浏览器右侧（当 PlayerModal 本身靠屏幕右侧时）。

修订：

1. 记录轨道容器的屏幕坐标：`rect.left` / `rect.right`。
2. `tooltipCenterViewport = rect.left + tooltipLeft`。
3. 布局时测量 tooltip 宽度（ref + `offsetWidth`，mount 后一次 + 内容变化时更新）。
4. 计算 `minCenter = tooltipWidth / 2 + 8`、`maxCenter = window.innerWidth - tooltipWidth / 2 - 8`。
5. `clampedCenter = clamp(tooltipCenterViewport, minCenter, maxCenter)`。
6. tooltip 的 `left` 改为相对**视口**定位，或者仍相对于轨道并用 `left: clampedCenter - rect.left`。后者简单：

   ```ts
   left: clampedCenter - rect.left,
   transform: 'translateX(-50%)',
   ```

7. `tooltipWidth` 测量前先用 `visibility: hidden` 渲一次然后再算位置，或用 `useLayoutEffect` 在同一帧内完成测量 + 定位，避免首帧跳一下。Shift 从收起 → 展开时宽度变化，`transition` 保留在盒子自身，`left` 用新宽度重算不走过渡（免得位置漂移）。

> 追加 clamp 不去掉现有"anchor 在 track 内"的 clamp——两个都保留，先 track clamp 再视口 clamp，语义是"锚点不能跑出轨道之外，盒子不能跑出屏幕之外"。

### 无章节时

- 仍然允许点击跳转到光标位置（当前已支持）。
- hover 时 tooltip 只显示 `<光标时间>` 一行，不显示章节标题行。
- 不显示"加粗段"（无段概念）。

## 追随模式（F）

### 状态与快捷键

底部条新增本地 state：

```ts
const [followMode, setFollowMode] = useState(false);
```

但 F 键必须走 `player-keyboard-arbiter`，以免抢其他焦点。两种实现选一：

**选项 A（推荐）**：在 `PlayerModal` 里持有 `followMode` state，通过 arbiter 绑定 `F` 到 `() => setFollowMode(v => !v)`，然后传给 `PlayerBottomBar`（仅用于显示状态）和 `VideoInfoPanel`（真正的滚动执行者）。

**选项 B**：`PlayerBottomBar` 内部听 window `keydown`，和现有 Shift 监听一样。但这绕开了键盘仲裁，和项目约定不一致，不采用。

采用 **A**。`player-keyboard-arbiter` 的 action 键名：`toggleSummaryFollow`。仅当播放器 modal 打开且焦点未在输入框时响应（键盘仲裁器已有此约束）。

### 状态提示

底部条倍速标签左侧加一个小指示器（或复用 `trailing` 右侧）：

- `followMode === false`：不显示。
- `followMode === true`：显示一个 12px 图标（下箭头或磁铁 unicode，避开 emoji，沿用当前无 emoji 风格）+ "追随" 文本，色值 `var(--accent-purple)`，字号 11。
- 开启 / 关闭瞬间短促提示：可选，一期不加 toast，只靠底部条常驻指示。

### 滚动目标

追随模式开启时，`VideoInfoPanel` 需要把滚动容器滚到"目标章节"。需要解决的子问题：

1. **滚动容器**：`VideoInfoPanel` 内渲染 `MarkdownRenderer` 的那个外层 `div`（通常是 `overflow-y: auto` 的面板 body）。给它加 `ref`，暴露一个 `scrollToChapter(index)` 命令（通过 `useImperativeHandle` 或 prop 回调）。
2. **章节锚点**：摘要 markdown 的 `## / ### / ####` heading 由 `MarkdownRenderer.tsx:363` 的 `headingMatch` 分支渲染。给 heading 元素加 `data-summary-chapter-index={n}`。`n` 的计算方式：
   - 同一个 `extractSummaryChapters` 逻辑内联 / 抽取成 `mapHeadingLineToChapterIndex(markdown) → Map<lineNumber, chapterIndex>`，渲染时 MarkdownRenderer 通过行号查表拿到 index。
   - 更轻的做法：MarkdownRenderer 解析 heading 时同时把该 heading 下文第一个 `parseSeekSeconds` 命中的时间戳拿出来，作为 `data-summary-seconds`；追随模式按 seconds 做最接近匹配（和 `findChapterIndexForSeconds` 同逻辑）。
   - 推荐后者：避免 MarkdownRenderer 和 `summary-chapters` 的索引强耦合。只要两边都靠 "section 内首个可解析时间戳" 这条规则，就天然一致。
3. **滚动行为**：
   ```ts
   const target = container.querySelector<HTMLElement>(
     `[data-summary-seconds="${chapter.seconds}"]`,
   );
   if (target) {
     container.scrollTo({
       top: target.offsetTop - container.offsetTop - 8,
       behavior: 'smooth',
     });
   }
   ```
   `- 8` 给顶部留一点呼吸空间。"上方对齐"即 heading 顶部贴面板顶部。
4. **播放进度驱动**：`PlayerModal` 里计算 `activeChapterIndex = findChapterIndexForSeconds(chapters, playerStartSeconds)`，用 effect 监听其变化；只有当 `followMode && hoveredChapterIndex === null` 时调 `scrollToChapter(activeChapterIndex)`。避免在播放同一章节内每秒都滚一下——只在 index 变化时触发。
5. **hover 驱动**：`PlayerBottomBar` 把 `cursorChapterIndex` 通过 prop `onCursorChapterChange(index | null)` 冒泡给 `PlayerModal`；`PlayerModal` 用它驱动 `scrollToChapter`。hover 离开 → `null` → 回退到 `activeChapterIndex`。
6. **hover 驱动节流**：章节切换本身不会每帧发生（只在光标跨段时），不必额外节流。但连续快速扫过多个段时，`scroll-behavior: smooth` 会产生排队动画；用 `scrollTo({ behavior: 'auto' })` 或在 hover 驱动路径下用 `auto`，播放进度驱动路径下用 `smooth`。

### 手动滚动不打架

用户在追随模式下手动滚动摘要面板时，如果下一次 chapter index 变化又被拉回来，体验不好。但做"检测用户手动滚动 → 暂停追随"会复杂化状态机。一期方案：

- 追随模式下面板仍可手动滚动；下一次 `activeChapterIndex` 变化 / hover 变化仍会拉回。
- 用户想让面板稳住不动 → 按 F 关掉追随。

（后续若反馈不好再引入"手动滚动时静默 N 秒"的启发式。）

### 状态持久化

一期不持久化。每次打开 `PlayerModal` 默认 `followMode = false`。关掉 modal 再打开视 UX 反馈决定是否保存到 `app_settings` 或 `sessionStorage`。

## 交付拆分

对照 `player-bottom-bar.md` 的文件清单，本次改动落点：

| 文件 | 改动 |
| --- | --- |
| [`src/lib/summary-chapters.ts`](../../src/lib/summary-chapters.ts) | 新增 `findChapterIndexForSeconds(chapters, seconds): number` 导出 |
| `src/lib/summary-chapters.test.ts` | 新增 `findChapterIndexForSeconds` 用例：空章节 / 光标在首章之前 / 边界等于某章 / 末章之后 |
| [`src/components/player/PlayerBottomBar.tsx`](../../src/components/player/PlayerBottomBar.tsx) | 章节段 `onClick` 去掉拦截；`cursorSeconds` / `cursorChapterIndex` 计算；tooltip 文案改为光标时间 + 光标章节；tooltip 视口级 clamp；hover 段加粗 overlay；新增 prop `followMode: boolean` 用于显示指示器；新增 prop `onCursorChapterChange` |
| [`src/components/MarkdownRenderer.tsx`](../../src/components/MarkdownRenderer.tsx) | heading 渲染时若 section 内能解析出时间戳，为 heading 元素加 `data-summary-seconds={n}`（只改渲染元数据，不改视觉） |
| [`src/components/VideoInfoPanel.tsx`](../../src/components/VideoInfoPanel.tsx) | 摘要滚动容器加 `ref`；`useImperativeHandle` 暴露 `scrollToChapter(chapter: SummaryChapter, opts?: { smooth?: boolean })`；或通过 prop 接收 `scrollRequest` 信号 |
| [`src/components/PlayerModal.tsx`](../../src/components/PlayerModal.tsx) | 持有 `followMode`、`cursorChapterIndex`、`activeChapterIndex`；通过 `player-keyboard-arbiter` 注册 `F` → toggle；effect 在 `followMode` 开启时把目标章节发给 `VideoInfoPanel` |
| [`src/lib/player-keyboard-arbiter.ts`](../../src/lib/player-keyboard-arbiter.ts) / [`src/lib/player-keyboard-mode.ts`](../../src/lib/player-keyboard-mode.ts) | 新增 `toggleSummaryFollow` action；在播放器 modal 焦点域内绑定 `F` |
| [`docs/design/player-keyboard-shortcuts.md`](./player-keyboard-shortcuts.md) | 补充 `F` 的条目：Toggle summary follow mode |

没有 DB / API 路由 / 后端改动。

## 边界与风险

- **未生成摘要**：`chapters = []`，追随模式按开启但无效；底部条指示器仍显示。可选择在没有章节时按 F 直接无视（不切换状态）并在底部条上短暂提示"暂无章节"——一期不做，简单点。
- **YouTube iframe 卡顿 currentTime**：`playerStartSeconds` 更新依赖 postMessage 轮询，粒度 ~250ms；章节跨段边界附近的滚动会有感知延迟，但不会跳（index 不会来回颠簸）。
- **摘要分段很细**：章节密度极高时 hover 扫过会触发连串 `auto` 滚动，visually 会"跳"。验收时手动扫一个 20+ 章节的长视频确认体验；真要问题可给 hover 驱动加 120ms 防抖。
- **heading 文本含时间戳**：渲染层需要和 `extractSummaryChapters` 逻辑对齐（按 section 内首个可解析时间戳），否则 `data-summary-seconds` 和章节列表错位。测试覆盖 `MarkdownRenderer` 中 heading data 属性生成，确保和 `summary-chapters` 一致。
- **tooltip 测量闪烁**：`useLayoutEffect` + ref 测宽度；若 Shift 切换展开态改变宽度，只重算 `left`，不重算 `opacity/visibility`。
- **键盘仲裁冲突**：`F` 在当前未被占用（`grep` 过 `src/` 无 `'f'`/`'F'` 作为快捷键）；仲裁器里加一个入参开关 `enableFollowToggle`，方便未来关闭。

## 验证

- **手动**：
  - 点击进度条任意位置（章节段内、段间） → 视频 seek 到光标对应秒数，而不是章节起点。
  - hover 中间某秒 → tooltip 显示光标时间 + 光标所在章节标题；按 Shift 追加正文；hover 段进度条加粗。
  - hover 移到屏幕最左 / 最右段 → tooltip 不超出视口。
  - 按 F → 底部条出现"追随"指示；视频播放过章节分界 → 左侧面板自动滚到该章节顶部；hover 另一章节 → 面板切到 hover 的章节；鼠标离开 → 回到播放章节；再按 F → 指示消失，面板不再自动滚。
- **单测**：
  - `findChapterIndexForSeconds` 的上述边界用例。
  - `extractSummaryChapters` 不变；如有共享 helper 提出复用，沿用现有测试。
- `npm run typecheck` + `npm run lint` + `npm run test`。

## 后续（非本次 scope）

- 拖拽 scrub：结合 iframe `postMessage` 节流 + native `video.currentTime` 直写。
- 追随模式智能暂停：检测用户手动滚动后暂停 N 秒。
- 章节缩略图 hover：在 tooltip 里加该秒的视频缩略图（YouTube 有 storyboard.vtt，B 站需要自己抽帧，成本高）。
- 追随模式偏好持久化到 `app_settings.player_follow_mode_default`。
