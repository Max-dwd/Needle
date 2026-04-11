# Validation Assertions: Pipeline & Automation / Markdown Export-Import / Categories API

---

## Pipeline & Automation (`VAL-PIPE-*`)

### new_video stage — intent-based fallback

- **VAL-PIPE-001**: When a `video:discovered` event fires and an enabled automation rule matches the video context, the rule's actions execute and the intent-based `auto_subtitle` fallback is NOT consulted.
- **VAL-PIPE-002**: When a `video:discovered` event fires and NO automation rule matches, the pipeline reads `channel.intent`, looks up the corresponding `intents` row, and if `auto_subtitle = 1`, the video is enqueued for subtitle fetching.
- **VAL-PIPE-003**: When a `video:discovered` event fires and NO automation rule matches, and the channel's intent has `auto_subtitle = 0`, no subtitle fetch is enqueued.
- **VAL-PIPE-004**: When a `video:discovered` event fires and the channel has `intent = '未分类'` (default), the `未分类` intent row's `auto_subtitle` value is used as the fallback (default: 0 → no subtitle fetch).

### subtitle_ready stage — intent-based fallback

- **VAL-PIPE-005**: When a `subtitle:ready` event fires and an enabled automation rule with `enqueue_summary` action matches, a `summary_task` record is created with status `pending`, and the intent-based `auto_summary` fallback is NOT consulted.
- **VAL-PIPE-006**: When a `subtitle:ready` event fires and an enabled automation rule with `skip_summary` action matches, a `summary_task` record is created with status `skipped`, and the intent-based `auto_summary` fallback is NOT consulted.
- **VAL-PIPE-007**: When a `subtitle:ready` event fires and NO automation rule matches, the pipeline reads `channel.intent`, looks up the corresponding `intents` row, and if `auto_summary = 1`, a `summary_task` with status `pending` is created.
- **VAL-PIPE-008**: When a `subtitle:ready` event fires and NO automation rule matches, and the channel's intent has `auto_summary = 0`, no summary task is created.
- **VAL-PIPE-009**: When a `subtitle:ready` event fires and the channel has `intent = '未分类'` (default), the `未分类` intent row's `auto_summary` value is used as the fallback (default: 0 → no summary task).

### Rule conditions — intent and topics fields

- **VAL-PIPE-010**: `AutomationConditionField` type union includes `'intent'` as a valid field value (in addition to existing `platform`, `channel_id`, `title`, `duration`).
- **VAL-PIPE-011**: `AutomationConditionField` type union includes `'topics'` as a valid field value.
- **VAL-PIPE-012**: A rule condition with `field: 'intent'` and `op: 'eq'` performs exact case-insensitive match against `channel.intent`.
- **VAL-PIPE-013**: A rule condition with `field: 'intent'` and `op: 'in'` matches when `channel.intent` is present in the comma-separated list of values.
- **VAL-PIPE-014**: A rule condition with `field: 'topics'` and `op: 'contains'` matches when the condition value string is found within any element of the channel's `topics` JSON array.
- **VAL-PIPE-015**: A rule condition with `field: 'topics'` and `op: 'in'` matches when ANY element of the channel's `topics` array is present in the condition's value list (array-contains semantics).
- **VAL-PIPE-016**: A rule condition with `field: 'topics'` and `op: 'eq'` matches when the condition value exactly equals at least one element in the channel's `topics` array (case-insensitive).

### AutomationVideoContext adaptation

- **VAL-PIPE-017**: `AutomationVideoContext.channel` includes an `intent: string` field populated from the `channels.intent` column.
- **VAL-PIPE-018**: `AutomationVideoContext.channel` includes a `topics: string[]` field populated by parsing the `channels.topics` JSON column.
- **VAL-PIPE-019**: `loadAutomationVideoContext` SQL query JOINs `channels` and selects `c.intent` and `c.topics` (in addition to existing `c.category` and `c.category2`).
- **VAL-PIPE-020**: `getFieldValue()` in `rules.ts` returns `context.channel.intent` when `field === 'intent'`.
- **VAL-PIPE-021**: `getFieldValue()` in `rules.ts` returns a representation of `context.channel.topics` when `field === 'topics'` that enables array-based matching in `matchesCondition`.

### Backward compatibility — old category conditions

- **VAL-PIPE-022**: Existing automation rules with `field: 'category'` continue to function: `getFieldValue` for `category` still returns `[category, category2].filter(Boolean).join(',')` as before.
- **VAL-PIPE-023**: After data migration, a channel whose old `category` was `"AI"` has `topics: ["AI"]`, so a rule with `field: 'topics', op: 'eq', value: 'AI'` matches the same channels the old `field: 'category', op: 'eq', value: 'AI'` rule would have matched.
- **VAL-PIPE-024**: Disabled automation rules (`.enabled = false`) are never evaluated, regardless of whether they use old `category` or new `intent`/`topics` conditions.

### UI — AutomationRulesSettings condition fields

- **VAL-PIPE-025**: The `fieldOptions` array in `AutomationRulesSettings.tsx` includes `{ value: 'intent', label: '意图' }` (or Chinese equivalent for intent).
- **VAL-PIPE-026**: The `fieldOptions` array in `AutomationRulesSettings.tsx` includes `{ value: 'topics', label: '主题标签' }` (or Chinese equivalent for topics).
- **VAL-PIPE-027**: When a user selects `intent` as a condition field, the value input accepts a single text string (free text or autocomplete from existing intents).
- **VAL-PIPE-028**: When a user selects `topics` as a condition field with `op: 'in'`, the value input accepts comma-separated topic strings.
- **VAL-PIPE-029**: The old `{ value: 'category', label: '频道分类' }` option is either removed from `fieldOptions` or kept for backward compatibility with a deprecation note — existing rules with `category` conditions remain editable.

### Pipeline execution ordering

- **VAL-PIPE-030**: In `processAutomationStage`, rules are sorted by `priority ASC, id ASC` before execution, ensuring deterministic ordering.
- **VAL-PIPE-031**: If multiple rules match at the same stage, ALL matched rules execute their actions (not just the first), maintaining existing behavior.
- **VAL-PIPE-032**: The intent fallback logic only runs when `getMatchingRulesForStage` returns an empty array (zero matched rules), not when rules match but have no relevant action type.

### Edge cases

- **VAL-PIPE-033**: If a channel's `intent` value references a non-existent intent name (e.g., deleted intent), the fallback treats `auto_subtitle` and `auto_summary` as `0` (safe default — no automatic processing).
- **VAL-PIPE-034**: If a channel has `topics: []` (empty array), a rule with `field: 'topics'` never matches for that channel (no false positives).
- **VAL-PIPE-035**: If a channel has `intent: null` or `intent: ''`, it is treated as `'未分类'` for intent fallback purposes.

---

## Markdown Export/Import (`VAL-MD-*`)

### New export format

- **VAL-MD-001**: `exportChannelsToMarkdown` produces a document starting with `# Needle Subscriptions`.
- **VAL-MD-002**: Each unique intent value among the exported channels produces a `## <intent>` heading (e.g., `## 工作`, `## 娱乐`).
- **VAL-MD-003**: Intent headings are ordered by `intents.sort_order` (not alphabetically).
- **VAL-MD-004**: Under each intent heading, channels are listed as markdown list items: `- [ChannelName](url) \`platform:channel_id\` #topic1 #topic2`.
- **VAL-MD-005**: Each topic in the channel's `topics` array is rendered as `#topicName` (hash-prefixed, no space between hash and name) appended after the backtick-enclosed platform:channel_id.
- **VAL-MD-006**: Channels with `topics: []` (empty) produce list items with no `#tag` suffixes.
- **VAL-MD-007**: Channels with `intent = '未分类'` are grouped under a `## 未分类` heading, which appears last.
- **VAL-MD-008**: The backtick-enclosed identifier format is `\`youtube:UCxxxxxx\`` or `\`bilibili:123456\``.
- **VAL-MD-009**: YouTube channel URLs are formatted as `https://www.youtube.com/channel/<channel_id>`.
- **VAL-MD-010**: Bilibili channel URLs are formatted as `https://space.bilibili.com/<channel_id>`.
- **VAL-MD-011**: Channel names containing markdown special characters (`[]()` etc.) are properly escaped.

### New import format — parsing

- **VAL-MD-012**: `importChannelsFromMarkdown` given the new format correctly identifies `## 工作` as `intent = '工作'` for all channels listed under it.
- **VAL-MD-013**: `importChannelsFromMarkdown` parses `#AI #前端` at the end of a list item as `topics: ['AI', '前端']`.
- **VAL-MD-014**: `importChannelsFromMarkdown` parses the backtick-enclosed `\`youtube:UCxxxxxx\`` to extract `platform: 'youtube'` and `channel_id: 'UCxxxxxx'` without any network resolution call.
- **VAL-MD-015**: `importChannelsFromMarkdown` parses the backtick-enclosed `\`bilibili:123456\`` to extract `platform: 'bilibili'` and `channel_id: '123456'` without any network resolution call.
- **VAL-MD-016**: The returned `ParsedChannelImport` (or its new equivalent) includes `intent: string` and `topics: string[]` fields.
- **VAL-MD-017**: When a channel line has no `#tag` suffixes, `topics` is `[]`.
- **VAL-MD-018**: When a channel line has no backtick-encoded platform:id, the importer falls back to URL-based resolution (existing behavior for backward compatibility).

### Old format — backward compatibility

- **VAL-MD-019**: Given old-format markdown with `## YouTube` / `## Bilibili` as top-level headings and nested bullet indentation for categories, `importChannelsFromMarkdown` successfully parses all channels.
- **VAL-MD-020**: In old-format import, the platform heading (`YouTube` / `Bilibili`) is recognized as platform context, NOT as an intent value.
- **VAL-MD-021**: In old-format import, nested category bullets (indented list items that are not links) are mapped to `topics` array (first category → first topic).
- **VAL-MD-022**: In old-format import, the `intent` field for all imported channels defaults to `'未分类'` (since old format has no intent information).
- **VAL-MD-023**: In old-format import, `category2` (sub-category) values are preserved as additional topics entries if present.

### Round-trip integrity

- **VAL-MD-024**: Exporting channels, then importing the exported markdown, produces `ParsedChannelImport` entries where each channel's `intent` matches the original `channel.intent`.
- **VAL-MD-025**: Round-trip preserves each channel's `topics` array (order-independent set equality).
- **VAL-MD-026**: Round-trip preserves `platform` and `channel_id` for every channel.
- **VAL-MD-027**: Round-trip preserves channel `name` (modulo markdown escaping/unescaping).
- **VAL-MD-028**: Duplicate channels (same `platform:channel_id` appearing under different intents in malformed input) are deduplicated — last occurrence wins, matching existing behavior.

### Edge cases

- **VAL-MD-029**: A topic containing a space (e.g., `"machine learning"`) is exported as `#machine-learning` (or an escaped form) and correctly round-tripped.
- **VAL-MD-030**: A topic containing a `#` character is properly escaped/handled in export to avoid ambiguity.
- **VAL-MD-031**: An intent name containing markdown special characters (e.g., brackets) is properly escaped in the `##` heading.
- **VAL-MD-032**: An empty channel list (no channels) produces a minimal valid markdown document (just the title).
- **VAL-MD-033**: Mixed new-format and old-format sections in a single document — the parser handles gracefully (format detection is per-document, not per-section; mixed input may produce best-effort results).

---

## Categories API (`VAL-CAT-*`)

### Response shape transformation

- **VAL-CAT-001**: `GET /api/channels/categories` response JSON includes an `intents` array, where each element has `{ name: string, count: number }` representing the intent and its associated video count.
- **VAL-CAT-002**: `GET /api/channels/categories` response JSON includes a `topics` array, where each element has `{ name: string, count: number }` representing the topic and its associated video count.
- **VAL-CAT-003**: The `intents` array is ordered by video count descending (or by `intents.sort_order` — design decision), then by name ascending as tiebreaker.
- **VAL-CAT-004**: The `topics` array is ordered by video count descending, then by name ascending as tiebreaker.
- **VAL-CAT-005**: The `intents` array includes ALL intents from the `intents` table, even those with zero channels/videos (so the sidebar can show empty intent groups).
- **VAL-CAT-006**: The `topics` array only includes topics that have at least one channel using them (no phantom/empty topics).

### Query logic

- **VAL-CAT-007**: Intent counts are computed by: `SELECT c.intent, COUNT(v.id) FROM channels c LEFT JOIN videos v ON v.channel_id = c.id GROUP BY c.intent`.
- **VAL-CAT-008**: Topic counts are computed by extracting values from `json_each(c.topics)` and counting associated videos: channels with `topics = '[]'` contribute zero topic entries.
- **VAL-CAT-009**: A channel with `topics: ["AI", "前端"]` contributes to both the `"AI"` and `"前端"` topic counts.
- **VAL-CAT-010**: A channel with `intent: '工作'` and 5 videos contributes 5 to the `工作` intent count.

### Backward compatibility

- **VAL-CAT-011**: If the old response shape `{ categories: [...] }` is consumed by existing UI code, either the old key is preserved alongside new keys (e.g., `{ categories, intents, topics }`) OR all consuming UI code is updated simultaneously.
- **VAL-CAT-012**: The old `categories` query (combining `category` and `category2` columns) is either removed or kept as a deprecated fallback — no dual counting between old categories and new topics.

### Edge cases

- **VAL-CAT-013**: Channels with `intent = NULL` or `intent = ''` are counted under `'未分类'` in the intents aggregation.
- **VAL-CAT-014**: Channels with `topics = NULL` or `topics = '[]'` or `topics = ''` contribute zero topic entries.
- **VAL-CAT-015**: Topics with mixed case (e.g., `"AI"` vs `"ai"`) are treated as distinct entries (case-sensitive) unless explicit normalization is applied.
- **VAL-CAT-016**: The endpoint returns HTTP 200 with empty arrays `{ intents: [], topics: [] }` when no channels exist in the database.
- **VAL-CAT-017**: The endpoint handles malformed `topics` JSON gracefully (e.g., a channel with `topics = 'not-json'`) — it skips that channel's topics without crashing the entire response.
