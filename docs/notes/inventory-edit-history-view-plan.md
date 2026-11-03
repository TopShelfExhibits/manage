# Inventory Edit History View — Implementation Plan

**Status**: Implemented October 23, 2026 (see "As built" at the end)
**Created**: October 22, 2026
**Contract**: `metadata-implementation.md` (EditHistory Contract)
**Estimate**: ~400–500 lines across 8 files, 1.5–2 days including tests

## Goal

A read-only page per inventory category, `inventory/<category>/edit-history` (breadcrumb "Edit History"), opened from the hamburger menu. Under each item, it shows that item's past states, newest first, with who changed it, when, and why. A revert button loads any past state into the table so it can be saved. The item timeline is updated to use the same history logic.

Packlists are out of scope. Their history (nested crates, header-named fields, CAD alerts) probably needs a different view. The shared helper is table-agnostic, so a packlist view or a global mixin can be extracted later if needed.

## Decisions

| Topic | Decision |
| --- | --- |
| Location | Separate page `inventory/<category>/edit-history`. The menu button only appears while a category table is open |
| Scope | History helper is table-agnostic; UI targets inventory only |
| Rows | Main row, then past states newest first. **No pending rows** on this page (they stay on the category table) |
| Oldest state | Last row is a "Created" row when the oldest entry is a creation marker (`c: []`), otherwise an "Earliest recorded" row with blank metadata |
| Dates | Every entry shows its `t`. Applied scheduled entries are treated like normal entries; `d` is not shown |
| Note column | Shows `s` exactly as stored (an inventory reason, `web`, or `cad`) |
| Deleted rows | Shown as gray rows at the end when `_EditHistory` has rows for this tab. Inventory can't delete rows yet, so this is mostly future-proofing |
| Existing bad entries | Show everything; data is corrected by hand where needed |
| Revert | Restores the item to the state shown on that row, undoing every newer change. The state is applied to the reactive store and saved with the normal Save on this page or on the category page |
| Item timeline | Rebuilt on the shared helper so all fields and notes are shown correctly |

**Revert semantics (decided October 23, 2026):** revert on a history row **restores the item to the state shown on that row**, fully rewinding every change newer than it. It never undoes a single entry in isolation while keeping newer changes, because that can produce states that never existed. The main row has no revert button (it is the current state). The "Created" / "Earliest recorded" row can be reverted to, which restores the oldest known values.

## How states are built (the index shift)

Each `h[k]` entry stores the change's metadata (`u`, `t`, `s`) and the **old** values of the fields it changed (`o`). The state *after* change *k* isn't stored on entry *k*. It's rebuilt by starting from the saved row and applying the `o` values of every newer entry, newest first:

| Row | Field values | Gray columns |
| --- | --- | --- |
| Main row | current values | `h[0]` |
| History row *k* (k ≥ 1) | saved row with `h[0..k-1].o` applied | `h[k]` |
| Last row | saved row with all `o` applied | "Created" (`h[last]` with `c: []`) or "Earliest recorded" (blank) |

Rules:

- **Rewind from the saved row (`originalData`), never from unsaved edits.** Otherwise a pending revert or edit would corrupt every reconstructed state.
- `c` lists only changed fields, so the rewind is cumulative: keep one running copy of the row.
- On each history row, the fields whose value differs from the next-newer row (the row above, or the current row for the first history row) are highlighted, so each highlight marks a value that a later change replaced. A highlighted cell whose value was empty shows a red italic *(empty)* placeholder. The current row has no change highlighting. All fields are shown (the full state), so a revert button's effect is visible.
- While an item has unsaved changes (after a revert, before Save), the main row shows the live values, with the unsaved fields tinted red and "Unsaved" in the Date column. The saved state becomes the first history row, labeled "Saved", with its own revert button (which undoes the unsaved change for that item).
- `c` items without `n` (planned move records) are ignored.

This algorithm is also added to the contract as a reader section ("Reconstructing past row states"), so other apps reconstruct states the same way.

## Blockers found in the current code

1. **The Save button never appears on a read-only table.** `TableComponent` shows Save only when its own dirty-cell tracking flags a change, and that tracking only runs when some column is editable. `InventoryTable` passes `external-dirty-state`, but `TableComponent` never reads it. **Fix:** `TableComponent` shows Save/Discard when `externalDirtyState` is true. This is needed for revert-then-save on the history page.
2. **Deep links can briefly show the wrong page.** Until the category tabs load, `edit-history` isn't a registered route, so `inventory/furniture/edit-history` would match the item timeline and try to load an item called "edit-history". **Fix:** for 3-segment inventory paths, show a loading state until the categories store has loaded, then decide between a registered sub-route and the timeline.

## Implementation steps

### 1. History helper — `metadata-utils.js`

`EditHistoryUtils.getHistoryStates(row, fields = null)` returns rows of:

```js
{ kind: 'current' | 'change' | 'created' | 'earliest',
  state: { ...fieldValues },      // full row values at this point
  entry: { u, t, s, c } | null,   // metadata shown in the gray columns
  changed: Set<string> }          // fields this entry changed (for highlighting)
```

- Pure; reads only `edithistory.h`; ignores `p`.
- `fields` limits which keys appear in `state` (inventory passes `quantity`, `description`, `notes`, `itemNumber`).
- Returns only the `current` row when there's no history.

### 2. Routes — `InventoryContent.js`

- When the categories store loads, register each category and its history page with `NavigationRegistry.addDynamicRoute`:
  - `inventory` → `<slug>` (display name: the category title)
  - `inventory/<slug>` → `edit-history` (display name: "Edit History")
- In the template, check for a registered route **before** the item-timeline branch:
  1. 3-segment path whose last segment is a registered child route → history page (`<inventory-table history-mode>`).
  2. Otherwise → item timeline (existing behavior).
  3. Categories still loading → loading message (blocker 2).
- Read `NavigationRegistry.routeRegistrationVersion.value` in the computed property so it re-evaluates when routes register.
- Breadcrumbs pick up "Edit History" automatically from the registered display name.

### 3. Menu — `InventoryMenuComponent`

- Use the `containerPath` prop (supplied fresh each time the menu opens), not the `tabTitle` captured at registration time. Remove `tabTitle` from the registered props.
- On `inventory/<category>`: show **See Edit History**, which navigates to `inventory/<category>/edit-history` and keeps `searchTerm`.
- On `inventory/<category>/edit-history`: show **Back to Table**.
- Hidden on the overview, the categories view, and item timelines.

### 4. Table — `InventoryTable.js` (`historyMode` prop)

**Columns**
- `quantity`, `description` and `notes` get a new flag, `historyField: true`, marking them as the fields shown in history and pending sub-rows.
- In history mode:
  - no column is `editable`;
  - the `_navigate` (☷) column is removed;
  - four columns are added at the end: **Date**, **User**, **Note** (gray, via `cellClass`) and **Revert** (button, `sticky: 'end'`).
- The main row's gray cells show `h[0]` metadata; its Revert cell is empty.

**Sub-rows** (shared renderer, used by both history rows and the category page's pending rows)
- Built by looping over the `visibleColumns` slot prop instead of hardcoding cells:
  - leading run of non-`historyField` columns (image, item#) → one cell with `colspan` = run length, holding the row label (date or "Created");
  - `historyField` columns → the value at that state, highlighted if changed;
  - gray metadata columns → `u` / formatted `t` / `s`;
  - Revert column → button (history rows only);
  - any other column → empty cell.
- This also fixes the existing pending-row misalignment on tabs that hide quantity or item number.

**Behavior**
- `forceDetails` is always on in history mode.
- `rowDetailsVisible` = the item has history.
- No pending rows in history mode.
- History is parsed once per item into a computed `Map` keyed by `itemNumber`, from `originalData`.

**Revert**
1. Acquire the edit lock (`acquireLockForEdit`, same as a cell edit); stop if it fails.
2. Capture undo state (`undoRegistry.capture`).
3. Write the state's `historyField` values onto the matching `store.data` row (matched by `itemNumber`).

The history page and the category page use the same reactive store (same `getReactiveStore` key), so the change shows up and can be saved on either. Save opens the normal `InventorySaveModal`, with the note prefilled as `revert to <date>` (still editable, max 25 characters).

**Deleted rows**
- Load `_EditHistory` rows where `SourceTable = INVENTORY` and `SourceTab = <category>`.
- Show each as a gray row after the items: values from `RowData`, metadata "Deleted by `<user>`" with its timestamp. No revert button.

### 5. Archive read — `api.js`

`Requests.getArchivedRows(deps, tableId, tabName)` (cached):
- Returns `[]` when the spreadsheet has no `_EditHistory` tab. Check `getTabs` first, because reading a missing tab throws on real Sheets.
- Otherwise returns the matching rows with `RowData` parsed.

### 6. Table component — `tableComponent.js`

Show Save/Discard when `externalDirtyState` is true (blocker 1). Declare the prop if it isn't declared.

### 7. Item timeline — `getItemTimeline` in `inventory-utils.js`

Rebuild the "Inv. Change" events on `getHistoryStates`:
- The change column shows every changed field as `field: old → new`, not just the field name. Quantity keeps its delta form (`quantity: +2`).
- The note column shows `u: s`, the same text as the history page's User and Note columns.
- Creation markers become a **Created** event, not an empty "Inv. Change".
- Quantity rewinding uses the reconstructed states instead of its own replay loop, so both views agree.

Also fix the pending-entry labels:
- A delta on a field other than quantity is currently labelled `quantity: …`.
- The sign handling is convoluted. Use `n: ne` for absolute values and `n: +x` / `n: -x` for deltas.

### 8. Tests — `tests.js` (fixtures already in FakeGoogle)

| Test | Fixture / method |
| --- | --- |
| Multi-entry rewind, partial `c`, field highlighting | CHAIR-003 (3 entries) |
| Applied scheduled entry treated as a normal entry | CHAIR-004 after `checkAndApplyPendingChanges` |
| Created vs earliest-recorded last row | constructed rows |
| States rebuilt from saved values, not unsaved edits | edit store row, then compute states |
| `edit-history` resolves to the history page, not an item | route resolution with registered routes |
| Revert writes the state to the store row and marks it dirty | store test |
| `getArchivedRows` returns `[]` with no archive tab; parses rows when present | FakeGoogle INVENTORY `_EditHistory` fixture |
| Timeline shows `old → new` labels and a Created event | CHAIR-003 / constructed row |

Locally: `fakeGoogle.history('INVENTORY', 'FURNITURE', 'CHAIR')`, plus `advanceClock` to check merged entries.

## Files

| File | Change |
| --- | --- |
| `data_management/utils/metadata-utils.js` | `getHistoryStates` |
| `data_management/api.js` | `getArchivedRows` |
| `data_management/abstraction/inventory-utils.js` | timeline rebuilt on the helper; pending label fix |
| `application/components/content/InventoryContent.js` | route registration, template branch order, menu |
| `application/components/content/InventoryTable.js` | `historyMode`, `historyField`, shared sub-row renderer, revert, deleted rows |
| `application/components/interface/tableComponent.js` | honor `externalDirtyState` |
| `tests/tests.js` | new test group |
| `notes/metadata-implementation.md` | reader section: reconstructing past row states |

## Out of scope / later

- Packlist history view (likely a different design).
- Reverting by source (e.g. "undo all CAD changes"), and editing history entries.
- Deleting inventory rows, and restoring deleted rows from the archive.
- Move records (`m`) in the history view.

## As built

Implemented as planned, with these additions found during browser testing:

- **Route registration watches category titles, not `categoriesStore.data`.** The store fills its array in place, so a shallow watcher on `data` never fired on a cold load, and `edit-history` was never registered. `InventoryContent` now watches a computed list of titles. `categoryRoutesReady` resolves as soon as the category route exists, or once the category list has loaded (for unknown categories).
- **The history page reloads its store right after a save.** The store otherwise refreshes only when the change poller next runs, so the entry a save recorded appeared several seconds late.
- **The revert note** reads `revert to <Mon D, YYYY>`, `revert to earliest`, or `revert to creation` (25-character limit).
- **The `history` icon was added to the Material Symbols subset** in `index.html`; it's used for the revert column header.
- **Archive constants are shared:** `ARCHIVE_TAB_NAME` and `ARCHIVE_HEADERS` are exported from `metadata-utils.js` and used by both the archive writer and `getArchivedRows`.
- **Sub-row styles** (`.history-meta`, `.history-changed`, `.history-unsaved`, `.history-unsaved-label`, `.history-empty`) are in `styles.css`. Rows carry `.detail-row` plus `.detail-row-pending` or `.detail-row-history` as unstyled hooks.
- **Change highlighting is toggled per view** by `HIGHLIGHT_CHANGES` in `InventoryTable.js`: on for the Edit History page, off for pending (scheduled) rows on the category table. Unsaved-value marking on the history page is not affected by the flag.
- **Tests:** group "EDIT HISTORY VIEW" in `tests.js` (8 tests). Routing, revert, save and alignment were checked in a browser: they need a mounted page, which the console test runner doesn't provide.

