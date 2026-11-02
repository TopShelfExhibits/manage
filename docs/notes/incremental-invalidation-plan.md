# Incremental Invalidation Plan

**Branch:** api-separation
**Status:** Phase 1 done (commit 28a87dd). Phases 2–4 proposed; questions below need answers first.

## Goal

When data changes, recompute only what the change affects, and tell stores only about values
that actually changed. A store row whose inputs didn't change is never blanked, re-analyzed or
re-rendered. A store whose main data comes back identical is not reloaded.

Keep the API layer (`data_management/`) and the reactive stores (`application/utils/reactiveStores.js`)
separate, so the API layer can later move to a server. The contract between them stays one kind
of message: "cache key K (method + args) has a new value".

## How it works today

1. **Invalidation deletes top-down.** `CacheManager.invalidate` deletes a key, then every key
   that depends on it, then their dependency records, and emits a bus event for every `api:` key
   it deleted. Nothing checks whether a value changed.
2. **Main data reloads replace every row.** A main-key event makes the store refetch, deep-copy
   all rows, clear every analysis result, and re-run all analysis.
3. **Whole-tab reads fan out.** Most analysis depends on whole-tab reads (`getData`, `getTabs`).
   One cell edited in CACHE/Clients invalidates every row's index check, and also the main
   Production Schedule data, because that load reads the index too.

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
  On the Schedule page, an invalidation of the packlist tab list now keeps all 41 packlist cells
  on screen.

**Limit:** a cascade that reaches the main data, for example a CACHE/Clients change on the
Schedule page, still reloads and blanks everything. Phases 3 and 4 address that.

## Phase 2 — an immutability boundary

Early cutoff (phase 3) compares a recomputed value with the cached one. That only works if
nothing mutates cached values, and today two things do:

- `store.load` runs `appDataInit` on the API result before `setData` clones it, so the cached
  array gains `AppData`.
- The packlist `checkInventoryLevel` config uses `passFullItem`, so its argument, and therefore
  its cache key, is the whole reactive row including `AppData`. The key changes whenever
  `AppData` changes, which also defeats the cache for that call.

Work:

1. Clone at the store boundary: run `appDataInit` only on the store's own copy.
2. Strip `AppData` from full-item arguments, or replace `passFullItem` with explicit source
   columns (see question 2).
3. In development, deep-freeze values on `CacheManager.set` so any remaining mutation throws in
   tests instead of silently corrupting comparisons.
4. Keep a value hash per entry (computed on set), so comparisons stay cheap and still work
   after the TTL drops the value.
5. Record a placeholder for results `set()` refuses to cache today (null, empty, boolean), so
   these keys have something to compare against (see question 3).

## Phase 3 — early cutoff in the cache

1. **Mark, don't delete.** Invalidating a key marks it stale and its transitive dependents
   unverified. Values and dependency records are kept.
2. **Verify bottom-up.** Refetch the stale key and compare its hash with the old one. If equal,
   mark everything above verified without rerunning. If different, rerun the direct dependents
   and compare each in turn; stop wherever a value comes out the same. A dependent with several
   dependencies reruns once, after all of them are verified.
3. **Announce changes only.** The bus emits for an `api:` key only when its value changed.
4. **Dependencies are replaced, not cleared.** A rerun rebuilds its own dependency set, since
   dependencies can differ between runs.
5. **Reverse index.** Keep dependency → dependents, instead of today's scan of every key per
   invalidation.
6. **Who verifies.** Keys with a live store subscriber are verified right away. Others are
   verified lazily on their next read (see question 4).
7. **Contracts to restate.** The ordering rules in `invalidate`'s comment block, the poller's
   use of `filled`/`filledAt` (becomes "verified at"), and the save-time
   `stampDataChange`-before-refill ordering, which must be preserved.
8. **Switch.** Run behind a setting that falls back to delete-cascade (see question 6).

Expected effect: a CACHE/Clients edit refetches Clients and reruns every function that reads it
(in memory, from cache). Only rows whose index state actually changed get an event. The
Schedule's main data reruns, comes out identical, and the store is not reloaded.

## Phase 4 — row matching on main-data reloads

When a store's main key does change, match rows instead of replacing them:

- Each store declares a row identity: a function from row to key.
- Unchanged rows keep their objects and analysis results.
- Changed rows are updated in place and re-analyzed.
- New rows are added and analyzed; missing rows are removed.
- Order follows the new data, using moves rather than a rebuild.
- Stores with unsaved edits keep today's behavior: flag the conflict and don't reload.

The runtime `_rowId` can't be the identity: it's random and regenerated on each reload.

## Testing approach

- Extend the FakeGoogle fault hooks: edit one cell of a tab, then assert which `api:` keys
  emitted and which store rows were written (Vue watchers with `flush: 'sync'`, as in Phase 1).
- Assert no event for unchanged values: an edit that rewrites the same value, or a cell no
  function reads.
- Add counters (bus events emitted, functions rerun, rows written) exposed on localhost, to
  compare phases on real pages.
- Keep the seeded randomized approach from the instant-write tests for the cutoff logic. Random
  edit sequences must leave every cached value equal to a from-scratch recompute.

## Questions

**Phase 2**

1. **Boundary enforcement:** is dev-only deep freezing acceptable, or should values be frozen in
   production too? Freezing large tabs costs time on every cache fill.
2. **Full-item analysis:** for the packlist inventory-level check, may I replace `passFullItem`
   with explicit source columns (the fields `checkInventoryLevel` actually reads)? Or strip
   `AppData` from full-item arguments everywhere?
3. **Empty results:** `set()` never caches null, empty arrays, empty objects or booleans. Is that
   deliberate, for example so an empty read is retried after an auth hiccup? If so, I'll store a
   hash only (for comparison) and still re-run these keys on every read.

**Phase 3**

4. **Eager vs lazy:** is it OK that keys no store watches are verified only when next read?
   This keeps network use down, but a value can be stale in memory until then.
5. **TTL expiry:** today an expired entry refetches silently on next read and stores are never
   told. With hashes, expiry could also detect changes, like a slow poller, and notify stores.
   Should expiry stay silent, or notify when the refetched value differs?
6. **Rollout switch:** do you want the fallback setting in Preferences, so a live session can
   turn early cutoff off, or only as a code constant?
7. **Lock listener:** sheetLockMixin re-checks locks on `api:getSheetLock` invalidation events.
   Under phase 3 it would hear only real changes. That's intended, but please confirm nothing
   relies on the event firing for an unchanged lock.
8. **Server shape:** for the eventual server, should change events carry only the key (client
   re-requests), or the new value too? Key-only is simpler and is what this plan assumes.

**Phase 4**

9. **Row identities.** Please confirm or correct each:
   - Schedule: Client + Year + Show, with position among duplicates for multi-booth rows.
   - Inventory: item number.
   - Packlists: crate position plus item position, falling back to replacing the store.
10. **Undo history:** a matched reload changes rows in place under the undo system, which holds
    row references. For read-only stores this is fine. For editable stores with no unsaved
    edits, should a reload clear the undo history, as a full reload does today, or keep it?

## Order and size

| Phase | Work | Risk |
|---|---|---|
| 2 | Small to medium | Low; mostly boundary cleanup with tests |
| 3 | Large; the core of the change | Medium; behind a switch, with cutoff and randomized tests |
| 4 | Medium | Medium; touches undo and editable stores |

Phase 3 depends on phase 2. Phase 4 is independent but pays off most after phase 3, which makes
main-data reloads rare.
