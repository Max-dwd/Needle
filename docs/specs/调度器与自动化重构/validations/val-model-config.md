# Validation Assertions: Dual Model Config (01-dual-model-config)

---

## A. Config Data Model & Migration

### VAL-MODEL-001: Config version upgrades from 2 to 3 on first load
When an existing user has `AiSummaryConfigDocument` with `version: 2` stored in `app_settings`, loading the config via `normalizeConfigDocument` must produce a document with `version: 3`.
**Evidence:** Read the `ai_summary_config` key from `app_settings` after triggering any AI settings read (e.g. `GET /api/settings/ai-summary/`). The returned JSON `version` field must be `3`.

### VAL-MODEL-002: Migration sets autoDefaultModelId to defaultModelId value
When migrating from version 2, the new `autoDefaultModelId` field must be initialized to the same value as the existing `defaultModelId`.
**Evidence:** Given a version 2 config with `defaultModelId: "model-strong"`, after migration, `GET /api/settings/ai-summary/` must return `autoDefaultModelId: "model-strong"`.

### VAL-MODEL-003: Fresh install creates version 3 config with both model IDs
A brand-new database with no stored config must produce a version 3 document where both `defaultModelId` and `autoDefaultModelId` point to the same default model (e.g. `"default"`).
**Evidence:** On a clean DB, `GET /api/settings/ai-summary/` must return both `defaultModelId` and `autoDefaultModelId` with valid, equal values.

### VAL-MODEL-004: specialRules field preserved but ignored in resolution
During migration from version 2, the existing `specialRules` array is preserved in the config document but does NOT influence model resolution when `triggerSource` is provided.
**Evidence:** Configure a specialRule mapping channelId→modelId. Trigger manual summary for a video on that channel with `triggerSource: 'manual'`. The resolved model must come from `defaultModelId`, not from the specialRule.

### VAL-MODEL-005: Config round-trip preserves autoDefaultModelId
Saving config via `POST /api/settings/ai-summary/` with `autoDefaultModelId: "model-fast"` and then reading via `GET /api/settings/ai-summary/` returns `autoDefaultModelId: "model-fast"`.
**Evidence:** Network response of GET after POST must contain the exact `autoDefaultModelId` value that was set.

---

## B. AI Settings API

### VAL-MODEL-006: GET /api/settings/ai-summary returns autoDefaultModelId field
The GET response must include the `autoDefaultModelId` field alongside `defaultModelId`.
**Evidence:** Inspect the JSON response body; both `defaultModelId` and `autoDefaultModelId` keys must be present.

### VAL-MODEL-007: POST /api/settings/ai-summary accepts autoDefaultModelId
Sending `{ "autoDefaultModelId": "model-fast" }` in the POST body must update the stored config's `autoDefaultModelId`.
**Evidence:** After POST, subsequent GET returns `autoDefaultModelId: "model-fast"`.

### VAL-MODEL-008: Setting autoDefaultModelId to non-existent model ID is handled gracefully
If `autoDefaultModelId` is set to an ID not present in `models[]`, resolution must fall through to `defaultModelId` (fallback).
**Evidence:** Set `autoDefaultModelId: "nonexistent"`, trigger auto summary. The resolved model source should be `'fallback'` (using `defaultModelId`).

### VAL-MODEL-009: Updating defaultModelId does not change autoDefaultModelId
Changing `defaultModelId` via POST must not implicitly alter `autoDefaultModelId`.
**Evidence:** Set `defaultModelId: "model-a"` and `autoDefaultModelId: "model-b"`. Then POST only `{ "defaultModelId": "model-c" }`. GET must still return `autoDefaultModelId: "model-b"`.

### VAL-MODEL-010: Deleting a model referenced by autoDefaultModelId triggers fallback
If a model ID used as `autoDefaultModelId` is removed from the `models[]` array, auto summary resolution must fall through to `defaultModelId`.
**Evidence:** Remove model "model-fast" from `models[]` while `autoDefaultModelId: "model-fast"`. Auto summary resolution returns `source: 'fallback'`.

---

## C. Intent Model Override (Database)

### VAL-MODEL-011: intents table has auto_summary_model_id column
After schema initialization, the `intents` table must include an `auto_summary_model_id TEXT DEFAULT NULL` column.
**Evidence:** Run `PRAGMA table_info(intents)` and verify the column exists with type TEXT and default NULL.

### VAL-MODEL-012: New intents have auto_summary_model_id = NULL by default
Creating a new intent via `POST /api/settings/intents/` must result in `auto_summary_model_id: null`.
**Evidence:** POST to create intent, then GET the intent; `auto_summary_model_id` must be `null`.

### VAL-MODEL-013: PATCH /api/settings/intents/[id] accepts auto_summary_model_id
Sending `{ "auto_summary_model_id": "model-fast" }` via PATCH must update the intent row.
**Evidence:** After PATCH, the response and subsequent GET must show `auto_summary_model_id: "model-fast"`.

### VAL-MODEL-014: Setting auto_summary_model_id to null clears the override
Sending `{ "auto_summary_model_id": null }` via PATCH must clear the intent model override.
**Evidence:** After PATCH with `null`, the intent's `auto_summary_model_id` field must be `null`.

### VAL-MODEL-015: Setting auto_summary_model_id to empty string clears the override
Sending `{ "auto_summary_model_id": "" }` via PATCH must also clear the intent model override (treated as null).
**Evidence:** After PATCH with `""`, the intent's `auto_summary_model_id` field must be `null`.

### VAL-MODEL-016: Deleting an intent does not affect global model config
Deleting an intent that has `auto_summary_model_id` set must not alter the global `AiSummaryConfigDocument`.
**Evidence:** Delete intent with model override. `GET /api/settings/ai-summary/` must return unchanged `autoDefaultModelId`.

### VAL-MODEL-017: Intent API response includes auto_summary_model_id
`GET /api/settings/intents/` must return each intent with an `auto_summary_model_id` field (null or string).
**Evidence:** Inspect the JSON array response; every intent object must have the `auto_summary_model_id` key.

---

## D. Model Resolution Logic (resolveSelectedModel)

### VAL-MODEL-018: Manual trigger without override uses defaultModelId
When `triggerSource = 'manual'` and no `modelIdOverride`, the resolved model must be the one matching `defaultModelId`. Source must be `'default'`.
**Evidence:** Unit test or log: `resolveSelectedModel(config, { triggerSource: 'manual' })` returns model matching `defaultModelId` with `source: 'default'`.

### VAL-MODEL-019: Manual trigger with modelIdOverride uses the override
When `triggerSource = 'manual'` and `modelIdOverride = "model-x"`, the resolved model must be "model-x". Source must be `'override'`.
**Evidence:** `resolveSelectedModel(config, { triggerSource: 'manual', modelIdOverride: 'model-x' })` returns model "model-x" with `source: 'override'`.

### VAL-MODEL-020: Auto trigger with intent model override uses intent model
When `triggerSource = 'auto'` and the intent has `auto_summary_model_id = "model-intent"`, the resolved model must be "model-intent". Source must be `'intent'`.
**Evidence:** `resolveSelectedModel(config, { triggerSource: 'auto', intentName: 'Work' })` where Work intent has model override returns `source: 'intent'`.

### VAL-MODEL-021: Auto trigger without intent override uses autoDefaultModelId
When `triggerSource = 'auto'` and the intent has `auto_summary_model_id = NULL`, the resolved model must be the one matching `autoDefaultModelId`. Source must be `'auto-default'`.
**Evidence:** `resolveSelectedModel(config, { triggerSource: 'auto', intentName: 'Work' })` where Work has no override returns model matching `autoDefaultModelId` with `source: 'auto-default'`.

### VAL-MODEL-022: Auto trigger with no intent name uses autoDefaultModelId
When `triggerSource = 'auto'` and no `intentName` is provided, resolution skips intent lookup and uses `autoDefaultModelId`. Source must be `'auto-default'`.
**Evidence:** `resolveSelectedModel(config, { triggerSource: 'auto' })` returns `source: 'auto-default'`.

### VAL-MODEL-023: Auto trigger falls through to defaultModelId when autoDefaultModelId is invalid
When `triggerSource = 'auto'`, intent has no override, and `autoDefaultModelId` references a non-existent model, resolution falls to `defaultModelId`. Source must be `'fallback'`.
**Evidence:** Set `autoDefaultModelId: "deleted-model"`. Auto resolution returns `source: 'fallback'` with model matching `defaultModelId`.

### VAL-MODEL-024: Auto trigger falls through to models[0] when both defaults are invalid
When both `autoDefaultModelId` and `defaultModelId` reference non-existent models, resolution uses `models[0]`. Source must be `'fallback'`.
**Evidence:** Set both IDs to nonexistent values. Resolution returns `models[0]` with `source: 'fallback'`.

### VAL-MODEL-025: modelIdOverride takes highest priority even for auto trigger
When `triggerSource = 'auto'` with `modelIdOverride = "model-x"`, the override model takes priority over intent model and autoDefaultModelId.
**Evidence:** `resolveSelectedModel(config, { triggerSource: 'auto', intentName: 'Work', modelIdOverride: 'model-x' })` returns "model-x" with `source: 'override'`.

### VAL-MODEL-026: Missing triggerSource defaults to manual behavior
When `triggerSource` is undefined (backward compatibility), resolution uses `defaultModelId` (manual path). Source must be `'default'`.
**Evidence:** `resolveSelectedModel(config, {})` returns model matching `defaultModelId` with `source: 'default'`.

### VAL-MODEL-027: Intent model override referencing deleted model falls through
If an intent's `auto_summary_model_id` references a model no longer in `models[]`, resolution skips it and falls to `autoDefaultModelId`.
**Evidence:** Set intent model to "deleted-model" (not in models). Auto resolution returns `source: 'auto-default'` (not `'intent'`).

---

## E. Summary Generation — Manual Path

### VAL-MODEL-028: Manual summary generation via API uses manual model
`POST /api/videos/[id]/summary/generate` without `modelId` query param must use the `defaultModelId` (manual model) and record `triggerSource: 'manual'`.
**Evidence:** Generated summary's YAML frontmatter must show `trigger_source: manual` and `model_source: default`. The `generated_model_id` must match `defaultModelId`.

### VAL-MODEL-029: Manual summary with explicit modelId override uses that model
`POST /api/videos/[id]/summary/generate?modelId=model-x` must use "model-x" regardless of default settings.
**Evidence:** Frontmatter shows `generated_model_id: model-x` and `model_source: override`.

### VAL-MODEL-030: Manual stream summary also uses manual model
`POST /api/videos/[id]/summary/generate?stream=1` (no modelId) must resolve the manual default model.
**Evidence:** SSE events and final summary frontmatter show `trigger_source: manual`.

---

## F. Summary Generation — Auto Path (Queue / Scheduler)

### VAL-MODEL-031: Auto summary queue passes triggerSource=auto
`summary-queue.ts` `runQueueLoop` must call `generateSummaryViaApi` with `{ triggerSource: 'auto', intentName: <channel's intent> }`.
**Evidence:** Code inspection or log line showing `triggerSource=auto` in the summary generation call.

### VAL-MODEL-032: Auto summary resolves intent name from channel table
For auto-triggered summaries, the queue must look up the video's channel → `intent` field and pass it as `intentName`.
**Evidence:** For a video belonging to a channel with `intent = '工作'`, auto summary resolution receives `intentName: '工作'`.

### VAL-MODEL-033: Auto summary uses intent-specific model when configured
If the channel's intent has `auto_summary_model_id = "model-cheap"`, auto summary must use "model-cheap".
**Evidence:** Frontmatter shows `generated_model_id: model-cheap`, `model_source: intent`, `trigger_source: auto`.

### VAL-MODEL-034: Auto summary uses global auto model when intent has no override
If the channel's intent has `auto_summary_model_id = NULL`, auto summary uses `autoDefaultModelId`.
**Evidence:** Frontmatter shows `model_source: auto-default`, `trigger_source: auto`.

### VAL-MODEL-035: Auto summary falls back to defaultModelId when autoDefaultModelId is not set
If `autoDefaultModelId` is missing/invalid and intent has no override, auto summary falls back to `defaultModelId`.
**Evidence:** Frontmatter shows `model_source: fallback`, `trigger_source: auto`.

---

## G. Summary Frontmatter Metadata

### VAL-MODEL-036: Summary file includes trigger_source in YAML frontmatter
Every generated summary `.md` file must include a `trigger_source: manual` or `trigger_source: auto` line in the YAML frontmatter.
**Evidence:** Read the `.md` file; parse frontmatter and verify `trigger_source` key exists.

### VAL-MODEL-037: Summary file includes model_source in YAML frontmatter
Every generated summary must include `model_source` (one of: `default`, `override`, `intent`, `auto-default`, `fallback`) in the frontmatter.
**Evidence:** Read the `.md` file; parse frontmatter and verify `model_source` key exists with a valid value.

### VAL-MODEL-038: Existing summaries without trigger_source still readable
Previously generated summaries (before this feature) that lack `trigger_source` and `model_source` fields must still be readable by `readStoredVideoSummary` without errors.
**Evidence:** Load a legacy summary file. `readStoredVideoSummary` returns the payload without throwing.

---

## H. GenerateSummaryOptions Extension

### VAL-MODEL-039: GenerateSummaryOptions interface includes triggerSource
The `GenerateSummaryOptions` type must include an optional `triggerSource?: SummaryTriggerSource` field.
**Evidence:** TypeScript compilation succeeds. Code that passes `{ triggerSource: 'auto' }` compiles without error.

### VAL-MODEL-040: GenerateSummaryOptions interface includes intentName
The `GenerateSummaryOptions` type must include an optional `intentName?: string | null` field.
**Evidence:** TypeScript compilation succeeds. Code that passes `{ intentName: '工作' }` compiles without error.

### VAL-MODEL-041: generateSummaryViaApi forwards triggerSource to resolution
When called with `{ triggerSource: 'auto', intentName: '工作' }`, `generateSummaryViaApi` must pass these to `resolveAiSummaryGenerationSettings`.
**Evidence:** The resolved model matches the intent override or auto default, not the manual default.

### VAL-MODEL-042: generateSummaryStream forwards triggerSource to resolution
When called with `{ triggerSource: 'manual' }`, `generateSummaryStream` must resolve using the manual model path.
**Evidence:** The stream emits progress events with the manual default model's name/ID.

---

## I. ResolveAiSummaryGenerationOptions Extension

### VAL-MODEL-043: ResolveAiSummaryGenerationOptions includes triggerSource
The options interface must include `triggerSource?: SummaryTriggerSource`.
**Evidence:** TypeScript compilation passes with usage `resolveAiSummaryGenerationSettings({ triggerSource: 'auto' })`.

### VAL-MODEL-044: ResolveAiSummaryGenerationOptions includes intentName
The options interface must include `intentName?: string | null`.
**Evidence:** TypeScript compilation passes with usage `resolveAiSummaryGenerationSettings({ intentName: '工作' })`.

### VAL-MODEL-045: ResolvedAiSummaryGenerationSettings includes updated modelSource values
The `modelSource` type must expand to include `'intent'` | `'auto-default'` | `'fallback'` in addition to existing values.
**Evidence:** TypeScript compilation passes when assigning `modelSource: 'intent'`.

---

## J. AI Settings UI — Dual Model Dropdowns

### VAL-MODEL-046: AI settings page shows "手动总结模型" dropdown
The AI settings page must display a dropdown labeled "手动总结模型" (or equivalent) bound to `defaultModelId`.
**Evidence:** Screenshot or DOM inspection showing the labeled dropdown with model options populated from `models[]`.

### VAL-MODEL-047: AI settings page shows "自动总结模型" dropdown
The AI settings page must display a second dropdown labeled "自动总结模型" (or equivalent) bound to `autoDefaultModelId`.
**Evidence:** Screenshot or DOM inspection showing the second labeled dropdown.

### VAL-MODEL-048: Manual model dropdown reflects current defaultModelId
On page load, the manual model dropdown must show the model whose ID matches the current `defaultModelId`.
**Evidence:** The dropdown's selected value matches the `defaultModelId` from the API response.

### VAL-MODEL-049: Auto model dropdown reflects current autoDefaultModelId
On page load, the auto model dropdown must show the model whose ID matches the current `autoDefaultModelId`.
**Evidence:** The dropdown's selected value matches the `autoDefaultModelId` from the API response.

### VAL-MODEL-050: Changing manual model updates defaultModelId
Selecting a different model in the manual dropdown and saving must update `defaultModelId` in the config.
**Evidence:** After save, `GET /api/settings/ai-summary/` returns the new `defaultModelId`.

### VAL-MODEL-051: Changing auto model updates autoDefaultModelId
Selecting a different model in the auto dropdown and saving must update `autoDefaultModelId` in the config.
**Evidence:** After save, `GET /api/settings/ai-summary/` returns the new `autoDefaultModelId`.

### VAL-MODEL-052: Both dropdowns list all configured models
Both dropdowns must show all entries from the `models[]` array as selectable options.
**Evidence:** DOM inspection: both dropdowns have the same set of `<option>` elements matching `models[].name`.

### VAL-MODEL-053: specialRules UI section is removed
The AI settings page must no longer show the specialRules configuration section (channel-level model/prompt overrides).
**Evidence:** Screenshot or DOM inspection: no element for "特殊规则" or "频道覆盖" is present.

---

## K. Intent Management UI — Auto Model Selector

### VAL-MODEL-054: Intent row shows auto model selector when auto_summary is enabled
For an intent with `auto_summary = 1`, the intent management UI must display an optional "自动总结模型" dropdown.
**Evidence:** Screenshot or DOM inspection: the model selector is visible for intents with auto_summary toggled on.

### VAL-MODEL-055: Intent auto model selector is hidden when auto_summary is disabled
For an intent with `auto_summary = 0`, the model selector must not be visible.
**Evidence:** Screenshot or DOM inspection: no model dropdown for intents with auto_summary off.

### VAL-MODEL-056: Intent auto model selector has "使用全局自动模型" default option
The dropdown must include a default option like "使用全局自动模型（默认）" that maps to `auto_summary_model_id = null`.
**Evidence:** DOM inspection: first option in the dropdown is the global-default option.

### VAL-MODEL-057: Intent auto model selector lists all configured models
The dropdown must list all models from `AiSummaryConfigDocument.models[]` as options.
**Evidence:** DOM inspection: options match the model names from `GET /api/settings/ai-summary/` models array.

### VAL-MODEL-058: Selecting a specific model for an intent saves auto_summary_model_id
Choosing "model-fast" in the intent's auto model dropdown must send `PATCH /api/settings/intents/[id]` with `{ auto_summary_model_id: "model-fast" }`.
**Evidence:** Network capture: PATCH request body contains `auto_summary_model_id: "model-fast"`. Response confirms update.

### VAL-MODEL-059: Selecting "使用全局自动模型" clears auto_summary_model_id
Choosing the default option must send `PATCH` with `{ auto_summary_model_id: null }`.
**Evidence:** Network capture: PATCH body contains `auto_summary_model_id: null`. Response shows `auto_summary_model_id: null`.

### VAL-MODEL-060: Toggling auto_summary off clears the model selector visually
When toggling `auto_summary` from 1→0, the model selector should disappear. The stored `auto_summary_model_id` value is preserved (not cleared) but UI hides it.
**Evidence:** Toggle off → selector disappears. Toggle back on → selector reappears with previous value.

---

## L. Edge Cases

### VAL-MODEL-061: No models configured — resolution uses hardcoded fallback
If `models[]` is empty (should be prevented by normalization but tested defensively), resolution must return a hardcoded fallback model (`DEFAULT_AI_SUMMARY_ENDPOINT` / `DEFAULT_AI_SUMMARY_MODEL`).
**Evidence:** Unit test: `resolveSelectedModel({ models: [], defaultModelId: '', autoDefaultModelId: '' }, { triggerSource: 'auto' })` returns a valid model config.

### VAL-MODEL-062: Both defaultModelId and autoDefaultModelId reference same model
Setting both IDs to the same model must work without issues — manual and auto both use the same model.
**Evidence:** Set both to "model-a". Manual and auto resolution both return "model-a".

### VAL-MODEL-063: Concurrent config update does not corrupt version field
Two simultaneous `POST /api/settings/ai-summary/` calls must not downgrade `version` from 3 to 2.
**Evidence:** After concurrent updates, reading config shows `version: 3`.

### VAL-MODEL-064: Intent auto_summary_model_id survives intent rename
Renaming an intent via PATCH must preserve its `auto_summary_model_id` value.
**Evidence:** PATCH rename intent from "工作" to "Work". GET intent shows `auto_summary_model_id` unchanged.

### VAL-MODEL-065: Channel reassignment on intent deletion does not carry model config
When an intent with `auto_summary_model_id` is deleted and channels move to "未分类", the "未分类" intent's own `auto_summary_model_id` is not affected.
**Evidence:** Delete intent "工作" (has model override). Channels move to "未分类". "未分类" intent's `auto_summary_model_id` remains null (or whatever it was before).

### VAL-MODEL-066: Model resolution with intentName matching no intent row
If `intentName` is provided but no matching intent exists in the DB (e.g. stale data), resolution should skip intent lookup and continue to `autoDefaultModelId`.
**Evidence:** Call resolution with `intentName: "NonExistent"`. Result source is `'auto-default'`, not `'intent'`.

### VAL-MODEL-067: autoDefaultModelId field absent in stored config treated as migration
If the stored config JSON lacks `autoDefaultModelId` (pre-migration data), `normalizeConfigDocument` must synthesize it from `defaultModelId`.
**Evidence:** Manually store a config JSON without `autoDefaultModelId`. Loading it must produce `autoDefaultModelId === defaultModelId`.

---

## M. Type Safety & Compilation

### VAL-MODEL-068: TypeScript compilation passes with all new types
`npm run typecheck` must succeed with no errors related to `SummaryTriggerSource`, `autoDefaultModelId`, `auto_summary_model_id`, or the updated interfaces.
**Evidence:** `tsc --noEmit` exits with code 0.

### VAL-MODEL-069: SummaryTriggerSource type is exported and usable
The `SummaryTriggerSource = 'manual' | 'auto'` type must be exported from the relevant module and importable by other files.
**Evidence:** Importing `SummaryTriggerSource` in a test file compiles without error.

### VAL-MODEL-070: AiSummaryConfigDocument version field type is 3
The `AiSummaryConfigDocument` interface must have `version: 3` (literal type), not `version: number`.
**Evidence:** Assigning `version: 2` to an `AiSummaryConfigDocument` must produce a TypeScript error.

---

## N. Backward Compatibility

### VAL-MODEL-071: Existing callers without triggerSource still work
Code that calls `resolveAiSummaryGenerationSettings({})` or `resolveAiSummaryGenerationSettings({ channelId: 'x' })` without `triggerSource` must continue to work and default to manual behavior.
**Evidence:** All existing unit tests pass without modification (other than adding the new field to interfaces).

### VAL-MODEL-072: API response structure backward compatible for consumers
`GET /api/settings/ai-summary/` must still return all existing fields (`defaultModelId`, `models`, `promptTemplates`, etc.) in addition to the new `autoDefaultModelId`.
**Evidence:** Existing frontend code that reads `defaultModelId` from the API response continues to work.

### VAL-MODEL-073: Summary frontmatter backward compatible
The `readStoredVideoSummary` function must handle summaries both with and without `trigger_source`/`model_source` fields.
**Evidence:** Loading a pre-migration summary file does not throw. Loading a post-migration file includes the new fields.

---

## O. Lint, Test, Build

### VAL-MODEL-074: ESLint passes
`npm run lint` must pass with no errors on all modified files.
**Evidence:** Exit code 0 from lint command.

### VAL-MODEL-075: Unit tests pass
`npm run test` must pass with no failures, including any new tests for model resolution logic.
**Evidence:** Exit code 0 from vitest.

### VAL-MODEL-076: Production build succeeds
`npm run build` must complete without errors.
**Evidence:** Exit code 0 from build command.

---

**Total assertions: 76**
