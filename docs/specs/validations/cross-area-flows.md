# Cross-Area Flow Validation Assertions

## Flow 1: Create Intent on Settings → Sidebar → Video Filtering

**VAL-CROSS-001**: When a user creates a new intent "学习" via `POST /api/settings/intents` with `{ name: "学习", auto_subtitle: 1, auto_summary: 0, sort_order: 4 }`, the response returns a valid `Intent` object with the assigned `id`, and a subsequent `GET /api/settings/intents` includes "学习" in the list sorted by `sort_order`.

**VAL-CROSS-002**: After creating intent "学习" on the settings page, navigating to any page that renders `AppSidebar` causes the sidebar to fetch `/api/channels` and display "学习" as a new collapsible group in the intent section, positioned according to its `sort_order` relative to other intents (工作, 娱乐, 探索, 新闻, 未分类).

**VAL-CROSS-003**: Clicking the "学习" intent group in the sidebar navigates to `/?intent=学习`, the home page reads the `intent` search parameter, passes it to `GET /api/videos?intent=学习`, and the API returns only videos whose channel has `intent = '学习'`, with the page title displaying "学习".

**VAL-CROSS-004**: When no channels are assigned to the newly created intent "学习", the sidebar shows a video count of `(0)` next to it, and `/?intent=学习` shows the empty state ("暂无视频").

## Flow 2: Assign Channel to Intent on Channels Page → Sidebar → Filtering

**VAL-CROSS-005**: On the channels page, selecting a single channel and using the intent dropdown to set `intent: "工作"` via `PATCH /api/channels/[id]` with `{ intent: "工作" }` returns a 200 response with the updated channel object where `intent === "工作"`.

**VAL-CROSS-006**: After assigning channel "3Blue1Brown" from "未分类" to "工作" on the channels page, the sidebar (on next data fetch) shows "3Blue1Brown" nested under the "工作" group and no longer under "未分类". The video count for "工作" increases by the channel's video count, and "未分类" decreases correspondingly.

**VAL-CROSS-007**: After the channel assignment in VAL-CROSS-006, navigating to `/?intent=工作` returns videos from "3Blue1Brown" in the results, while `/?intent=未分类` no longer includes those videos.

**VAL-CROSS-008**: Bulk-updating 5 channels from "未分类" to "探索" via `POST /api/channels/bulk-update` with `{ ids: [1,2,3,4,5], intent: "探索" }` returns success, and all 5 channels' `intent` field reads "探索" on a subsequent `GET /api/channels`.

## Flow 3: Delete Intent → Channels Fallback → Sidebar Updates → Video Counts

**VAL-CROSS-009**: When deleting intent "探索" (which has 3 assigned channels) via `DELETE /api/settings/intents/[id]`, the API responds with 200, and a subsequent `GET /api/channels` shows all 3 previously-assigned channels now have `intent = '未分类'`.

**VAL-CROSS-010**: After deleting intent "探索", the sidebar no longer shows "探索" as a group. The "未分类" group's video count has increased by the sum of video counts from the 3 channels that were reassigned.

**VAL-CROSS-011**: After intent deletion, navigating to `/?intent=探索` returns zero videos (the intent no longer exists as a valid filter), while `/?intent=未分类` now includes the videos from the reassigned channels.

**VAL-CROSS-012**: The `DELETE /api/settings/intents/[id]` endpoint rejects deletion of the "未分类" intent with a 400 status and an appropriate error message, preserving the system invariant that "未分类" always exists.

## Flow 4: Reorder Intents in Settings → Sidebar Order Changes

**VAL-CROSS-013**: Calling `POST /api/settings/intents/reorder` with `{ order: [4, 1, 2, 3] }` (where IDs map to intents 新闻, 工作, 娱乐, 探索) updates `sort_order` values such that a subsequent `GET /api/settings/intents` returns intents in the new order: 新闻 → 工作 → 娱乐 → 探索 → 未分类 (未分类 always last).

**VAL-CROSS-014**: After reordering intents via the settings page, the sidebar renders intent groups in the updated order. Specifically, if "新闻" was moved to `sort_order: 0`, it appears as the first intent group in the sidebar, above "工作".

**VAL-CROSS-015**: The "未分类" intent's `sort_order` is always treated as the highest value (e.g., 99) regardless of reorder operations—it cannot be moved above other intents in either the API response or the sidebar display.

## Flow 5: Add Topics to Channel → Sidebar Badges → Topic Filter on Home Page

**VAL-CROSS-016**: Updating a channel's topics via `PATCH /api/channels/[id]` with `{ topics: ["AI", "前端"] }` returns the channel with `topics: ["AI", "前端"]` as a parsed JSON array, and the value is correctly stored as `'["AI", "前端"]'` in the database's `topics` column.

**VAL-CROSS-017**: After adding topics `["AI", "前端"]` to channel "3Blue1Brown", expanding the "工作" group in the sidebar shows "3Blue1Brown" with small topic badges "AI" and "前端" rendered beside the channel name (max 2 visible, with `+N` overflow for additional topics).

**VAL-CROSS-018**: Navigating to `/?topic=AI` on the home page causes `GET /api/videos?topic=AI` to return only videos whose channels have "AI" in their `topics` JSON array, using the `json_each` SQLite function for matching.

**VAL-CROSS-019**: When a channel has 4 topics `["AI", "前端", "数学", "教育"]`, the sidebar badge display shows the first 2 topics as visible badges and a `+2` overflow indicator, never exceeding the visual space budget.

**VAL-CROSS-020**: Adding topic "AI" to multiple channels across different intents (e.g., one in "工作", one in "探索") means `/?topic=AI` returns videos from both intents, confirming topic filtering is cross-intent and not scoped to a single intent.

## Flow 6: Batch Update Channels → Sidebar Reflects → Home Page Consistent

**VAL-CROSS-021**: On the channels page, filtering by "未分类" intent pill, selecting all displayed channels with "全选本组", and applying intent "工作" via the batch operation bar calls `POST /api/channels/bulk-update` with the correct set of IDs and `{ intent: "工作" }`, returning a success response.

**VAL-CROSS-022**: After a batch intent update of 10 channels from "未分类" to "工作", the channels page re-fetches and shows those channels under the "工作" group heading (when grouped by intent), with 0 channels remaining in the "未分类" group if no others exist.

**VAL-CROSS-023**: Following the batch update in VAL-CROSS-022, the sidebar's "工作" count reflects the added video totals and "未分类" count decreases correspondingly. The sum of all intent group counts in the sidebar equals the "全部视频" total count.

**VAL-CROSS-024**: Batch adding topics via `POST /api/channels/bulk-update` with `{ ids: [1,2,3], addTopics: ["ML"] }` appends "ML" to each channel's existing topics array without removing existing topics. A channel that already had `["AI"]` now has `["AI", "ML"]`.

**VAL-CROSS-025**: Batch removing topics via `POST /api/channels/bulk-update` with `{ ids: [1,2,3], removeTopics: ["ML"] }` removes "ML" from each channel's topics array. A channel that had `["AI", "ML"]` now has `["AI"]`, while a channel without "ML" remains unchanged.

## Flow 7: Markdown Export → Import on Fresh State → Intents/Topics Preserved

**VAL-CROSS-026**: Exporting subscriptions via `GET /api/channels/markdown` produces markdown in the new format where `##` headings correspond to intent names (not platform names), channel lines include `#tag` syntax for topics, and backtick-enclosed `youtube:` / `bilibili:` identifiers are present for each channel.

**VAL-CROSS-027**: The exported markdown for a channel with intent "工作" and topics `["AI", "数学"]` produces a line under `## 工作` like: `- [3Blue1Brown](https://youtube.com/channel/UC...) \`youtube:UC...\` #AI #数学`.

**VAL-CROSS-028**: Importing the exported markdown on a fresh database (no existing channels) via `POST /api/channels/markdown` creates channels with the correct `intent` values corresponding to the `##` headings, and `topics` arrays parsed from the `#tag` syntax. If `## 工作` contains a channel with `#AI #数学`, the created channel has `intent: "工作"` and `topics: ["AI", "数学"]`.

**VAL-CROSS-029**: After a full export→import round-trip, the sidebar displays the same intent groups with the same channel nesting and topic badges as before the export, confirming data fidelity.

**VAL-CROSS-030**: When importing markdown that uses the old format (headings "YouTube" / "Bilibili" with nested categories), the importer detects the legacy format, maps old `category` values to `topics`, sets `intent` to "未分类" for all channels, and the sidebar shows all imported channels under "未分类" with their old categories as topic badges.

## Flow 8: Pipeline — Intent auto_subtitle Setting → New Video Behavior

**VAL-CROSS-031**: Given intent "工作" has `auto_subtitle: 1` and a channel "3Blue1Brown" is assigned to intent "工作", when a new video is discovered (`video:discovered` event), the pipeline first checks `automation_rules`. If no rules match, it falls back to the intent's `auto_subtitle` setting, and the video is queued for subtitle fetching.

**VAL-CROSS-032**: Given intent "娱乐" has `auto_subtitle: 0` and `auto_summary: 0`, when a new video is discovered from a channel in "娱乐" and no automation rules match, the pipeline does NOT queue the video for subtitle fetching, and no `summary_task` is created.

**VAL-CROSS-033**: Given intent "新闻" has `auto_subtitle: 1` and `auto_summary: 1`, when a video's subtitle becomes ready (`subtitle:ready` event) for a channel in "新闻" and no automation rules override, the pipeline creates a `summary_task` with status "pending" for that video.

**VAL-CROSS-034**: When an automation rule explicitly sets `skip_summary` for a video matching a condition, and the channel's intent has `auto_summary: 1`, the automation rule takes precedence—the `summary_task` is created with status "skipped", not "pending".

**VAL-CROSS-035**: After changing intent "娱乐" from `auto_subtitle: 0` to `auto_subtitle: 1` via `PATCH /api/settings/intents/[id]`, newly discovered videos from channels in "娱乐" are now queued for subtitle fetching, while previously discovered videos remain unaffected.

## Flow 9: First-Time Navigation — Feature Discoverability

**VAL-CROSS-036**: Starting from the home page (`/`), the sidebar contains a visible settings icon link (`⚙️`) that navigates to `/settings`, where the intent management section is accessible within the settings page tabs/sections.

**VAL-CROSS-037**: Starting from the home page (`/`), the sidebar contains a visible channels management link (`➕`) that navigates to `/channels`, where batch operations (checkbox selection, intent dropdown, topic input) are available on the channel list.

**VAL-CROSS-038**: On the settings page, the navigation sidebar includes an entry for intent management (e.g., under a "常规" or dedicated tab) that, when clicked, reveals the intent table with add/edit/delete/reorder controls.

**VAL-CROSS-039**: On the channels page, the search bar is immediately visible at the top, the intent/platform pill filters are rendered below it, and the sort toggle is accessible—all without requiring scrolling past the fold on a 1080p viewport.

**VAL-CROSS-040**: The sidebar's intent groups are collapsible (expand/collapse toggle), and clicking an intent name navigates to `/?intent=<name>` to filter videos—these two interactions (expand vs. navigate) use distinct click targets that do not conflict.

## Flow 10: Data Migration — Old Categories → Topics, Sidebar Shows Intents

**VAL-CROSS-041**: On first app start after migration, the `ALTER TABLE channels ADD COLUMN intent TEXT DEFAULT '未分类'` migration runs, and all existing channels have `intent = '未分类'` regardless of their previous `category` value.

**VAL-CROSS-042**: On first app start after migration, the `ALTER TABLE channels ADD COLUMN topics TEXT DEFAULT '[]'` migration runs, and the `UPDATE channels SET topics = '["' || category || '"]' WHERE category IS NOT NULL AND category != '' AND category != '未分类'` statement converts existing non-empty, non-未分类 `category` values into single-element `topics` JSON arrays.

**VAL-CROSS-043**: After migration, a channel that had `category: "AI Theory"` and `category2: "ML"` now has `intent: "未分类"`, `topics: ["AI Theory"]`, and the original `category` / `category2` columns are preserved (not dropped), maintaining backward compatibility.

**VAL-CROSS-044**: After migration, the sidebar displays intents as the primary grouping (defaulting to showing all channels under "未分类" since no intent assignments have been made), rather than the old flat category list. The old `category`-based URL parameter (`/?category=...`) is no longer the primary navigation path.

**VAL-CROSS-045**: After migration, the `intents` table is pre-populated with the 5 default intents (工作, 娱乐, 探索, 新闻, 未分类) with their default `auto_subtitle` and `auto_summary` settings, and these appear in the sidebar in `sort_order` sequence.

**VAL-CROSS-046**: After migration, a channel that had `category: "未分类"` or `category: ""` or `category: NULL` retains `topics: "[]"` (empty array), not `topics: '["未分类"]'`, avoiding a meaningless "未分类" topic badge in the sidebar.

**VAL-CROSS-047**: After migration, the `automation_rules` table's existing rules that used `category` as a condition field continue to function—either through a compatibility shim that maps old `category` conditions to `topics` array-contains checks, or through a one-time migration that rewrites `category` conditions to `topics` conditions.

**VAL-CROSS-048**: After migration, the home page's video API (`GET /api/videos`) accepts both the new `intent` parameter and a deprecated `category` parameter (for bookmark/URL backward compat), with `category` internally mapping to a topics-contains query so that old bookmarked URLs like `/?category=AI%20Theory` still return relevant results.
