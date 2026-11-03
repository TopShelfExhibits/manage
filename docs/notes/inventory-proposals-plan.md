# Inventory Proposals — Plan

**Status:** Implemented on `history-tools`, October 28, 2026.

**Goal:** let users collect proposed inventory changes ("buy 8 more chairs, rename this table") without touching real inventory, review them on a dedicated page, and commit them later through the normal inventory save.

---

## Decisions

| Decision | Choice |
|---|---|
| What an entry stores | A **change**, not a target. Quantity is a delta (`+8`, `-2`); purchasing needs "how many to buy". Description and notes store their new value. |
| Fields | All editable inventory fields: `quantity`, `description`, `notes`. |
| New items | Allowed. On **Update Proposal**, a confirm dialog says new items are created in inventory immediately at quantity 0; the proposal holds their quantity change. Cancel aborts. |
| Updating from a category page | Merge: each edited field overwrites that item's previous change for the field; untouched items stay. Creating a new proposal navigates to it. |
| Row label | `<Name> proposal`, no date. |
| Names | Unique ignoring case (across active and committed proposals), no renaming. Length: the `InventoryNoteMaxLength` preference minus `proposal: ` (25 → 15 characters). |
| After commit | Kept, immutable. Committed cards are styled gray and sorted after active ones. No management UI yet. |
| Commit safety | Two passes. Pass 1 locks every category and applies the edits to each category's store; any lock failure undoes everything. Pass 2 saves every category and releases its lock. If any affected category has unsaved edits, the commit refuses and asks the user to save or discard them first. |
| Overlapping proposals | Allowed. An item can show several proposal rows; each has an info button that opens that proposal, where the item can be removed (×). |
| Projected quantity | On the proposal page, for a date picked in the table header: saved quantity + scheduled changes due by that date + this proposal's change. This is the **owned total**, not availability (no show usage subtracted). |

---

## Storage

`CACHE` spreadsheet → `InventoryProposals` tab (created on first write). No other system reads CACHE tabs it does not know, and the tab has no `EditHistory` column, so proposals never reach edit history, pending changes, or reports.

One row per proposed item change:

| Column | Meaning |
|---|---|
| `Proposal` | Proposal name |
| `Category` | Inventory tab (e.g. `FURNITURE`) |
| `ItemNumber` | Item number in that tab |
| `Changes` | JSON `[{n, ne}]` — the same shape as scheduled changes. `quantity` ne is a signed delta; other fields are the new value. |
| `UpdatedBy` / `Updated` | Short user name / deciseconds since epoch |
| `CommittedBy` / `Committed` | Blank while active; set per row when that row's category was committed |

A proposal exists while it has at least one row. It is committed when all of its rows are committed (rows are marked per category, so a failed save can be retried without applying committed categories twice).

Text fields are applied as plain values; only `quantity` goes through `applyNeValue`, so a description such as `-5 ft pole` is never read as a delta.

---

## Flows

### Proposal from a category page

1. Save → the save dialog gains a **Proposal** button between Apply/Schedule and Cancel.
2. Proposal mode lists active proposals and a new-name field; **Update Proposal** confirms. Date and note are not used.
3. If the edits include new rows: confirm, then save those rows to inventory at quantity 0 (note `proposal: <name>`).
4. Merge the diff (vs. the saved rows) into the proposal, reload the category store (dropping the edits), which releases the lock.
5. New proposal → navigate to `reports/inventory-proposals/<slug>`.

### Category table

Under each item, after scheduled-change rows: one row per active proposal entry, labeled `<Name> proposal`, showing the quantity change (`+8`) and any new description/notes, with an info button that opens that proposal.

### Hamburger menu

Inventory pages show **View Proposals** when an active proposal exists → `reports/inventory-proposals`.

### Reports

- `reports` landing gets an **Inventory Proposals** card.
- `reports/inventory-proposals` — cards grid, one card per proposal (active first, committed gray at the end).
- `reports/inventory-proposals/<slug>` — the proposal page. `<slug>` is the lowercase name with non-alphanumerics as `-`.

`ReportsContent` (which hosts both pages) registers one child route per proposal from the shared proposal list, so breadcrumbs and deep links work on every Reports path.

### Proposal page

One table: image (read-only, as on the overview table), Category, Item#, Current Qty, Change (green `+` / red `-`), Projected Qty, Description, Notes, × (removes the item from the proposal).

- Projected date picker in the table's button bar (`card white`, "Projected on:"), defaulting to today.
- Editable with the standard lock (`INVENTORY_PROPOSALS:<name>`) and Save/Discard. Edited Description/Notes that match the current value drop that change; a zero quantity change drops it.
- **Commit** (disabled while dirty or committed) → the standard inventory save dialog, note required and prefilled `proposal: <name>`, date starting at the projected date, then the two-pass commit.
- Committed proposals are read-only with a banner.

---

## Code Map

| Area | File |
|---|---|
| Constants and all entry logic as pure helpers: names, slugs, diff, merge, replace (page save), mark committed, apply, projection | `docs/js/data_management/utils/proposal-utils.js` |
| Read and write the tab | `docs/js/data_management/api.js`: `getInventoryProposals`, `getInventoryProposalTable`; the three mutations are one-line wrappers over `_updateProposalEntries(transform)` (read → pure helper → write) |
| Shared proposal store, routes, two-pass commit | `docs/js/application/utils/inventoryProposals.js` |
| Save dialog, proposal rows | `docs/js/application/components/content/InventoryTable.js` |
| Menu item | `docs/js/application/components/content/InventoryContent.js` |
| Cards grid and proposal page | `docs/js/application/components/content/InventoryProposals.js`, routed from `ReportsContent.js` |
| Note length | `InventoryNoteMaxLength` preference (CACHE/Preferences, integer, default 25): `resolveInventoryNoteMaxLength` in `metadata-utils.js`, `Requests.getInventoryNoteMaxLength` for saves, `getInventoryNoteMaxLength()` (reactive) for the UI |

---

## Follow-Ups

- Proposal management (rename, delete, archive committed) if the list grows.
- `applyNeValue` treats any `+digit`/`-digit` string as a delta for every field; scheduled description changes starting with a sign have the same issue proposals avoid.
