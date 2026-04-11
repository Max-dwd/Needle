# Sidebar & Navigation — Validation Assertions

## Sidebar Structure & Grouping

### VAL-NAV-001: Intent groups displayed in sort_order

**Title:** Sidebar intent groups follow `intents.sort_order`

**Behavior:** The sidebar renders intent groups (工作, 娱乐, 探索, 新闻, 未分类) in ascending `sort_order` from the `intents` table. If a user reorders intents via the settings page, the sidebar reflects the new order on next load.

**Evidence:**
- Fetch `/api/settings/intents` and note the `sort_order` values
- Observe sidebar group order matches sort_order ascending
- Change sort_order via `/api/settings/intents/reorder`, reload sidebar, confirm new order

---

### VAL-NAV-002: 未分类 group always renders last

**Title:** 未分类 intent group is always positioned last regardless of sort_order

**Behavior:** Even if `未分类` has a `sort_order` value lower than other intents, it always renders as the last group in the sidebar. This is a hard UI rule independent of the database value.

**Evidence:**
- Set `未分类` sort_order to 0 (lowest) via direct DB update or API
- Reload sidebar; confirm 未分类 still appears after all other intent groups
- Verify with default seed data (sort_order=99) that 未分类 is last

---

### VAL-NAV-003: Intent group shows channel count

**Title:** Each intent group displays its channel count in parentheses

**Behavior:** Next to each intent name in the sidebar, a count is displayed representing the number of channels assigned to that intent (not video count). The count updates when channels are reassigned.

**Evidence:**
- Count channels per intent via `/api/channels` response grouped by `intent`
- Compare displayed sidebar counts against computed totals
- Reassign a channel's intent, reload, confirm counts update

---

### VAL-NAV-004: Collapsible intent groups

**Title:** Intent groups are collapsible/expandable via toggle control

**Behavior:** Each intent group has a collapse/expand toggle (chevron). Clicking the toggle reveals or hides the channel list underneath. The toggle does not navigate; only clicking the intent name navigates.

**Evidence:**
- Click toggle chevron on a collapsed intent → channels appear below
- Click toggle chevron on an expanded intent → channels hide
- Confirm toggle click does NOT change URL or trigger navigation
- Confirm clicking the intent name text navigates to `/?intent=<name>`

---

### VAL-NAV-005: Expanded intent shows channels sorted by video_count desc

**Title:** Channels within an expanded intent group are sorted by video count descending

**Behavior:** When an intent group is expanded, its channels are listed in descending order of `video_count`. The channel with the most videos appears first.

**Evidence:**
- Expand an intent group with 3+ channels
- Verify channel order matches descending video_count from `/api/channels`
- Add videos to a low-ranked channel, refresh, confirm it moves up in the list

---

### VAL-NAV-006: Channel entries display topic badges

**Title:** Channel entries show topic badges (max 2 visible + overflow indicator)

**Behavior:** Each channel in the expanded sidebar group shows its `topics` as small badges (gray background, rounded, ~10px font). At most 2 topic badges are visible. If the channel has more than 2 topics, a `+N` overflow badge is shown where N is the remaining count.

**Evidence:**
- Channel with 0 topics: no badges shown
- Channel with 1 topic: one badge visible, no overflow
- Channel with 2 topics: two badges visible, no overflow
- Channel with 4 topics: two badges visible + `+2` overflow badge
- Verify badge styling: gray background, rounded corners, ~10px font size

---

### VAL-NAV-007: Each channel appears exactly once in sidebar

**Title:** No channel is duplicated across intent groups

**Behavior:** Since `intent` is single-select per channel, each channel appears in exactly one intent group. Unlike the old `category2` system, there is no duplication.

**Evidence:**
- Expand all intent groups in the sidebar
- Count total channel entries across all groups
- Compare to total channel count from `/api/channels` — must be equal
- Search for any channel name appearing in more than one group — must find none

---

## Navigation & Filtering

### VAL-NAV-008: Clicking intent name navigates to filtered home page

**Title:** Clicking an intent name in the sidebar navigates to `/?intent=<name>`

**Behavior:** Clicking the intent name (not the expand toggle) sets the URL to `/?intent=<encodedName>` and the home page displays only videos from channels with that intent.

**Evidence:**
- Click "工作" intent name in sidebar
- URL becomes `/?intent=工作` (properly encoded)
- Video list shows only videos from channels where `intent = '工作'`
- Cross-reference with `/api/videos?intent=工作` response

---

### VAL-NAV-009: Platform filters remain independent of intent

**Title:** Platform filters (YouTube/B站) work independently and combine with intent filter

**Behavior:** The platform filter links (`/?platform=youtube`, `/?platform=bilibili`) in the top section of the sidebar remain functional and do not conflict with intent filtering. When both are active, they combine as AND conditions.

**Evidence:**
- Navigate to `/?intent=工作` — see all 工作 videos
- Then navigate to `/?intent=工作&platform=youtube` — see only YouTube videos from 工作 channels
- Navigate to `/?platform=bilibili` alone — see all Bilibili videos regardless of intent
- Confirm platform pills in sidebar show correct active state independent of intent selection

---

### VAL-NAV-010: Active state highlights current intent in sidebar

**Title:** Sidebar visually highlights the currently active intent group

**Behavior:** When the URL contains `?intent=X`, the corresponding intent group in the sidebar receives the `active` CSS class/style, providing visual feedback of the current filter.

**Evidence:**
- Navigate to `/?intent=娱乐`
- Confirm "娱乐" sidebar item has active styling
- Confirm no other intent items have active styling
- Navigate to `/` (no intent param) — confirm no intent item is active

---

### VAL-NAV-011: Auto-expand intent group for active filter

**Title:** Sidebar auto-expands the intent group matching the current URL filter

**Behavior:** When the page loads with `?intent=X` or `?channel_id=Y`, the sidebar automatically expands the corresponding intent group so the user sees their current context.

**Evidence:**
- Navigate directly to `/?intent=探索` — 探索 group is expanded on load
- Navigate to `/?channel_id=42` where channel 42 belongs to 工作 — 工作 group is expanded
- Other groups remain collapsed unless previously manually expanded

---

## Home Page Integration

### VAL-NAV-012: Home page filters videos by intent parameter

**Title:** `/?intent=X` filters the video feed to show only videos from channels with that intent

**Behavior:** When the `intent` URL parameter is set, the home page fetches videos filtered by that intent. The API call includes the intent parameter and the backend filters by `channels.intent`.

**Evidence:**
- Navigate to `/?intent=工作`
- All displayed videos belong to channels with `intent = '工作'`
- Video count in toolbar matches `/api/videos?intent=工作` total
- No videos from other intents appear in the feed

---

### VAL-NAV-013: Home page filters videos by topic parameter

**Title:** `/?topic=X` filters the video feed by channel topic tag

**Behavior:** When the `topic` URL parameter is set, the home page shows videos from channels whose `topics` JSON array contains the specified value.

**Evidence:**
- Navigate to `/?topic=AI`
- All displayed videos belong to channels that have "AI" in their topics array
- A channel with topics `["AI", "前端"]` has its videos included
- A channel with topics `["游戏"]` has its videos excluded

---

### VAL-NAV-014: Page title adapts to intent filter

**Title:** Page title shows intent name when filtered by intent

**Behavior:** When `?intent=X` is active, the page `<h1>` displays the intent name (e.g., "工作") instead of the default "所有视频".

**Evidence:**
- `/?intent=工作` → title is "工作"
- `/` (no filter) → title is "所有视频"

---

### VAL-NAV-015: Page title combines intent and platform

**Title:** Page title shows "intent · platform" when both filters are active

**Behavior:** When both `?intent=X` and `?platform=Y` are set, the title combines them with a middle dot separator.

**Evidence:**
- `/?intent=工作&platform=youtube` → title is "工作 · YouTube"
- `/?intent=娱乐&platform=bilibili` → title is "娱乐 · B站"
- `/?platform=youtube` alone → title is "YouTube" (no intent prefix)

---

### VAL-NAV-016: Page title adapts to topic filter

**Title:** Page title shows "主题：X" when filtered by topic

**Behavior:** When `?topic=X` is active, the page title displays "主题：X" to clearly indicate topic-based filtering.

**Evidence:**
- `/?topic=AI` → title is "主题：AI"
- `/?topic=前端` → title is "主题：前端"

---

### VAL-NAV-017: Page title shows channel name for channel filter

**Title:** Page title displays channel name when filtered by channel_id

**Behavior:** When `?channel_id=Y` is active, the title shows the channel's display name (or fallback to "频道视频" while loading).

**Evidence:**
- `/?channel_id=42` where channel 42 is "3Blue1Brown" → title is "3Blue1Brown"
- While loading → title is "频道视频"

---

### VAL-NAV-018: Video refresh supports intent parameter

**Title:** Refresh button sends intent parameter to `/api/videos/refresh`

**Behavior:** When the user clicks the refresh button while viewing an intent-filtered feed (`/?intent=X`), the POST to `/api/videos/refresh` includes the `intent` parameter (not the old `category`), scoping the refresh to channels in that intent.

**Evidence:**
- Navigate to `/?intent=工作`, click refresh
- Inspect network request to `/api/videos/refresh` — body contains `{ intent: "工作" }`
- Only channels with `intent = '工作'` are crawled
- Body does NOT contain a `category` field

---

### VAL-NAV-019: 全部视频 link clears all filters

**Title:** Clicking "全部视频" / Videos in sidebar clears intent, topic, and platform filters

**Behavior:** The top "📹 Videos" link in the sidebar navigates to `/` with no query parameters, clearing any active intent, topic, or platform filter.

**Evidence:**
- From `/?intent=工作&platform=youtube`, click "📹 Videos"
- URL becomes `/`
- All videos are shown regardless of intent or platform
- No filter parameters remain in the URL

---

### VAL-NAV-020: Sidebar header links remain functional

**Title:** The ➕ (channels) and ⚙️ (settings) links in sidebar header work correctly

**Behavior:** The "➕" link navigates to `/channels` and the "⚙️" link navigates to `/settings`, regardless of current filter state.

**Evidence:**
- From any filtered view, click ➕ → URL is `/channels`
- From any filtered view, click ⚙️ → URL is `/settings`

---

### VAL-NAV-021: Empty intent group still renders in sidebar

**Title:** Intent groups with zero channels are still visible in the sidebar

**Behavior:** Even if an intent has no channels assigned to it, it still appears in the sidebar with a count of (0), allowing users to see the full intent taxonomy and navigate to an empty filtered view.

**Evidence:**
- Create a new intent "学习" with no channels
- Sidebar shows "学习 (0)" in its sort_order position
- Clicking it navigates to `/?intent=学习` showing an empty feed

---

### VAL-NAV-022: Sidebar reflects real-time channel reassignment

**Title:** Sidebar updates when a channel is moved between intents

**Behavior:** After reassigning a channel's intent (via channel management or API), the sidebar reflects the change: the channel moves from the old intent group to the new one, and counts update accordingly.

**Evidence:**
- Channel "Fireship" is in 工作 (count=15). Move it to 探索 via PATCH.
- Reload sidebar: 工作 count decreases, 探索 count increases
- Expanding 工作 no longer shows Fireship; expanding 探索 does

---

### VAL-NAV-023: Topic badge overflow count is accurate

**Title:** The `+N` overflow badge shows the correct remaining topic count

**Behavior:** When a channel has more than 2 topics, the overflow badge displays exactly `+N` where N equals `topics.length - 2`.

**Evidence:**
- Channel with topics `["AI", "前端", "后端", "DevOps"]` → badges: `[AI] [前端] +2`
- Channel with topics `["AI", "前端", "后端"]` → badges: `[AI] [前端] +1`
- Channel with topics `["AI", "前端"]` → badges: `[AI] [前端]` (no overflow)

---

### VAL-NAV-024: Sidebar total video count in "全部视频" row

**Title:** The "全部视频" row displays the total video count across all intents

**Behavior:** The sidebar's top "📹 Videos" entry shows the total number of videos in the system, regardless of intent or platform filters. This count should match the sum of all video counts.

**Evidence:**
- Sum `video_count` across all channels from `/api/channels`
- Compare with the number displayed next to "📹 Videos"
- Confirm they match

---

### VAL-NAV-025: URL encoding handles special characters in intent names

**Title:** Intent names with special characters are properly URL-encoded in sidebar links

**Behavior:** If an intent name contains special characters (spaces, CJK characters, ampersands), the sidebar generates properly encoded URLs and the home page correctly decodes them.

**Evidence:**
- Intent name "工作" generates link `/?intent=%E5%B7%A5%E4%BD%9C` (or equivalent encoding)
- Clicking the link correctly filters to 工作 videos
- Page title displays the decoded name "工作", not the encoded form
