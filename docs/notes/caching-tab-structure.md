# Caching Tab — Structure and Write Rules

## Tab location

Spreadsheet: `CACHE` (`window.ENDPOINT_IDS.CACHE` or the sheet id: `1lq3caE7Vjzit38ilGd9gLQd9F7W3X3pNIGLzbOB45aw`)
Tab name: `Caching`

## Table layout

| A (Key)                                    | B (Timestamp)              |
| ------------------------------------------ | -------------------------- |
| `database:getData:"PACK_LISTS","NAB 2025"` | `2026-05-14T18:30:00.000Z` |
| `database:getData:"INVENTORY","Sheet1"`    | `2026-05-14T19:00:00.000Z` |

- **Row 1**: Headers — `Key`, `Timestamp`
- **Row 2+**: One row per cache prefix, no fixed order

## Key format

Keys are produced by serializing the first two call arguments with `JSON.stringify`, stripping the outer `[` and `]`, then prefixing with namespace and method name:

```js
const argsString = JSON.stringify([tableId, tabName]).replace(/^\[|\]$/g, "");
const key = `${namespace}:${methodName}:${argsString}`;
```

Only `database:getData` entries for non-`CACHE` tables are written here. The resulting format is:

```
database:getData:"TABLE_ID","TAB_NAME"
```

Because `JSON.stringify` double-quotes strings, the TABLE_ID and TAB_NAME are always wrapped in `"`. Example:

```
database:getData:"PACK_LISTS","NAB 2025"
```

### Valid TABLE_IDs

| TABLE_ID     | Spreadsheet                     |
| ------------ | ------------------------------- |
| `INVENTORY`  | Inventory spreadsheet           |
| `PACK_LISTS` | Pack lists spreadsheet          |
| `PROD_SCHED` | Production schedule spreadsheet |

`CACHE` is explicitly excluded — no cache timestamps are written for CACHE table reads.

### TAB_NAME

The tab name is the exact Google Sheets tab title within the spreadsheet (e.g. `"NAB 2025"`, `"Sheet1"`). Tab names are case-sensitive and must match exactly as they appear in the sheet.

## getTabs key format

`database:getTabs` entries use only the TABLE_ID — there is no tab name argument:

```js
const argsString = JSON.stringify([tableId]).replace(/^\[|\]$/g, "");
const key = `database:getTabs:${argsString}`;
```

Resulting format:

```
database:getTabs:"TABLE_ID"
```

Example:

```
database:getTabs:"PACK_LISTS"
```

This entry is written when `createTab` is called. Other sessions whose poller detects a newer timestamp will invalidate their `database:getTabs:"TABLE_ID"` cache entries and refetch the tab list.

## Timestamp format

ISO 8601 string from `new Date().toISOString()`. Example: `2026-05-14T18:30:00.000Z`

## Row number arithmetic

`rawData` returned by `getSheetData` is a 2D array where index 0 is the header row.

- `rows = rawData.slice(1)` — 0-indexed array of data rows
- **Update existing row**: `sheetRow = rowIndex + 2` (+1 to convert to 1-indexed, +1 to skip header)
- **Append new row**: `newRowNumber = rows.length + 2` (next 0-indexed position is `rows.length`, same +2 offset)

## Write rules

**Sheet missing or empty** (`rawData` is null/empty):

```js
setSheetData(
  "CACHE",
  "Caching",
  [
    ["Key", "Timestamp"],
    [prefix, timestamp],
  ],
  null,
);
```

**Update existing key** (key found at `rowIndex` in `rows`):

```js
setSheetData(
  "CACHE",
  `Caching!B${rowIndex + 2}:B${rowIndex + 2}`,
  [[timestamp]],
  null,
);
```

Writes only column B — the key in column A is not touched.

**Append new key** (key not found):

```js
setSheetData(
  "CACHE",
  `Caching!A${rows.length + 2}:B${rows.length + 2}`,
  [[prefix, timestamp]],
  null,
);
```

Writes both columns A and B of the next empty row.

## Access method

All reads and writes use `GoogleSheetsService` directly (same pattern as the `Locks` tab). Do not route through the cache layer or `Database`.

## Request cost

Google Sheets allows 60 read and 60 write requests per minute per user, and 300 each per project.

- **Polling.** Each poll is one read of this tab, every 30 s (10 s on localhost), only while the browser tab is visible. A hidden tab skips its polls, and polls once when it comes back into view.
- **Stamps.** A stamp is one read of this tab, to find its row, and one range write. A range write such as `Caching!B5:B5` is a single `values.update`. Only a whole-tab write also looks up the grid, to delete the rows below the new data.
- **Prefixes.** The prefix `database:getData:"TABLE_ID","TAB_NAME"` is also the cache key of the tab's unmapped read. Every mapped read of a tab is computed from that read, so a tab costs one sheet read however many mappings read it.

# Analytics Tab: Persisted Results

Some cached API results take long enough to compute that a new session should start from the last saved copy. A method opts in through `wrapMethods`' last argument, `persistentMethods` (see the bottom of `api.js`). The persisted methods are `getInventoryShortageAlerts` and `getItemThumbnails` (item thumbnails for report pages; it reads every inventory tab).

## Tab location and layout

Spreadsheet `CACHE`, tab `Analytics`. Row 1 holds the headers; each later row holds one saved result.

| A (Key)                            | B (SavedAt)                | C (Sources)                                         | D (Value)               |
| ---------------------------------- | -------------------------- | --------------------------------------------------- | ----------------------- |
| `api:getInventoryShortageAlerts:` | `2026-11-04T16:19:54.842Z` | `["database:getData:\"CACHE\",\"Preferences\",…"]` | `[{"itemId":"CAB-004"…}]` |

- **Key:** the method's cache key, from `generateCacheKey`.
- **SavedAt:** an ISO timestamp, written like the Caching tab's. This is when the oldest source read was filled, which can be earlier than the save itself.
- **Sources:** a JSON list of the leaf cache keys the result was computed from, gathered from the recorded dependency chain (`collectSourceKeys`). Only keys a stamp can name are kept (the store's `sourcePrefixes`: `database:` reads and the `app_utils:` sources, the clock and the locks). Pure cached leaves such as `findBestProjectIdentifierMatch` are left out: their keys embed every show name and can never mark the row stale.
- **Value:** the result as JSON. A row is written only if every cell stays under the 50,000-character Sheets cell limit; otherwise the save is skipped with a console warning.

Reads and writes use `GoogleSheetsService` directly, in `application-utils.js` (`setPersistentStore`), the same way as the Caching tab. Saving a result therefore never invalidates cached reads. If the tab is missing, restores and saves fail quietly (with a console warning) and results are computed as before.

## Rules

- **Saving.** Every computation of a persisted method writes its row, after the result is cached in memory. The write isn't awaited.
- **Restoring.** Only the first cache miss of a session (or after `clearCache`) reads the row. The row is used only if no source has a newer timestamp than `SavedAt`. A source is checked against every Caching tab key it starts with, and `app_utils:getToday:` is checked against local midnight. When a row is restored, its sources are linked back as dependencies and marked as filled at `SavedAt`. From then on, a local save or a timestamp the poller picks up invalidates the restored value exactly as if it had been computed in this session.
- **Stale rows** are never deleted. A stale row is ignored on read and overwritten by the next computation.
- **Allowed sources.** A persisted method's result must be JSON, and it may depend only on `Database` reads and `ApplicationUtils.getToday`, since only those are checked on restore. In memory, persisted results never expire; only their sources invalidate them.
- **Self-stamped writes.** `writeCacheTimestamp` adds one second to every stamp, so a result computed in the second after a source was saved is seen as stale by the next session. That costs one extra computation and never restores stale data.

## Today and the date rollover

`helpers.js` is the one source of "now" (`currentDate`, `todayISOString`, `startOfTodayMs`, `offsetToISO`), and it uses the browser's local calendar. Cached functions whose results depend on today read it with `deps.call(ApplicationUtils.getToday)`. `checkDateRollover` runs every minute; when the local date changes, it invalidates `getToday`. The invalidation cascades to every result computed from today, and their reactive stores reload. Tests pin the date with `setTestToday`.

## Shortage alerts

- **Preference.** `InventoryShortageAlertDays` sets how many days ahead the alerts look. Missing or `0` turns the alerts off.
- **What's checked.** `getInventoryShortageAlerts` runs the item shortage report on shows dated from today through that many days ahead, and keeps the periods where an item's minimum quantity drops below 0.
- **Where the alerts show** (`application/utils/shortageAlerts.js`):
  - an app banner that links to the report;
  - a "Short N" card on the item number, in the inventory overview and the category tables;
  - an "N short" card on each affected category card, which opens the report filtered to that category.

## Live data to add before deploying

1. A `CACHE/Analytics` tab with the headers `Key | SavedAt | Sources | Value` in row 1.
2. A `CACHE/Preferences` row: ID `InventoryShortageAlertDays`, Name `Shortage Alert Days`, Description `days ahead the inventory shortage alerts look; 0 turns them off`, Page `inventory*`, Type `integer`, Value set to the number of days (for example `60`).
