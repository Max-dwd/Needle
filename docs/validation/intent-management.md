# Intent Management — Validation Contract Assertions

Area: Intent Management Settings Page (Spec §6) + Data Model (Spec §1)

---

## Data Model & Migration

### VAL-INTENT-001 — Intents table created on first load
**Behavior:** When the application starts with a fresh database (no `intents` table), the migration creates the `intents` table with columns `id`, `name`, `auto_subtitle`, `auto_summary`, `sort_order`, `created_at`.
**Pass condition:** `SELECT * FROM intents` returns rows; all five default intents (工作, 娱乐, 探索, 新闻, 未分类) are present with correct `auto_subtitle`, `auto_summary`, and `sort_order` values matching the spec defaults.
**Evidence:** Database query output or console log showing migration ran; screenshot of settings page listing all five defaults.

### VAL-INTENT-002 — Default intent data matches spec
**Behavior:** On a fresh database, the default intents are seeded exactly as:
| name | auto_subtitle | auto_summary | sort_order |
|------|:---:|:---:|:---:|
| 工作 | 1 | 1 | 0 |
| 娱乐 | 0 | 0 | 1 |
| 探索 | 1 | 0 | 2 |
| 新闻 | 1 | 1 | 3 |
| 未分类 | 0 | 0 | 99 |
**Pass condition:** Every row matches the table above exactly.
**Evidence:** SQL query result or API response from `GET /api/settings/intents`.

### VAL-INTENT-003 — Channels table gains intent and topics columns
**Behavior:** After migration, `channels` table has `intent TEXT DEFAULT '未分类'` and `topics TEXT DEFAULT '[]'` columns.
**Pass condition:** Existing channels have `intent = '未分类'` and `topics = '[]'` (or a migrated value); new channels inserted without explicit values receive these defaults.
**Evidence:** SQL `PRAGMA table_info(channels)` output; sample row query.

### VAL-INTENT-004 — Legacy category values migrate to topics
**Behavior:** Channels with a non-empty, non-`'未分类'` `category` value get their `topics` set to a JSON array containing that category string (e.g., `category = 'AI'` → `topics = '["AI"]'`).
**Pass condition:** For every channel where the old `category` was non-null and non-empty and not `'未分类'`, `topics` is a valid JSON array containing exactly that value.
**Evidence:** SQL query comparing `category` and `topics` columns pre/post migration.

### VAL-INTENT-005 — Migration is idempotent
**Behavior:** Running the migration logic a second time (e.g., server restart) does not duplicate default intents or corrupt existing data.
**Pass condition:** After two restarts, `SELECT count(*) FROM intents` still returns 5 (assuming no user additions); channel data is unchanged.
**Evidence:** Database row counts before and after restart.

---

## Settings Page — Intent Listing

### VAL-INTENT-010 — Settings page displays intent management section
**Behavior:** Navigating to `/settings` shows an "意图管理" (Intent Management) section with a table listing all intents.
**Pass condition:** The section heading is visible; each intent row shows: name, auto_subtitle toggle, auto_summary toggle, sort controls, and action buttons.
**Evidence:** Screenshot of `/settings` page with intent table visible.

### VAL-INTENT-011 — Intents displayed in sort_order
**Behavior:** The intent table rows are ordered by `sort_order` ascending.
**Pass condition:** Default order is 工作 → 娱乐 → 探索 → 新闻 → 未分类 (未分类 last at sort_order 99).
**Evidence:** Screenshot showing correct order; network response from `GET /api/settings/intents` confirming ordering.

### VAL-INTENT-012 — Toggle states reflect database values
**Behavior:** Each intent row shows the `auto_subtitle` and `auto_summary` switches in their correct on/off state as stored in the database.
**Pass condition:** 工作 shows both toggles ON; 娱乐 shows both OFF; 探索 shows subtitle ON and summary OFF; 新闻 shows both ON; 未分类 shows both OFF.
**Evidence:** Screenshot of intent table with toggle states visible; cross-reference with `GET /api/settings/intents` response.

---

## Creating a New Intent

### VAL-INTENT-020 — Create intent with valid name
**Behavior:** User clicks "Add Intent" (or equivalent), enters a name (e.g., "学习") and selects auto_subtitle/auto_summary defaults, then confirms. A new row appears in the table and is persisted.
**Pass condition:** `POST /api/settings/intents` returns 200/201 with the new intent data; the table re-renders with the new entry; `GET /api/settings/intents` includes it; database row exists.
**Evidence:** Network call log showing POST request/response; screenshot of updated table; console free of errors.

### VAL-INTENT-021 — New intent gets correct sort_order
**Behavior:** A newly created intent receives a `sort_order` that places it before 未分类 but after the last user-defined intent.
**Pass condition:** The new intent's `sort_order` is less than 99 (未分类) and the intent appears above 未分类 in the list.
**Evidence:** API response showing `sort_order`; screenshot confirming position.

### VAL-INTENT-022 — Duplicate name is rejected
**Behavior:** User attempts to create an intent with a name that already exists (e.g., "工作").
**Pass condition:** The API returns an error (4xx status); the UI displays a user-visible error message (e.g., "意图名称已存在"); no duplicate row is created in the database.
**Evidence:** Network call showing error response; screenshot of error message; `SELECT count(*) FROM intents WHERE name = '工作'` returns 1.

### VAL-INTENT-023 — Empty name is rejected
**Behavior:** User attempts to create an intent with an empty string or whitespace-only name.
**Pass condition:** The submit button is disabled or the API returns a validation error (4xx); no row is created.
**Evidence:** Screenshot showing disabled button or error message; network call log if request was sent; database unchanged.

### VAL-INTENT-024 — Create intent with auto_subtitle ON and auto_summary OFF
**Behavior:** User creates a new intent with auto_subtitle enabled and auto_summary disabled.
**Pass condition:** The created intent row in the database has `auto_subtitle = 1` and `auto_summary = 0`; the UI reflects these settings.
**Evidence:** API response body; screenshot of new row with correct toggles.

### VAL-INTENT-025 — Create intent with both toggles OFF
**Behavior:** User creates a new intent with both auto_subtitle and auto_summary disabled.
**Pass condition:** Database row has `auto_subtitle = 0` and `auto_summary = 0`.
**Evidence:** API response; database query.

### VAL-INTENT-026 — Create intent with both toggles ON
**Behavior:** User creates a new intent with both auto_subtitle and auto_summary enabled.
**Pass condition:** Database row has `auto_subtitle = 1` and `auto_summary = 1`.
**Evidence:** API response; database query.

---

## Editing an Intent

### VAL-INTENT-030 — Rename an intent
**Behavior:** User clicks edit on "探索", changes name to "研究", confirms.
**Pass condition:** `PATCH /api/settings/intents/:id` returns success; the table shows "研究" instead of "探索"; all channels previously assigned `intent = '探索'` now show `intent = '研究'` (soft reference update).
**Evidence:** Network call log; screenshot of updated row; SQL query `SELECT count(*) FROM channels WHERE intent = '研究'` matches previous count for '探索'.

### VAL-INTENT-031 — Toggle auto_subtitle ON→OFF
**Behavior:** User toggles auto_subtitle switch from ON to OFF on "工作" intent.
**Pass condition:** `PATCH /api/settings/intents/:id` succeeds with `{ auto_subtitle: 0 }`; the switch visually flips to OFF; database value is `0`.
**Evidence:** Network call with request body; screenshot; database query.

### VAL-INTENT-032 — Toggle auto_summary OFF→ON
**Behavior:** User toggles auto_summary switch from OFF to ON on "娱乐" intent.
**Pass condition:** `PATCH /api/settings/intents/:id` succeeds with `{ auto_summary: 1 }`; the switch visually flips to ON; database value is `1`.
**Evidence:** Network call with request body; screenshot; database query.

### VAL-INTENT-033 — Edit 未分类 strategy toggles
**Behavior:** User edits 未分类 to enable auto_subtitle.
**Pass condition:** PATCH succeeds; 未分类 row shows auto_subtitle ON; the intent is not deleted or removed.
**Evidence:** Network call; screenshot; database query confirming `auto_subtitle = 1` for 未分类.

### VAL-INTENT-034 — Rename to duplicate name is rejected
**Behavior:** User tries to rename "娱乐" to "工作" (an existing name).
**Pass condition:** API returns error (4xx); the intent name remains "娱乐" in the UI; no database change.
**Evidence:** Network error response; screenshot showing original name preserved; console-errors absent or showing handled validation.

### VAL-INTENT-035 — Rename to empty string is rejected
**Behavior:** User clears the name field during edit and tries to save.
**Pass condition:** Validation prevents the save — either the confirm button is disabled or the API returns an error; the original name is preserved.
**Evidence:** Screenshot of validation state; network call if attempted.

### VAL-INTENT-036 — Edit preserves sort_order
**Behavior:** User renames an intent without touching sort controls.
**Pass condition:** After PATCH, the intent's `sort_order` is unchanged; the intent's position in the table/sidebar does not shift.
**Evidence:** API response showing unchanged `sort_order`; screenshot of list order.

### VAL-INTENT-037 — Rename 未分类 is allowed
**Behavior:** User renames 未分类 to a custom name (e.g., "其他").
**Pass condition:** PATCH succeeds; the intent name updates to "其他" in the database and UI; channels previously pointing to '未分类' are updated to '其他'. The intent retains its role as the fallback/non-deletable intent.
**Evidence:** Network call; database query; screenshot.

---

## Deleting an Intent

### VAL-INTENT-040 — Delete intent shows confirmation dialog
**Behavior:** User clicks the delete button on "娱乐" intent.
**Pass condition:** A confirmation dialog/prompt appears before the deletion is executed; no immediate DELETE network call fires until confirmed.
**Evidence:** Screenshot of confirmation dialog; network log showing no premature DELETE request.

### VAL-INTENT-041 — Confirm delete removes intent
**Behavior:** User confirms deletion of "娱乐".
**Pass condition:** `DELETE /api/settings/intents/:id` returns success; the "娱乐" row disappears from the table; `GET /api/settings/intents` no longer includes it.
**Evidence:** Network call log; screenshot of table without "娱乐"; database query `SELECT * FROM intents WHERE name = '娱乐'` returns 0 rows.

### VAL-INTENT-042 — Channels fallback to 未分类 on intent deletion
**Behavior:** Channels assigned to the deleted "娱乐" intent are reassigned to "未分类".
**Pass condition:** After deletion, `SELECT count(*) FROM channels WHERE intent = '娱乐'` returns 0; those channels now have `intent = '未分类'` (or whatever the fallback intent's current name is).
**Evidence:** Database queries before and after deletion; channel list UI showing affected channels under 未分类.

### VAL-INTENT-043 — Cancel delete preserves intent
**Behavior:** User clicks delete on "探索" then cancels the confirmation.
**Pass condition:** No DELETE request is sent; the intent remains in the table unchanged.
**Evidence:** Network log showing no DELETE call; screenshot of intent still present.

### VAL-INTENT-044 — 未分类 cannot be deleted
**Behavior:** The 未分类 intent row does not display a delete button (or the delete button is disabled/hidden).
**Pass condition:** No mechanism exists in the UI to initiate deletion of 未分类; if forced via API (`DELETE /api/settings/intents/:id` for 未分类), the API returns an error (4xx/403).
**Evidence:** Screenshot showing missing/disabled delete button on 未分类 row; API error response if directly called.

### VAL-INTENT-045 — Deleting intent updates sidebar immediately
**Behavior:** After deleting an intent, the sidebar no longer shows the deleted intent as a navigation group.
**Pass condition:** Sidebar refreshes or reactively removes the deleted intent group; channels previously in that group appear under 未分类 in the sidebar.
**Evidence:** Screenshot of sidebar before and after deletion.

### VAL-INTENT-046 — Delete intent with zero channels
**Behavior:** User deletes an intent that has no channels assigned.
**Pass condition:** Deletion succeeds without error; no channel reassignment needed; intent is removed from list.
**Evidence:** Network call success; database confirmation.

---

## Reordering Intents

### VAL-INTENT-050 — Move intent up
**Behavior:** User clicks the "↑" button on "探索" (sort_order 2).
**Pass condition:** "探索" swaps position with the intent above it ("娱乐"); `POST /api/settings/intents/reorder` is called; the table re-renders with 探索 above 娱乐.
**Evidence:** Network call with updated sort_order array; screenshot of new order; database query confirming updated sort_order values.

### VAL-INTENT-051 — Move intent down
**Behavior:** User clicks the "↓" button on "工作" (sort_order 0).
**Pass condition:** "工作" swaps position with the intent below it ("娱乐"); reorder API is called; table shows 娱乐 → 工作 → 探索 → 新闻 → 未分类.
**Evidence:** Network call; screenshot; database query.

### VAL-INTENT-052 — First intent has no "up" action
**Behavior:** The topmost intent (工作, sort_order 0) either has no "↑" button or the button is disabled.
**Pass condition:** Clicking/attempting to move up does nothing; no API call is made.
**Evidence:** Screenshot showing disabled/missing up arrow on first row.

### VAL-INTENT-053 — Last user intent has no "down" action (before 未分类)
**Behavior:** The last intent before 未分類 (新闻 by default) either has no "↓" button or the button is disabled — 未分类 is always fixed at the bottom.
**Pass condition:** Clicking/attempting to move the last user intent down does nothing; 未分类 remains at the bottom.
**Evidence:** Screenshot showing disabled/missing down arrow on the row above 未分類.

### VAL-INTENT-054 — 未分类 has no reorder controls
**Behavior:** The 未分类 row does not display "↑" or "↓" buttons.
**Pass condition:** No sort controls are rendered for 未分類 (spec shows "—" in the sort column).
**Evidence:** Screenshot of 未分類 row with no sort buttons.

### VAL-INTENT-055 — Reorder persists across page reload
**Behavior:** After reordering intents, refreshing the `/settings` page shows the updated order.
**Pass condition:** After reload, `GET /api/settings/intents` returns intents in the reordered sort_order; the table matches the pre-reload state.
**Evidence:** Network response after reload; screenshot comparison.

### VAL-INTENT-056 — Reorder reflects in sidebar
**Behavior:** After reordering intents on the settings page, the sidebar intent groups update to match the new order.
**Pass condition:** Sidebar groups are ordered by the updated `sort_order` values.
**Evidence:** Screenshot of sidebar showing new group order matching settings page order.

---

## API Contract

### VAL-INTENT-060 — GET /api/settings/intents returns all intents ordered
**Behavior:** `GET /api/settings/intents` returns an array of intent objects sorted by `sort_order` ascending.
**Pass condition:** Response is JSON array; each object has `id`, `name`, `auto_subtitle`, `auto_summary`, `sort_order`, `created_at`; order matches `sort_order`.
**Evidence:** Network response body; status 200.

### VAL-INTENT-061 — POST /api/settings/intents creates intent
**Behavior:** `POST /api/settings/intents` with body `{ "name": "学习", "auto_subtitle": 1, "auto_summary": 0 }` creates a new intent.
**Pass condition:** Response status 200/201; response body includes the new intent with a generated `id` and `sort_order`; subsequent GET includes it.
**Evidence:** Network request/response pair.

### VAL-INTENT-062 — PATCH /api/settings/intents/:id updates intent
**Behavior:** `PATCH /api/settings/intents/:id` with partial body (e.g., `{ "name": "新名称" }`) updates only the specified fields.
**Pass condition:** Response status 200; only the provided fields change; other fields remain the same.
**Evidence:** Network request/response; database before/after comparison.

### VAL-INTENT-063 — DELETE /api/settings/intents/:id removes intent and reassigns channels
**Behavior:** `DELETE /api/settings/intents/:id` (for a non-未分类 intent) removes the intent and reassigns channels.
**Pass condition:** Response status 200; intent no longer in GET response; channels formerly in that intent now have `intent = '未分类'`.
**Evidence:** Network response; follow-up GET; database channel query.

### VAL-INTENT-064 — POST /api/settings/intents/reorder updates sort_order
**Behavior:** `POST /api/settings/intents/reorder` with a body specifying new order (e.g., `{ "ids": [3, 1, 2, 4] }`) updates all sort_order values.
**Pass condition:** Response status 200; subsequent GET returns intents in the new order.
**Evidence:** Network request/response; follow-up GET.

### VAL-INTENT-065 — API rejects invalid intent creation (missing name)
**Behavior:** `POST /api/settings/intents` with empty body or `{ "name": "" }`.
**Pass condition:** Response status 400; error message indicates name is required.
**Evidence:** Network response with error body.

### VAL-INTENT-066 — API rejects deletion of 未分類
**Behavior:** `DELETE /api/settings/intents/:id` targeting the 未分類 intent's id.
**Pass condition:** Response status 400 or 403; error message indicates this intent cannot be deleted; intent remains in database.
**Evidence:** Network response; database unchanged.

---

## Edge Cases & Error Handling

### VAL-INTENT-070 — Name with leading/trailing whitespace is trimmed
**Behavior:** User creates an intent with name "  学习  " (spaces around).
**Pass condition:** The stored name is "学习" (trimmed); the UI displays the trimmed name; no duplicate check is bypassed by whitespace differences.
**Evidence:** API response body; database query.

### VAL-INTENT-071 — Very long intent name is handled gracefully
**Behavior:** User enters a name with 100+ characters.
**Pass condition:** Either the input is truncated/rejected with an error, or it saves but the UI renders it without layout breakage (overflow handled).
**Evidence:** Screenshot of table row with long name; no horizontal overflow or clipped content without indication.

### VAL-INTENT-072 — Concurrent creation of same name
**Behavior:** Two simultaneous POST requests try to create an intent with the same name.
**Pass condition:** One succeeds and one fails with a duplicate error (UNIQUE constraint on `name`); no duplicate rows exist.
**Evidence:** Both network responses (one success, one error); database `SELECT count(*)` for that name = 1.

### VAL-INTENT-073 — Delete intent that was just renamed
**Behavior:** User renames "探索" to "研究" then immediately deletes "研究".
**Pass condition:** Deletion succeeds; channels that had been reassigned to "研究" fall back to "未分类".
**Evidence:** Network calls in sequence; database state.

### VAL-INTENT-074 — Special characters in intent name
**Behavior:** User creates an intent with name containing special characters (e.g., "工作 & 学习", "AI/ML", "频道<测试>").
**Pass condition:** Name is stored correctly (no SQL injection, no XSS); displayed in UI without rendering artifacts; HTML entities are properly escaped in the DOM.
**Evidence:** Database value; screenshot; DOM inspection showing escaped content.

### VAL-INTENT-075 — No console errors during intent CRUD operations
**Behavior:** User performs a full CRUD cycle: list intents → create → edit → reorder → delete.
**Pass condition:** Browser console shows zero JavaScript errors throughout the entire flow.
**Evidence:** Console screenshot at end of flow showing no errors.

### VAL-INTENT-076 — Network failure during intent creation shows error
**Behavior:** If the POST request to create an intent fails (network error or 500), the UI displays an error message.
**Pass condition:** An error toast/banner/message is visible to the user; the intent is not added to the list; no stale UI state.
**Evidence:** Simulated failure; screenshot of error message.

### VAL-INTENT-077 — Network failure during intent deletion shows error
**Behavior:** If the DELETE request fails, the intent remains in the list and an error message is shown.
**Pass condition:** The intent row is not removed; user sees an error notification; data is consistent.
**Evidence:** Simulated failure; screenshot.

### VAL-INTENT-078 — Rapid toggle of auto_subtitle switch
**Behavior:** User rapidly clicks the auto_subtitle toggle multiple times in quick succession.
**Pass condition:** The final state is consistent — the UI toggle and database value match. No race condition leaves them out of sync. Ideally, requests are debounced or the latest state wins.
**Evidence:** Final toggle state in UI; database query; network log showing request(s).

### VAL-INTENT-079 — Creating intent after deleting all custom intents
**Behavior:** User deletes all custom intents (工作, 娱乐, 探索, 新闻) leaving only 未分类, then creates a new intent.
**Pass condition:** Creation succeeds; the new intent appears above 未分類 with appropriate sort_order; sidebar shows the new group.
**Evidence:** Network calls; screenshot of table and sidebar.

### VAL-INTENT-080 — Unicode emoji in intent name
**Behavior:** User creates an intent with emoji in the name (e.g., "🎮 游戏").
**Pass condition:** Name stores and displays correctly including the emoji; no encoding issues; sidebar renders it properly.
**Evidence:** Database value; screenshot of settings table and sidebar.
