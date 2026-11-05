# Incremental Invalidation Plan

**Branch:** api-separation (main merged in at 91da36b)
**Status:** Phase 1 done (commit 28a87dd) and passing with main's caching work. Phases 2–4 have been
re-assessed against main. The questions at the end need answers first.

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
dependents by scanning every key, and announces every `api:` key it deleted. Phases 2–4 are
still needed. Main makes phase 3 both more valuable and cheaper, as described below.

## Phase 1 — targeted re-analysis (done)

- Each analysis run records which rows produced which cache key (config id → args → rows).
- An analysis event re-runs only the rows behind that exact key, after the existing 150 ms
  debounce. Current values stay on screen until the new ones arrive.
- A result equal to the current one is not written, so there is no reactive update and no
  re-render.
- Targets that arrive during a full run are queued until it ends. Targets that arrive during a
  main reload are dropped, because analysis runs after the reload.
- Configs whose key can't be predicted (`passFullItem`) re-run all their rows, without blanking.
- Tests: the TARGETED ANALYSIS group in tests.js, three tests that fail on the old store code.
  The suite passes with main merged (343 tests).

**Limit:** a cascade that reaches the main data still reloads and blanks everything. On the
Schedule page this is now the common case: any hand edit anywhere in the Production Schedule
spreadsheet invalidates every read of it.

## Phase 2 — an immutability boundary (still needed)

Early cutoff compares a recomputed value with the cached one, so cached values must not be
mutated. Both problems found before the merge remain, and the first matters more now that sheet
reads stay cached indefinitely:

- `store.load` runs `appDataInit` on the API result before `setData` clones it
  (reactiveStores.js, `appDataInit(dataToSet, false)`), so the cached array gains `AppData`.
- The packlist `checkInventoryLevel` config still uses `passFullItem`. Its cache key is the whole
  reactive row, `AppData` included, so the key changes whenever `AppData` does.

Work:

1. Clone at the store boundary: run `appDataInit` only on the store's own copy.
2. Give `checkInventoryLevel` the fields it reads (see question 2).
3. In development, deep-freeze values on `CacheManager.set` and `fillCache`, so remaining
   mutations throw in tests.
4. Store a value hash per entry (computed on set and on `fillCache`), kept when a value expires,
   so comparisons stay cheap and survive `expire()`.
5. Record a hash for results `set()` doesn't keep (null, empty, boolean), so these keys can be
   compared too. Main's `keepEmpty` already caches empties for persisted methods.

## Phase 3 — early cutoff, in two steps

### 3a. Cutoff at the sources

When a source is invalidated by the poller (stamp or hand edit) or by the date rollover, read
the new value first and compare its hash with the old one. Only a source whose value changed
runs today's cascade. An unchanged source announces nothing.

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

1. **Mark, don't delete.** A changed source marks its transitive dependents stale (the
   `expire()` idea: keep dependency records, don't announce) and keeps their values for
   comparison.
2. **Verify bottom-up.** Recompute the direct dependents of what changed and compare each with
   its old hash. Where a value comes out the same, stop. A dependent with several dependencies
   recomputes once, after all of them are verified. Generations guard every step, as
   `_changedSince` does today.
3. **Announce changes only.** The bus emits for an `api:` key only when its value changed.
4. **Dependencies are replaced, not cleared,** on every recompute, since they can differ between
   runs.
5. **Reverse index:** dependency → dependents. This replaces the full scan in both `invalidate`
   and `expire`.
6. **Who verifies:** keys with a live store subscriber are verified right away. Others stay
   stale until their next read (see question 4).
7. **Persisted results:** a restored value is hashed like any other. Its re-linked sources cut
   it off the same way.
8. **Contracts to restate:** the ordering rules in `invalidate`'s comment block, the poller's
   use of `filled`/`filledAt` (it becomes "verified at"), the stamp ordering in
   `stampDataChange`, and `fillCache`'s "a read still in flight keeps its result" rule.
9. **Switch:** a setting that falls back to delete-cascade (see question 6).

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

**Phase 2**

1. **Freezing:** is dev-only deep freezing acceptable, or should values be frozen in production
   too? Freezing large tabs costs time on every cache fill.
2. **Full-item analysis:** may I give `checkInventoryLevel` the fields it actually reads,
   instead of the whole packlist row?

**Phase 3**

3. **Ship 3a first?** It handles the Production Schedule hand-edit case alone, at low risk. 3b
   then follows separately.
4. **Silent expiry:** main expires unconfirmed reads silently, by design, so stores keep showing
   their data until something else reloads them. With hashes, a refill that comes back different
   could announce it. Should it, or should expiry stay silent?
5. **Unwatched keys:** is it OK that keys no store watches stay stale until their next read?
6. **Rollout switch:** do you want the fallback setting in Preferences, so a live session can
   turn early cutoff off, or only as a code constant?
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
| 2 | Small to medium | Low; boundary cleanup with tests |
| 3a | Small to medium | Low; sources only, today's cascade otherwise |
| 3b | Large | Medium; behind a switch, with cutoff and randomized tests |
| 4 | Medium, less than first planned | Medium; touches undo and editable stores |

3a needs only phase 2's hashes for source values. 3b needs all of phase 2. Phase 4 is
independent and could run alongside 3a.
