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

## Write rules

`stampDataChange(prefix)` (`caching.js`) queues a stamp, dated a second ahead. `ApplicationUtils.writeCacheTimestamps` writes the queue in batches, one batch at a time:

1. **Read the tab.** If the read fails, nothing is written. The stamps stay queued, and the next poll retries them. A tab is treated as empty only when a successful read finds it empty: then the header goes into `Caching!A1:B1`, a range write that truncates nothing.
2. **Update keys the tab has.** Each key's first row gets its column B in one `values.batchUpdate` (RAW, so the strings are stored as they are).
3. **Append new keys.** One `values.append` on `Caching!A:B` (RAW, INSERT_ROWS). Sheets places the rows, so two sessions adding new keys at once each get their own row. Duplicate rows of a key are harmless: the poller reads every row, and writers update the first.

**This session's own stamps.** The poller skips a `database:` stamp it reads back when the row still holds this session's own timestamp. The session's write already replaced its copy (whole-tab writes) or invalidated it (range writes), so a re-read would be wasted. Last write wins on a row. If a stamp write replaces a value other than the one this session last read or wrote there, another session's stamp was lost. The stamp then stops counting as this session's own, and the poll re-reads the data once. Lock stamps (`app_utils:getLocksData`) are never skipped: locks are always confirmed by a fresh read.

**External apps** write the data first, then the stamp: update the key's row, or append a row when the key is new.

## Access method

All reads and writes use `GoogleSheetsService` directly (same pattern as the `Locks` tab). Do not route through the cache layer or `Database`.

## Request cost

Google Sheets allows 60 read and 60 write requests per minute per user, and 300 each per project.

- **Polling.** A poll runs every 30 s (10 s on localhost), only while the browser tab is visible. A hidden tab skips its polls, and polls once when it comes back into view. Each poll first reads the Drive `modifiedTime` of the INVENTORY, PACK_LISTS, PROD_SCHED and CACHE spreadsheets, which costs Drive quota, not Sheets quota (see Spreadsheet watch). It then reads this tab only when it may hold new stamps: the CACHE spreadsheet or a watched one changed, or the last read is over 2 minutes old. While nothing changes, a poll costs no Sheets reads.
- **Stamps.** A batch of stamps is one read of this tab, plus one write for the keys it has and one append for new keys.
- **Saves.** A whole-tab write asks for the written values in its response (`includeValuesInResponse`). The response is the tab exactly as a read returns it right after the write, formatted and with formulas computed. The save caches it instead of reading the tab again (`fillCache`). A read that was already in flight from before the save can't replace it: a result computed before a key's latest change is never cached, and later calls don't join it. Range writes (cell edits, appended rows, deleted rows) still invalidate and re-read, because their response covers only the range.
- **Expiry.** Sheet data never expires. It stays cached until a stamp, a local write or the spreadsheet watch says it changed. Shorter expiries on computed results cost no requests: a computed result is rebuilt from cached reads.
- **User data.** `storeUserData` calls made at the same moment are one read and one write of the user's tab, and writes to one tab never overlap. Autosave starts all its writes together.
- **Prefixes.** The prefix `database:getData:"TABLE_ID","TAB_NAME"` is also the cache key of the tab's unmapped read. Every mapped read of a tab is computed from that read, so a tab costs one sheet read however many mappings read it.

## Spreadsheet watch

Set up at the bottom of `database.js` (`watchSpreadsheets`) and run by the poller (`caching.js`). Drive's `modifiedTime` covers a whole spreadsheet, not a tab. Each poll compares it with the value the previous poll saw, never with this computer's clock. A late `modifiedTime` only delays detection.

| Table | A change means | While Drive can't confirm it |
| --- | --- | --- |
| PROD_SCHED | Edited by hand, without stamps: every cached read of it is invalidated, and the stores reload. | Reads older than 4 minutes expire. |
| PACK_LISTS | The stamps name the tab. A change that no stamp of the table accounts for is checked again at the next poll. If still unaccounted for, the table's older cached reads expire (`[CacheWatch] … changed with no stamp` in the console). | Reads older than 30 minutes expire. |
| INVENTORY | As PACK_LISTS. | Nothing expires. |
| CACHE | Holds the stamps: a change means the Caching tab may hold new stamps. | Nothing expires. |

- **Accounting for a change.** A stamp accounts for a change when its timestamp is no more than 60 seconds older than the change. This allows for other computers' clocks. A missed stamp can therefore go unnoticed when another stamped write to the same spreadsheet lands within a minute of it.
- **Blind spots.** `modifiedTime` doesn't move when values change through `IMPORTRANGE`, a Google Form, or volatile formulas such as `NOW()`.
- **Permissions.** Reading `modifiedTime` uses the `https://www.googleapis.com/auth/drive` scope the app already requests, through Drive API v3 `files.get`.

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
