# Identifier Matching Refactor Plan

> **Since then:** Direction 2 lives in `ProductionUtils.getShowDates` (matching on the schedule's
> date and identity columns, with early cutoff), and `getShowDetails` returns the matched row's full
> columns. `findScheduleRowsForPacklist` below is gone. See incremental-invalidation-plan.md.

## Summary of the Two Matching Directions

**Direction 1 — Schedule → Packlist:** Given a schedule row (Show + Client + Year), find the corresponding packlist tab(s).

**Direction 2 — Packlist → Schedule:** Given a packlist tab title (e.g. `AUSTAL 2026 SNA`), find the corresponding schedule row(s).

These two directions are currently handled by a mix of one-off code, shared helpers, and the general-purpose `findBestProjectIdentifierMatch`. The identities of the two directions are not architecturally distinguished, leading to duplicate logic, cross-year mismatches, and fragile suffix-stripping.

---

## Current Call Graph

### Direction 1 call sites (Schedule → Packlist)

| Caller                                           | What it does                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `api.js: checkPacklistExists`                    | `computeIdentifier(row.Show, row.Client, row.Year)` → `findPackListTab(identifier, tabs)`                      |
| `packlist-utils.js: getPacklists`                | `computeIdentifier(show.Show, show.Client, parseInt(show.Year))` → `findAllPackListTabsForShow(id, tabs)`      |
| `inventory-utils.js: getItemTimeline` (phase 4)  | `computeIdentifier(showRow.Show, showRow.Client, showRow.Year)` → `extractAllItemsForShow(identifier)`         |
| `inventory-utils.js: getItemsInUseForShow`       | `computeIdentifier(overlapRow.Show, overlapRow.Client, overlapRow.Year)` → `extractAllItemsForShow(overlapId)` |
| `packlist-utils.js: checkItemQuantities`         | `computeIdentifier(overlapRow.Show, overlapRow.Client, overlapRow.Year)` → `extractAllItemsForShow(otherId)`   |
| `packlist-utils.js: getItemOverlappingPacklists` | `computeIdentifier(projectRow.Show, projectRow.Client, projectRow.Year)` → `extractAllItemsForShow(projectId)` |
| `api.js: getMultipleShowsItemsSummary`           | `computeIdentifier(showRow.Show, showRow.Client, parseInt(showRow.Year))`                                      |

**Pattern:** All Direction 1 callers do the same boilerplate: call `computeIdentifier` on a row object, then pass the result into a packlist tab function. This is repeated 7 times.

### Direction 2 call sites (Packlist → Schedule)

| Caller                                                         | What it does                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `api.js: getProjectShipDate`                                   | `getProjectShipDate(projectIdentifier)` → `getShowDetails(identifier)`                      |
| `api.js: getProjectReturnDate`                                 | `getProjectReturnDate(projectIdentifier)` → `getShowDetails(identifier)`                    |
| `api.js: resolvePacklistIdentifier`                            | `findPackListTab(identifier, tabs)` — only resolves tab name, never touches schedule        |
| `packlist-utils.js: getContent`                                | `findPackListTab(projectIdentifier, tabs)` — finds the exact tab to load                    |
| `packlist-utils.js: extractAllItemsForShow`                    | `findAllPackListTabsForShow(projectIdentifier, validTabs)`                                  |
| `production-utils.js: getShowDetails`                          | Builds scheduleMap from all rows, `findBestProjectIdentifierMatch` + progressive word-strip |
| `production-utils.js: getOverlappingShows` (identifier filter) | Loops all schedule rows, `computeIdentifier` each, `findBestProjectIdentifierMatch`         |

### Shared utilities (used by both)

| Function                                                         | Location                                                      | Role                                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `findBestProjectIdentifierMatch(deps, identifier, candidates[])` | `production-utils.js`                                         | Generic string match: exact → case-insensitive → normalized → component-level (year-gated) → fuzzy (same-year-first) |
| `computeIdentifier(deps, showName, clientName, year)`            | `production-utils.js`                                         | Normalizes Show+Client+Year into canonical identifier via fuzzy index lookup                                         |
| `computeIdentifierReferenceData(deps)`                           | `production-utils.js`                                         | Gets Clients/Shows CACHE data for fuzzy matching                                                                     |
| `_parseIdentifierParts(identifier)`                              | `production-utils.js` (private)                               | Parses `"CLIENT YEAR SHOW"` → `{ client, year, show }`                                                               |
| `_normalizeId(v)`                                                | `packlist-utils.js` + `inventory-utils.js` (local duplicates) | Strips non-alphanumeric, uppercases — used only for self-comparison guards                                           |
| `normalizeText(v)`                                               | `production-utils.js` (private)                               | `String(v).trim()`                                                                                                   |
| `normalizeMatchKey(v)`                                           | `production-utils.js` (private)                               | Uppercase + strip non-alphanumeric                                                                                   |

---

## Root Causes of the Current Bugs

### Bug 1: Cross-year fuzzy match (`AUSTAL 2026 SNA` → `AUSTAL 2023 WORKBOAT`)

**Path:** `getShowDetails` → builds scheduleMap → calls `findBestProjectIdentifierMatch("AUSTAL 2026 SNA", allCandidates)`.

`findBestProjectIdentifierMatch` failed to match in the component-level step because "AUSTAL" was not in the Clients index (only "AUSTAL USA" was), so it could not resolve the query's client to match. It then fell through to the fuzzy fallback, which — before the recent fix — was year-agnostic and picked the wrong year.

The recent fix (same-year candidates first in fuzzy fallback) addresses this partially. However, the component-level step is still silently skipped when either the query or candidate client can't be resolved, and the progressive suffix stripping in `getShowDetails` has no year boundary: stripping `"AUSTAL 2026 SNA"` word by word eventually reaches `"AUSTAL"` and matches `"AUSTAL 2023 WORKBOAT"`.

### Bug 2: Packlist → Schedule lookup ignores year during suffix stripping

In `getShowDetails`, the suffix stripping loop:

```javascript
for (let wordCount = words.length - 1; wordCount > 0; wordCount--) {
    const shortenedIdentifier = words.slice(0, wordCount).join(' ');
    match = await deps.call(ProductionUtils.findBestProjectIdentifierMatch, shortenedIdentifier, candidates);
```

When `shortenedIdentifier` is reduced below the year token (e.g., stripping `"LOCKHEED MARTIN 2025 NGAUS MEETING ROOM"` all the way to `"LOCKHEED MARTIN"`), the year is no longer present in the query and `_parseIdentifierParts` returns null — disabling the year guard entirely.

**Fix:** Stop suffix stripping before removing the year token, or pre-filter candidates by the year extracted from the original identifier before the loop begins.

### Bug 3: `getOverlappingShows` identifier resolution is O(n × computeIdentifier)

When a filter value is an identifier string, the function loops all schedule rows and calls `computeIdentifier` on each. `computeIdentifier` calls `computeIdentifierReferenceData` internally. Although the reference data is cached, `computeIdentifier` is still called per-row with no year prefilter. There is also no year validation: if a 2025 packlist is used as a filter, the 2023 show of the same client/show name might match.

---

## Proposed Architecture

### Two new public functions in `production-utils.js`

#### `findScheduleRowsForPacklist(deps, packlistTitle, options?)`

**Direction 2. Replaces the logic currently in `getShowDetails`.**

```
Input:  packlistTitle — the packlist tab title, possibly with a suffix variant
Output: Array of matching schedule rows (sorted: exact-identifier first, then others)
        Returns empty array if no match found.
```

Algorithm:

1. Parse the packlist title to extract year: `_parseIdentifierParts(packlistTitle)` → `{ client, year, show }`. If no year found, fall back to unfiltered.
2. If the packlist has a suffix (e.g., the word after the show abbreviation), progressively strip suffix words — but **stop before stripping the year token**.
3. For each candidate form of the title (full → stripped until year is the last part that remains):
   a. **Year-filter** the schedule data to rows matching the extracted year (`row.Year === year`).
   b. Build a candidate map: `computedIdentifier → row` for only those year-matching rows.
   c. Run `findBestProjectIdentifierMatch(candidateTitle, computedCandidateIdentifiers)`.
   d. If a match is found, collect the row.
4. Return all matching rows. First row is the canonical match.

#### `findPacklistTabsForScheduleRow(deps, scheduleRow, tabs)`

**Direction 1. Replaces the repeated `computeIdentifier + findPackListTab/findAllPackListTabsForShow` boilerplate.**

```
Input:  scheduleRow — a schedule row object with Show, Client, Year (and possibly Identifier)
        tabs        — array of { title, sheetId } packlist tabs
Output: Array of matching tabs (primary first, suffix variants after)
```

Algorithm:

1. Get or reuse the row's precomputed identifier: use `row.Identifier` if present, otherwise call `computeIdentifier(row.Show, row.Client, row.Year)`.
2. Delegate to `findAllPackListTabsForShow(identifier, tabs)` which already handles primary + suffix detection.

This is a thin wrapper that removes the boilerplate `computeIdentifier` call from 7 callers.

### Shared private helpers to extract / consolidate

| Helper                   | Change                                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `_getScheduleData(deps)` | New private helper. Gets mapping + data in one call. Used by `getShowDetails` AND `getOverlappingShows` today — both re-fetch independently.                                                                                         |
| `_parseIdentifierParts`  | Already exists. Expose usage note that `year` is a string like `"2026"`.                                                                                                                                                             |
| `_normalizeId`           | The duplicate in `packlist-utils.js` and `inventory-utils.js` can be removed once both files call `normalizeMatchKey` from production-utils, or they can remain local — they are only used for self-comparison guards. Not blocking. |

---

## Detailed Change Plan

### Change 1 — Add `findScheduleRowsForPacklist` to `production-utils.js`

Replace `getShowDetails` with a proper direction-2 function.

```javascript
static async findScheduleRowsForPacklist(deps, packlistTitle) {
    if (!packlistTitle) return [];

    // Parse year from the packlist title to narrow the schedule search
    const titleParts = _parseIdentifierParts(packlistTitle);
    const targetYear = titleParts ? titleParts.year : null;

    // Load schedule data once
    const mapping = await deps.call(ProductionUtils.GetMappingFromProductionSchedule);
    const allData = await deps.call(Database.getData, 'PROD_SCHED', "Production Schedule", mapping);

    // Year-filter schedule rows (all candidates if year not parseable)
    const yearData = targetYear
        ? allData.filter(row => String(parseInt(row.Year, 10)) === targetYear)
        : allData;

    if (yearData.length === 0) return [];

    // Build identifier → row map for the year-filtered rows (keep first for duplicate shows)
    const scheduleMap = new Map();
    for (const row of yearData) {
        if (!row.Show || !row.Client || !row.Year) continue;
        const computed = await deps.call(ProductionUtils.computeIdentifier, row.Show, row.Client, row.Year);
        if (computed && !scheduleMap.has(computed)) {
            scheduleMap.set(computed, row);
        }
    }

    const candidates = Array.from(scheduleMap.keys());
    if (candidates.length === 0) return [];

    // Try matching the full title, then progressively strip suffix words
    // IMPORTANT: stop stripping once the year token would be removed
    const words = packlistTitle.trim().split(/\s+/);
    const yearIndex = words.findIndex(w => /^\d{4}$/.test(w));
    const minWords = yearIndex >= 0 ? yearIndex + 2 : 1; // must keep at least one word after year

    for (let count = words.length; count >= minWords; count--) {
        const candidate = words.slice(0, count).join(' ');
        const match = await deps.call(ProductionUtils.findBestProjectIdentifierMatch, candidate, candidates);
        if (match) {
            if (count < words.length) {
                console.log(`[production-utils] Matched suffix variant: "${packlistTitle}" -> "${match}"`);
            }
            const row = scheduleMap.get(match);
            return row ? [row] : [];
        }
    }

    return [];
}
```

### Change 2 — Update `getShowDetails` to delegate

`getShowDetails` becomes a thin wrapper:

```javascript
static async getShowDetails(deps, identifier) {
    const rows = await deps.call(ProductionUtils.findScheduleRowsForPacklist, identifier);
    const row = rows[0] ?? null;
    if (!row) return null;
    // normalize dates (existing logic unchanged)
    ...
    return row;
}
```

### Change 3 — Add `findPacklistTabsForScheduleRow` to `production-utils.js`

```javascript
static async findPacklistTabsForScheduleRow(deps, scheduleRow, tabs) {
    if (!scheduleRow || !Array.isArray(tabs)) return [];
    const identifier = scheduleRow.Identifier ||
        await deps.call(ProductionUtils.computeIdentifier, scheduleRow.Show, scheduleRow.Client, scheduleRow.Year);
    if (!identifier) return [];
    return deps.call(ProductionUtils.findAllPackListTabsForShow, identifier, tabs);
}
```

### Change 4 — Fix `getOverlappingShows` identifier resolution

The `resolveFilterValue` inner function currently loops all rows without year filtering. Replace:

```javascript
// Currently: loops all rows, computeIdentifier each one
for (const row of data) { ... computeIdentifier ... findBestProjectIdentifierMatch ... }
```

With year-pre-filtered approach:

```javascript
if (typeof value === 'string') {
    const rows = await deps.call(ProductionUtils.findScheduleRowsForPacklist, value);
    const row = rows[0] ?? null;
    if (!row) { console.warn(...); return null; }
    // ... existing ship/return date extraction logic unchanged
}
```

This eliminates the O(n × computeIdentifier) loop and correctly uses the year-aware direction-2 matching.

### Change 5 — Update Direction 1 call sites to use `findPacklistTabsForScheduleRow`

| File                                             | Current                                                           | Replace with                                                                                                                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.js: checkPacklistExists`                    | `computeIdentifier(...)` + `findPackListTab(identifier, tabs)`    | `findPacklistTabsForScheduleRow(scheduleRow, tabs)`, take `[0]`                                                                                                                        |
| `packlist-utils.js: getPacklists`                | `computeIdentifier(...)` + `findAllPackListTabsForShow(id, tabs)` | `findPacklistTabsForScheduleRow(show, tabs)`                                                                                                                                           |
| `inventory-utils.js: getItemTimeline`            | `computeIdentifier(...)` assigned to `identifier`                 | `findPacklistTabsForScheduleRow(showRow, allTabs)` returns `{ title }` for each; use `tab.title` as identifier                                                                         |
| `inventory-utils.js: getItemsInUseForShow`       | same pattern                                                      | same replacement                                                                                                                                                                       |
| `packlist-utils.js: checkItemQuantities`         | same pattern                                                      | same replacement                                                                                                                                                                       |
| `packlist-utils.js: getItemOverlappingPacklists` | same pattern                                                      | same replacement                                                                                                                                                                       |
| `api.js: getMultipleShowsItemsSummary`           | `computeIdentifier(...)`                                          | already has `Identifier` fallback; wrap into `findPacklistTabsForScheduleRow` or keep `computeIdentifier` since it then calls `extractItemsFromMultipleShows` with the identifier list |

> **Note for timeline / in-use callers:** These callers currently compute an identifier from a schedule row and then call `extractAllItemsForShow(identifier)`. After the refactor, `findPacklistTabsForScheduleRow` returns tabs directly, but `extractAllItemsForShow` still needs an identifier string to match. The cleanest path is to call `tab.title` on the primary returned tab as the identifier, since the tab title is the canonical source of truth for a packlist. The `computeIdentifier` call can remain as a fallback for rows that have no matching tab.

### Change 6 — Export new functions via `wrapMethods`

Both `findScheduleRowsForPacklist` and `findPacklistTabsForScheduleRow` need to be included in the wrapped export. They are read-only and should be cached normally (not excluded).

---

## Functions Affected Summary

| Function                         | File                  | Change type                                               |
| -------------------------------- | --------------------- | --------------------------------------------------------- |
| `getShowDetails`                 | `production-utils.js` | Delegate body to `findScheduleRowsForPacklist`            |
| `getOverlappingShows`            | `production-utils.js` | Fix identifier resolution in `resolveFilterValue`         |
| `findScheduleRowsForPacklist`    | `production-utils.js` | **New**                                                   |
| `findPacklistTabsForScheduleRow` | `production-utils.js` | **New**                                                   |
| `checkPacklistExists`            | `api.js`              | Use `findPacklistTabsForScheduleRow`                      |
| `getPacklists`                   | `packlist-utils.js`   | Use `findPacklistTabsForScheduleRow`                      |
| `checkItemQuantities`            | `packlist-utils.js`   | Use `findPacklistTabsForScheduleRow` in overlap loop      |
| `getItemOverlappingPacklists`    | `packlist-utils.js`   | Use `findPacklistTabsForScheduleRow` in overlap loop      |
| `getItemTimeline`                | `inventory-utils.js`  | Use `findPacklistTabsForScheduleRow` in show-events phase |
| `getItemsInUseForShow`           | `inventory-utils.js`  | Use `findPacklistTabsForScheduleRow` in overlap loop      |

---

## Complexities to Preserve

- **Multiple schedule rows for same show:** `findScheduleRowsForPacklist` builds its map using `if (!scheduleMap.has(computed))` — first row wins. Returns the single canonical row. Callers that need to handle multiple rows (e.g., for date calculations on multi-booth shows) can inspect the returned array.
- **Suffix variants (multiple packlists per show):** `findPacklistTabsForScheduleRow` delegates to `findAllPackListTabsForShow` which already uses the `startsWith(canonicalPrefix + ' ')` pattern. No change needed here.
- **Non-canonical packlist → schedule:** `findScheduleRowsForPacklist` strips suffix words down to (but not including) removal of the year, so "LOCKHEED 2025 NGAUS MEETING ROOM" → tries full → strips "ROOM" → strips "MEETING ROOM" → strips "MEETING ROOM NGAUS" — wait, this strips left to right, but the canonical schedule entry is "LOCKHEED 2025 NGAUS". The suffix is after the show abbreviation which comes after the year. The algorithm `words.slice(0, count)` strips from the right, so: "LOCKHEED 2025 NGAUS MEETING ROOM" → "LOCKHEED 2025 NGAUS MEETING" → "LOCKHEED 2025 NGAUS" ✓. This is correct.
- **Year boundary for suffix stripping:** `minWords = yearIndex + 2` ensures we always keep at least one word after the year (the show abbreviation). We never strip back to just "LOCKHEED 2025" or "LOCKHEED" alone.
- **Abbreviation matching:** The component-level step in `findBestProjectIdentifierMatch` handles this — it resolves client and show through the reference index. This remains unchanged. Callers just need to pass it year-filtered candidates, which the new functions do.

---

## What is NOT Changed

- `computeIdentifier` — unchanged, still the canonical way to normalize Show+Client+Year into an identifier string.
- `findBestProjectIdentifierMatch` — unchanged, still the core string-matching engine.
- `findPackListTab` / `findAllPackListTabsForShow` — unchanged, still used by `findPacklistTabsForScheduleRow` internally.
- `deduplicateScheduleByShow` — unchanged.
- All schedule index reference updating code (`addCustomReferenceEntry`, `updateReferenceAbbreviation`, etc.).
- All date calculation helpers (`_calculateShipDate`, `_calculateReturnDate`, etc.).
- The API layer wrappers — they only need to expose the two new functions.
