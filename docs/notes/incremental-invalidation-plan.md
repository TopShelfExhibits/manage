# Incremental Invalidation Plan

**Branches:** built on api-separation, merged into main (74119af) and into auth-apps-script
(cd359f5), where phase 2 was finished.
**Status:** Phase 1 done (commit 28a87dd). The first, opt-in slice of phase 3b is done: early cutoff
for listed methods, applied to how quantity analysis reads the Production Schedule (see "Phase 3b,
first slice" below). Phase 2 is done (auth-apps-script, 3831c80): cached values are frozen. 3a, the
rest of 3b and phase 4 remain; questions 3–5 and 7–9 at the end still need answers before those.

## Goal

When data changes, recompute only what the change affects, and tell stores only about values
that actually changed. A store row whose inputs didn't change is never blanked, re-analyzed or
re-rendered. A store whose main data comes back identical is not reloaded.

Keep the API layer (`data_management/`) and the reactive stores (`application/utils/reactiveStores.js`)
separate, so the API layer can later move to a server. The contract between them stays one kind
of message: "cache key K (method + args) has a new value".

## What main changed

Main's caching work (caching.js, database.js, application-utils.js; notes in
caching-tab-structure.md) changes when invalidation happens and gives this plan building blocks.
It doesn't change how invalidation propagates.

**When data is invalidated now:**

- **Sheet reads never expire.** `getData` and `getTabs` are cached indefinitely. One raw read
  per tab (`database:getData:"T","tab"`) feeds every mapped read of that tab.
- **The spreadsheet watch decides staleness.** Each poll reads Drive's `modifiedTime` per
  spreadsheet:
  - *Production Schedule* (`editedByHand`): any change invalidates every cached read of the
    whole spreadsheet, so every store built on it reloads.
  - *Stamped spreadsheets:* the Caching tab stamps name the changed tab. A change no stamp
    accounts for expires that table's older reads silently, without reloading stores.
- **Saves fill the cache.** A whole-tab write invalidates the tab's reads, so stores reload,
  then caches the written tab as the new raw read (`fillCache`), so the reload doesn't read the
  sheet again.
- **Tab reads are batched.** Reads go out as one request per spreadsheet.
- **The clock is a source.** `app_utils:getToday` is a cached source. The date rollover
  invalidates it and everything computed from it.

**Building blocks phase 3 can reuse:**

- **Generations** (`invalidatedAt`, `_changedSince`): a computation that started before its
  key's latest change is not cached, and later callers don't join it.
- **`expire(key)`:** drops a value and everything computed from it without announcing, and
  keeps dependency records. It is a "stale, not announced" primitive.
- **`collectSourceKeys(key)`:** walks the dependency graph down to its sources.
- **Persisted results** (`persistentMethods`, CACHE/Analytics): opt-in results saved with
  their sources and restored when no source is stamped newer. Their values must be JSON, and
  `keepEmpty` caches "nothing found".

**Unchanged:** `invalidate` still deletes the chain top-down, deletes dependency records, finds
dependents by scanning every key, and announces every `api:` key it deleted. Phases 3–4 are
still needed. Main makes phase 3 both more valuable and cheaper, as described below.

**What the auth branch adds** (connection notes in caching-tab-structure.md, "Connection"):

- **Invalidations wait for the connection.** While Google is unreachable or the browser offline,
  `invalidate` keeps every value and holds the key (`_heldInvalidations`); the held keys are
  invalidated on reconnecting. Any verification phase 3 adds inherits this: a cascade found during
  an outage is held, never lost.
- **No-answer results aren't cached.** A computation during which a request went unanswered keeps
  no value and, for cutoff keys, no hash (`networkState.noAnswers`), so it counts as unverifiable.
- **Cached values are frozen** (phase 2 below). A value can't change after it is cached, which is
  what lets phase 3 compare lazily.

## Phase 1 — targeted re-analysis (done)

- Each analysis run records which rows produced which cache key (config id → args → rows).
- An analysis event re-runs only the rows behind that exact key, after the existing 150 ms
  debounce. Current values stay on screen until the new ones arrive.
- A result equal to the current one is not written, so there is no reactive update and no
  re-render.
- Targets that arrive during a full run are queued until it ends. Targets that arrive during a
  main reload are dropped, because analysis runs after the reload.
- Every key can be predicted: an analysis gets its source value, or only the fields it names
  (`passFields`, phase 2), never the whole row. An event that names no args re-runs all of a
  config's rows, without blanking.
- Tests: the TARGETED ANALYSIS group in tests.js, three tests that fail on the old store code.

**Limit:** a cascade that reaches the main data still reloads and blanks everything. On the
Schedule page this is now the common case: any hand edit anywhere in the Production Schedule
spreadsheet invalidates every read of it.

## Phase 3b, first slice — opt-in early cutoff on the schedule (done)

Before this, every Production Schedule hand edit, a task checkbox included, reran all quantity
analysis: item timelines, remaining quantities, overlap checks, shortage alerts. That analysis read
the schedule as full rows (44 columns), even though it uses 10. Even under the full 3b, which cuts
off unchanged values, the analysis would still recompute, because its inputs (full rows) change on
every edit. Narrowing the inputs is what avoids the recompute; cutoff is what stops the cascade.

**Mechanism** (caching.js, `EARLY_CUTOFF`):

- `wrapMethods` takes `cutoffMethods`. A cutoff key records its recomputation and a hash of each
  value it keeps. The hash is kept apart from the entry, so null and empty results compare too, and
  a hash survives `expire()`. 3b replaces these hashes with a lazy comparison of the kept values
  ("Compare lazily" below).
- When a cutoff key with dependents is invalidated, its own value and dependency records go as
  usual. Its dependents keep theirs, and nothing is announced (`_deferCascade`).
- After the current invalidation (a `setTimeout`, so a save's `fillCache` lands first), the key is
  recomputed and its hash compared (`_verify`). Equal: done. Changed, unverifiable (an error) or not
  kept (generations): the held cascade runs and the key is announced, as before.
- A key that changes again while it is being verified is verified again. Generations guard joins
  and caching exactly as before. `cutoffSettled()` resolves once no verification is running (tests).
- A connection that drops while the key re-reads its tab leaves it unverifiable (no answer keeps no
  hash). Its cascade runs through `invalidate`, which holds each dependent for the reconnect, and the
  key is held too, without its hash: on reconnecting it cascades and is announced without a second
  check. The dependents keep their values until then.
- `EARLY_CUTOFF = false` restores the plain cascade (question 6: a code constant).

**Applied to the schedule** (production-utils.js):

- `getScheduleDateRows`: the schedule's Show, Client, Year, Identifier and date columns
  (`SCHEDULE_DATE_MAPPING`). A task-column edit stops here.
- `getScheduleDateMap(year)`: a year's date rows by computed identifier. Not a cutoff method: it is
  the lookup table that makes each `getShowDates` recompute a lookup.
- `getShowDates(id)`: one show's date row, with full-year dates. It is the one Direction 2 match
  (pack list title or schedule id → schedule row; it replaced `findScheduleRowsForPacklist`). A date
  edit to another show stops here.
- `getOverlappingShowIds(filters, searchParams)`: the canonical ids passing the filters, once each.
  Date filters on the date columns read the date rows; text filters, and date filters on other
  columns, read the full rows through `getOverlappingShows`. A change that doesn't move a show in or
  out of a window stops here.
- `getProjectShipDate`, `getProjectReturnDate`, `getTransshipSourceForShow` and
  `getTransshipDestinationsForShow` are cutoff methods too, now built on `getShowDates`.
- The item timeline, `getOverlappingShowItems`, chain item extraction, `getMultipleShowsItemsSummary`
  and `resolvePacklistIdentifier` use these. `getOverlappingShows` and `getShowDetails` keep
  returning full rows for the pages: `getShowDetails` matches through `getShowDates` and returns that
  row's full columns, and both share their date filtering and full-year dates with the narrow
  versions (`_filterRowsByDates`, `_withFullYearDates`). `deduplicateScheduleByShow` is gone; the id
  list is deduplicated.
- A date filter whose value is a show (getOverlappingShows) finds that show through `getShowDetails`,
  whatever the text filters. It used to search only the rows the text filters kept, so a text
  filter that dropped the show emptied the result; and its cache key held the whole schedule.
- `getMultipleShowsItemsSummary` now lists each show once. Before, a show with two booth rows was
  listed twice and its items were added to the total twice.

**Cost per hand edit:** the tab re-read already happened. Recomputing the 10-column rows and hashing
them is a few ms. A date edit also rebuilds the year maps and re-verifies each cached show, one
lookup each. Memory: one more cached copy of the schedule's date columns, and a number per cutoff key.

**Not covered:** stores built on full rows (the Schedule page) still reload and re-analyze on every
hand edit; phase 3a and phase 4 address that. Persisted results restored from CACHE/Analytics are
linked straight to the raw tab read, so the first hand edit after a restore still recomputes them;
after that recompute they depend on the cutoff methods.

**Tests:** the EARLY CUTOFF group (a task-column edit announces no analysis; a date edit announces
only the changed show's analysis; a new show reruns its window; a date filter on another column
reads the full rows; getShowDetails gives the full row of getShowDates' match). In CACHE
INVALIDATION, the transship test (an unrelated link announces nothing; a real one announces the
source and timeline) and the name override and abbreviation tests (an unrelated entry leaves
getShowDetails unannounced and unchanged). With `EARLY_CUTOFF = false` the transship test and the
first two EARLY CUTOFF tests fail; with it on, the suite passes.

Edge cases, in EARLY CUTOFF: the date rows and the full rows give the same ids for 145 date filters
(every date column, both directions, ISO dates, day offsets, shows across a year boundary, a transship
destination, a suffix variant, an unknown show); without filters each show is listed once; a filter
naming no show matches nothing; titles match in any case and spacing but never another year's show,
a yearless name or a blank; date rows hold only the 10 columns (no row number), with full-year dates;
cutoff values are plain JSON; a row inserted above and an edit to a repeated show's later row
announce nothing; a Show cell with stray spaces still pairs its date row with its full row; moving a
show to another year ends its old id; a row without a Client is listed by its stored Identifier on
both paths. In EARLY CUTOFF MECHANISM (synthetic
`wrapMethods` chains): a change undone before verification, a change made or undone during
verification, a failed
verification, the connection dropping during verification (held for the reconnect), a cutoff key without dependents, a chain
of cutoff keys, null and empty values, a dependent running when the value changes, and an argument
object changed after the call.

Known conservative case: `getOverlappingShowIds` keeps schedule order, so sorting the sheet changes
every id list and reruns the windows (show dates still cut off).

## Phase 2 — an immutability boundary (done)

Every reader of a cached value gets the same object, so a change to it would change it for every
later reader. (The cutoff slice was never exposed to this: it records each value's hash when the
value is cached, before any caller has it.) Done on auth-apps-script (3831c80):

1. **Frozen in production** (question 1): `CacheManager.set`, which `fillCache` and restored
   persisted results go through, deep-freezes every value (`FREEZE_CACHED_VALUES`). A change throws
   a TypeError where it is made (`classifyError` 'integrity') and the value stays as read.
   `reportIntegrityError` announces it, the app banner offers a refresh, and one inside a write
   turns data writes off until then (caching-tab-structure.md, "A blocked change is not an
   outage"). A full test run and a browse of the main pages found no other code writing into
   cached values.
2. **The store boundary:** `setData` copies the cached rows and gives the copy its row ids;
   `originalData` copies those rows. The cached result is never written.
3. **Analysis gets fields, not rows** (question 2): `passFields` names the fields an analysis
   reads; the pack list's `checkInventoryLevel` and `checkVariantLevel` pass only theirs. Passing
   the whole row is gone.
4. **The lock grid:** `lockSheet` appended new keys to the cached grid. It no longer does, and a
   session's lock acquisitions run one at a time (two new keys at once claimed the same row).

The plan's per-entry hashes (computed on set, kept through `expire()`, recorded for results `set()`
doesn't keep) exist for cutoff keys only. 3b doesn't need them for every key: see "Compare lazily"
below.

## Phase 3 — early cutoff, in two steps

### 3a. Cutoff at the sources

When a source is invalidated by the poller (stamp or hand edit) or by the date rollover, read
the new value first and compare it with the old one, which is kept (frozen) until the new read
arrives. Only a source whose value changed runs today's cascade. An unchanged source announces
nothing.

- **Cost:** none extra. These reads happen anyway when the stores reload, and they're batched
  per spreadsheet.
- **Effect:** a hand edit in one Production Schedule tab reloads only stores built on that tab;
  the other tabs' reads come back identical and stop there. The midnight rollover stops at
  `getToday`'s dependents whose inputs don't change, once 3b is in. A stamp from another session
  that wrote identical data is ignored.
- **Scope:** the source keys `collectSourceKeys` already names (raw tab reads, `getTabs`,
  `getToday`), and only invalidations from outside. A local save is a change by definition and
  keeps today's path (invalidate, then `fillCache`).
- **Size:** small to medium. This is the most value for the least change, and it can ship on
  its own.

### 3b. Cutoff through the graph

The first slice is done ("Phase 3b, first slice" above): listed methods verify before they
cascade. The rest of 3b widens that from listed methods to every key. Phase 2, which it needed, is
done: no cached value can change after it is cached.

**Compare lazily.** Because cached values are frozen, a stale value is still exactly what was
computed. So 3b keeps the old value of a key marked stale and compares it with the recomputed one
only when the key is verified, instead of hashing every value as it is cached (a large tab costs
milliseconds to serialize, on every fill, for keys that may never change). Two values compare by a
structural equality that stops at the first difference; identical objects (a refill that returned
the cached value) compare equal at once. The first slice still hashes its keys on set; moving it to
the same comparison is the first step of 3b, after which `valueHashes` goes.

1. **Mark, don't delete.** A changed source marks its transitive dependents stale (the
   `expire()` idea: keep dependency records, don't announce) and keeps their values for
   comparison.
2. **Verify bottom-up.** Recompute the direct dependents of what changed and compare each with
   its old value. Where a value comes out the same, stop. A dependent with several dependencies
   recomputes once, after all of them are verified. Generations guard every step, as
   `_changedSince` does today.
3. **Announce changes only.** The bus emits for an `api:` key only when its value changed.
4. **Dependencies are replaced, not cleared,** on every recompute, since they can differ between
   runs.
5. **Reverse index:** dependency → dependents. This replaces the full scan in both `invalidate`
   and `expire`.
6. **Who verifies:** keys with a live store subscriber are verified right away. Others stay
   stale until their next read (see question 4).
7. **Persisted results:** a restored value is compared like any other. Its re-linked sources cut
   it off the same way.
8. **Contracts to restate:** the ordering rules in `invalidate`'s comment block, the poller's
   use of `filled`/`filledAt` (it becomes "verified at"), the stamp ordering in
   `stampDataChange`, and `fillCache`'s "a read still in flight keeps its result" rule.
9. **Switch:** `EARLY_CUTOFF` falls back to delete-cascade (question 6: a code constant).
10. **Outages:** a verification that finds a change while Google is unreachable cascades through
    `invalidate`, which holds it for the reconnect, as the first slice does.

## Phase 4 — row matching on main-data reloads (simpler than planned)

When a store's main data does change, match rows instead of replacing them. Main already has the
matcher: `EditHistoryUtils.matchRows` (metadata-utils.js) is pure and implements the row identity
contract in metadata-implementation.md:

- Rows with `EditHistory.i` match on it.
- Rows without it match by identical content, nearest position first.
- Remaining rows match by the most equal fields within the gap between matched neighbours.

That covers every store without a per-store identity: inventory and packlist rows carry `i`, and
Production Schedule rows (no history column) match by content.

- Matched, unchanged rows keep their objects and analysis results.
- Matched, changed rows are updated in place and re-analyzed.
- Unmatched new rows are added and analyzed; unmatched old rows are removed.
- Order follows the new data, using moves rather than a rebuild.
- Stores with unsaved edits keep today's behavior: flag the conflict and don't reload.

## Testing approach

- Extend the FakeGoogle fault hooks and the spreadsheet watch's fake `modifiedTime`. Edit one
  cell of one tab, then assert which `api:` keys emitted and which store rows were written (Vue
  watchers with `flush: 'sync'`, as in phase 1).
- Assert no event for unchanged values: a hand edit to another tab, a rewrite of the same value,
  a stamp for identical data, and a date rollover that changes no result.
- Add counters (bus events emitted, functions rerun, rows written), exposed on localhost. Main's
  notes backlog already asks for a cache-usage metric, and these can share it.
- Keep the seeded randomized approach from the instant-write tests for 3b. Random edit sequences
  must leave every cached value equal to a from-scratch recompute.

## Questions

**Phase 2** (answered 2026-11-18)

1. **Freezing:** ~~dev-only, or production too?~~ Production too: a change that could corrupt live
   data must surface, recoverably (a banner with a refresh; saving off after a blocked write). The
   cost measured under 1 µs per object frozen.
2. **Full-item analysis:** ~~may `checkInventoryLevel` get only the fields it reads?~~ Yes, and
   passing the whole row is gone: an analysis that needs several fields names them all
   (`passFields`).

**Phase 3**

3. **Ship 3a first?** It handles the Production Schedule hand-edit case alone, at low risk. 3b
   then follows separately.
4. **Silent expiry:** main expires unconfirmed reads silently, by design, so stores keep showing
   their data until something else reloads them. With old values kept for comparison, a refill
   that comes back different could announce it. Should it, or should expiry stay silent?
5. **Unwatched keys:** is it OK that keys no store watches stay stale until their next read?
6. **Rollout switch:** ~~a setting in Preferences, or a code constant?~~ A code constant
   (`EARLY_CUTOFF`; answered 2026-11-18): a deploy takes about a minute, so a revert is the
   rollback.
7. **Lock listener:** sheetLockMixin re-checks locks on `api:getSheetLock` events. Under 3b it
   would hear only real changes. Please confirm nothing relies on the event firing for an
   unchanged lock.
8. **Server shape:** should change events for a future server carry only the key (client
   re-requests), or the new value too? The plan assumes key-only.

**Phase 4**

9. **Undo history:** a matched reload changes rows in place under the undo system, which holds
   row references. For editable stores with no unsaved edits, should a reload clear the undo
   history, as a full reload does today, or keep it?

## Order and size

| Phase | Work | Risk |
|---|---|---|
| 2 | Done | Cached values frozen in production; blocked changes surface |
| 3a | Small to medium | Low; sources only, today's cascade otherwise |
| 3b | Large | Medium; behind a switch, with cutoff and randomized tests |
| 4 | Medium, less than first planned | Medium; touches undo and editable stores |

3a and 3b compare old values lazily, which phase 2's freezing makes safe; 3b starts by moving the
first slice off its hashes. Phase 4 is independent and could run alongside 3a.
