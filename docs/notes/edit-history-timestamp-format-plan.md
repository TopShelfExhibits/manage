# EditHistory Timestamp Format — Possible Future Plan

**Status:** Proposed, not implemented. Written October 27, 2026.

**Goal:** replace the decisecond timestamps in `EditHistory` with ISO 8601 strings that a person can read straight from the sheet cell and that any language can parse. Readers stay backwards compatible, so existing entries never need rewriting.

**Related:** [metadata-implementation.md](metadata-implementation.md) (the EditHistory contract, which must be updated as part of this work) and [inventory-edit-history-view-plan.md](inventory-edit-history-view-plan.md).

---

## Decisions Made

| Decision | Choice |
|---|---|
| Format | Human-readable ISO 8601 (extended format with dashes and colons), not a compact numeric form. If custom parsing ever fails, any tool or person can still read the value. |
| Time zone for instants | UTC, written with a trailing `Z`. |
| Precision for instants | Minutes. Seconds are dropped (see [Minute Precision Review](#minute-precision-review)). |
| Effective dates (`p[].t`) | A plain calendar date with no time and no time zone. |
| Backwards compatibility | Readers accept legacy deciseconds forever. No migration. |
| CAD automation | It follows the current contract (prepends to `h`, writes decisecond `t`) and never reads existing `t` values, so the contract can change now. CAD switches its writer whenever convenient; old-format CAD entries stay valid. |

---

## New Formats

| Field | Meaning | Old value | New value | Size change |
|---|---|---|---|---|
| `h[].t` | When the change was saved (an instant) | `17927871301` | `"2026-10-27T14:35Z"` | +8 characters |
| `h[].t` on applied scheduled entries | The effective date (see below) | `18118224000` | `"2027-06-01"` | +1 |
| `h[].d` | When a scheduled change was created (an instant) | `17927871301` | `"2026-10-27T14:35Z"` | +8 |
| `p[].t` | Effective date | `18118224000` | `"2027-06-01"` | +1 |
| `p[].d` | When the entry was scheduled (an instant) | `17927871301` | `"2026-10-27T14:35Z"` | +8 |
| `_EditHistory` `Timestamp` column | When the row was archived (an instant) | `17899164000` | `2026-10-27T14:35Z` | Separate column, so size doesn't matter (but see the [Google Sheets coercion risk](#google-sheets-coercion-risk)) |

A full row history of 10 entries grows by about 80 characters. That is negligible against the 50,000-character limit for a Sheets cell.

### Why these exact shapes

- **`YYYY-MM-DDTHH:mmZ`** is valid ECMAScript date-time syntax (seconds are optional), so `new Date("2026-10-27T14:35Z")` works natively. C#, Python 3.11+, Java and Google Apps Script parse it too. This is the "useful fallback": an app that has never read this plan can still parse and display the value.
- **The `Z` is kept.** It costs one character and makes the value self-describing. A value without an offset would be read as local time by JavaScript.
- **Effective dates are calendar dates, not instants.** A scheduled change means "on June 1", wherever the reader is. Storing `"2027-06-01"` removes the current problem where the same day encodes to different numbers in different time zones or on either side of a daylight-saving change, which breaks the exact-match lookups on `p[].t`.

### Writing

```js
// Instant, truncated to the minute (floor, matching the old Math.floor behaviour)
new Date().toISOString().slice(0, 16) + 'Z';         // "2026-10-27T14:35Z"

// Calendar date from a user-entered date (local components; never toISOString)
toISODateString(parseDate(effectiveDate));             // "2027-06-01"
```

---

## Reading (Backwards-Compatible Parser)

One normalizer in `metadata-utils.js` handles every format. No other code may do arithmetic on raw `t` or `d` values.

| Input | Detected by | Interpretation |
|---|---|---|
| A number | `typeof t === 'number'` | Legacy deciseconds: `ms = t * 100` |
| A string of digits only | `/^\d+$/` | Legacy deciseconds read back from a sheet cell as text (the archive `Timestamp` column) |
| A calendar date | `/^\d{4}-\d{2}-\d{2}$/` | A calendar date. Converted to **local** midnight. Never pass it to `new Date(str)`, which treats date-only strings as UTC midnight and shifts the day west of Greenwich. |
| An ISO instant | `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z\|[+-]\d{2}:\d{2})$/` | `Date.parse(t)`. Seconds, fractions and explicit offsets are accepted from external writers (lenient reading, strict writing). |
| Anything else (`null`, garbage) | Fallthrough | `null`. Display shows "unknown"; sorts treat it as oldest. |

Proposed helpers (names are suggestions):

```js
EditHistoryUtils.nowStamp()            // → "2026-10-27T14:35Z"
EditHistoryUtils.toCalendarDate(date)  // Date | "YYYY-MM-DD" | legacy t → "YYYY-MM-DD" (local)
EditHistoryUtils.toMillis(t)           // any format → epoch ms | null
EditHistoryUtils.toDate(t)             // any format → Date | null
EditHistoryUtils.isDateOnly(t)         // true for "YYYY-MM-DD" (display without a time of day)
EditHistoryUtils.sameDay(a, b)         // compares toCalendarDate(a) === toCalendarDate(b)
```

**Legacy effective dates.** Scheduled saves currently compute `p[].t` from `parseDate(effectiveDate)`, which returns **local noon**. Converting a legacy `p[].t` to a local calendar date is therefore correct for any reader within ±11 hours of the writer's time zone. Today, exact matching fails whenever the reader's time zone differs at all. Some fixtures and tests use local midnight instead; those also convert correctly in the writer's own time zone.

---

## Minute Precision Review

Every use of `t`, `d` and `Timestamp` was checked. Dropping from deciseconds to minutes is safe.

| Use | Location | Depends on sub-minute precision? | Notes |
|---|---|---|---|
| Ordering of `h` | Everywhere | **No** | `h` is ordered by array position (newest first) and is never sorted by `t`. Two entries in the same minute keep their order. |
| Past-state reconstruction and revert | `getHistoryStates`, `InventoryTable.revertToState` | No | Index-based. |
| Aggregation window | `metadata-utils.js` `_canAggregate` (`gap = newEntry.t - prev.t`) | No | With minute truncation, a computed gap of 60 minutes can be an actual gap of up to 60 min 59 s. A one-minute fuzz on a one-hour heuristic is harmless. The window constant changes from `36000` (deciseconds) to 60 minutes in milliseconds, compared through `toMillis`. `gap >= 0` still rejects clock-skewed entries. |
| Pending entry identity | `inventory-utils.js` `getInventoryRowsForPendingEntry`, `savePendingChangeEntry`, `deletePendingChangeEntry` (exact `e.t === …`) | No | Already day precision. Switching to `sameDay()` fixes legacy and new values and the time-zone mismatch. |
| Pending sorts | `metadata-utils.js` `applyPendingChangesToData` (`due.sort`), `InventoryTable.js` pending display sort | No | Already day precision. Same-day ties fall back to insertion order (stable sort), as today. Compare by `toMillis` or calendar date. |
| Applying due pending changes | `applyPendingChangesToData` | No | Compare `toCalendarDate(entry.t) <= toCalendarDate(reference)`. The reference date can stay a `Date` instead of deciseconds. |
| Timeline window | `inventory-utils.js` `getItemTimeline` (`entry.t < startDs`, `ds >= startDs`) | No | Timeline events are bucketed by calendar day. Note that applied scheduled entries in `h` will carry date-only `t` values, and `toMillis` maps them to local midnight. |
| `h[].d` / `p[].d` | Dev tools display; `_canAggregate` presence check | No | Only displayed, and checked for presence. |
| Archive sort | `api.js` `getArchivedRows` (`Number(row.Timestamp)`, sort descending) | Ties possible | Deletions in the same minute tie. Break ties by sheet row order (newer rows are appended lower) so the newest stays first. **`Number(row.Timestamp)` must become `toMillis`, or every new row reads as `0`.** |
| History page display | `InventoryTable.js` `formatHistoryTime` | No | Already shows hours and minutes only. |
| CAD alert text | `api.js` `checkCadSourceHistory` → `formatTimestampHuman` | No | Uses `toLocaleString()`, so seconds display as `:00`. Switch to the minute format used on the history page. |
| Same-minute saves by different users | Write path | No | Separate entries, ordered by position. |
| Same-minute saves by the same user and source | Write path | No | Merged by aggregation, as today. |

**Conclusion:** no logic needs more than minute precision. Day precision already governs all pending-change behaviour, and history order comes from array position.

---

## Code Changes

### `docs/js/data_management/utils/metadata-utils.js`

- Add the helpers above. Change `HISTORY_AGGREGATION_WINDOW` to `60 * 60 * 1000` (ms) and compare `toMillis(newEntry.t) - toMillis(prev.t)`.
- `createEditHistoryEntry`, `createArchiveEntry`, `createPendingEntry` (`d`): write `nowStamp()`.
- `createPendingEntry` (`t`): accept and store a calendar date.
- `applyPendingChangesToData`: compare calendar dates and sort through the normalizer. It keeps copying `entry.t` (a date) and `entry.d` into `h`.
- `decisecondToDate`, `formatTimestamp` and `formatTimestampHuman` become format-agnostic wrappers over `toDate`. Rename `decisecondToDate` to `toDate`, keeping an alias until all callers are updated.
- Update the header comment that documents `t` as deciseconds.

### `docs/js/data_management/abstraction/inventory-utils.js`

- Scheduled save: `effectiveDeciseconds` becomes `effectiveDate = toCalendarDate(...)`.
- Rename the `effectiveDateDeciseconds` parameters to `effectiveDate` and compare with `sameDay()` (three sites).
- `applyPendingChangesToData` callers (`todayDeciseconds`, `refDeciseconds`): pass a `Date` or calendar date.
- `getItemTimeline`: replace `ds * 100` and the `startDs`/`endDs` arithmetic with `toMillis` / `toCalendarDate`. Ship and return dates (`shipDs`, `retDs`) are show dates, not EditHistory values, but they share the window variables, so convert the window to milliseconds throughout.

### `docs/js/data_management/api.js`

- Rename the `effectiveDateDeciseconds` parameters (pass-through wrappers).
- `getArchivedRows`: use `toMillis(row.Timestamp)`, with the tie-break described above.
- `checkCadSourceHistory`: no logic change. `sourceTimeline[].t` passes raw values through, so any consumer must format with the helper.

### UI: `docs/js/application/components/content/InventoryTable.js` and `InventoryOverviewTable.js`

- `formatHistoryTime` and `formatPendingDate` take any format through `toDate`. A date-only `h[].t` (applied scheduled entry) shows the date without a time.
- The pending display sort uses the normalizer.
- The pending edit and delete flows pass `entry.t` through unchanged, which still works because matching uses `sameDay()`.

### Dev and test tooling

- `docs/js/tests/fakeGoogleDevTools.js`:
  - `_now()` → `nowStamp()`; `_formatTime` → the helper.
  - `advanceClock(hours)` must re-encode values in the format they came in:
    - instants: shift in milliseconds, re-serialize;
    - calendar dates: shift by whole days (`Math.round(hours / 24)`);
    - legacy numbers: stay numbers, shifted by `hours * 36000`.
- `docs/js/google_sheets_services/FakeGoogle.js`: convert most fixtures to the new formats. **Keep at least one row per tracked table in legacy deciseconds** (for example CHAIR-004's past-due pending entry and one TULIP crate entry), so mixed histories stay covered.
- `docs/js/tests/tests.js`, new tests:
  - Each parser branch (number, digit string, calendar date, instant with and without seconds and offset, garbage).
  - Aggregation across a legacy `prev.t` and a new `newEntry.t`, at 59 and 61 minutes.
  - `sameDay` between a legacy local-noon `p[].t` and `"YYYY-MM-DD"`.
  - Applying due pending entries with mixed formats, ordered correctly.
  - Archive rows with mixed `Timestamp` formats sorting newest first.
  - Timeline rendering an applied scheduled entry with a date-only `h[].t`.
  - Existing aggregation tests (`t: 1000`, `1000 + 36001`, …) rewritten with ISO instants.

Estimated size: about 120–160 lines of code, plus fixtures and tests. Most of it is mechanical once the helpers exist.

---

## Contract Changes (`metadata-implementation.md`)

1. **JSON Shape:** `t` and `d` are ISO 8601 UTC instants at minute precision (`YYYY-MM-DDTHH:mmZ`). `p[].t`, and `t` on applied scheduled entries, is a calendar date (`YYYY-MM-DD`).
2. **New "Timestamp Formats" section:**
   - The reading rules table above.
   - "Writers MUST write the new formats; readers MUST accept all of them."
   - Legacy deciseconds are deprecated but valid indefinitely.
3. **Write Rules:** the aggregation window is stated as one hour, computed on parsed instants.
4. **Pending changes appendix:**
   - Replace "effective date in deciseconds (start-of-day precision)" with the calendar-date rule.
   - Matching an entry is by calendar date.
   - The reference date comparison is by calendar date.
5. **Archive Table:** `Timestamp` is an ISO instant (with the coercion note below).
6. **External Automation:**
   - CAD may keep writing deciseconds until updated. When it does update, it writes `YYYY-MM-DDTHH:mmZ` in UTC.
   - Since CAD never reads `t`, it has no reader changes to make.
7. **Reconstructing Past Row States:** note that order comes from array position, never from `t`.

Rollout order: this app's readers must ship before, or together with, its writers. Since this app is the only reader, the contract and code can change in one release.

---

## Google Sheets Coercion Risk

`GoogleSheetsData.setSheetData` writes with `valueInputOption: 'USER_ENTERED'`, and `getSheetData` reads with the default `FORMATTED_VALUE`. This matters for each storage location:

| Location | Risk |
|---|---|
| Inside the `EditHistory` JSON | **None.** The cell content is a JSON string, so Sheets never parses the timestamps inside it. |
| Archive `Timestamp` column (its own cell) | Sheets may parse a date-like string as a date-time serial and return it in the spreadsheet's display format (for example `10/27/2026 14:35:00`), dropping the `Z` and possibly shifting the value to the spreadsheet's time zone. |

The parser's lenient fallback would not reliably recover that. Before switching the archive column, verify against a real spreadsheet, then pick one of:

- Prefix the value with an apostrophe (`'2026-10-27T14:35Z`) so Sheets keeps it as text. The apostrophe is not returned on read.
- Have `appendSheetRow` write that tab with `RAW`.
- Format the `Timestamp` column as plain text when `_archiveDeletedRows` creates the tab.

---

## Open Questions

- **Which "today" applies due pending entries?** Currently the browser's local date. With calendar-date effective dates this is a business rule, not an encoding detail. Leave it as-is unless the time-system audit decides otherwise.

---

## Follow-Up: Time-System Audit

UTC is the right choice for EditHistory instants, but the app has several independent time systems that should eventually be reviewed together for consistent time-zone and format rules:

| System | Location | Current behaviour |
|---|---|---|
| EditHistory `t`/`d` and archive `Timestamp` | `metadata-utils.js` | Covered by this plan. |
| Scheduled effective dates | `inventory-utils.js` | Written as local noon via `parseDate`; references compared at local midnight. |
| Sheet locks | `application-utils.js` (`isActiveLockTimestamp`, `toLockTimestampMs`) | The normalizing helpers suggest more than one stored format. |
| Cache invalidation | `application-utils.js` `writeCacheTimestamp`, `caching.js` poller | ISO strings in the `CACHE`/`Caching` tab, with a +1 s offset on write; subject to the same `USER_ENTERED` coercion question. |
| Show dates | `helpers.js` `parseDate` | Local-time interpretation of sheet dates (date-only values map to local noon). |
| "Today" | `helpers.js` `todayISOString`; `new Date().setHours(0, 0, 0, 0)` in `inventory-utils.js` | Browser-local. |
| Autosave backups and session data | `reactiveStores.js` | Not reviewed. |
