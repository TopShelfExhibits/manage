# EditHistory Contract

Purpose: canonical contract for any agent, app, or automation that reads or writes row history.
Every writer of a tracked table (this web app, CAD automation, scripts) must follow it.

Status notes:

- Unmarked sections describe current implemented behavior.
- Sections marked **(Planned)** describe approved future behavior that is not implemented yet.

Current implementation lives in:

- `docs/js/data_management/utils/metadata-utils.js` — entry creation, aggregation, row matching, state reconstruction, pending changes
- `docs/js/data_management/abstraction/database.js` — save-time history generation, identity assignment, archiving
- `docs/js/data_management/abstraction/inventory-utils.js` — inventory scheduled (pending) changes
- `docs/js/data_management/abstraction/packlist-utils.js` — packlist flattening before save
- `docs/js/data_management/api.js` — CAD source alert (`checkCadSourceHistory`), archive reader (`getArchivedRows`), Notes/Preferences mappings

---

## Tracked Tables

A table is tracked when its sheet has an `EditHistory` column and its mapping maps it as `edithistory: 'EditHistory'`.

Naming rule: sheet headers are capitalized (`EditHistory`, `MetaData`); row objects in every layer (database, API, stores, UI, packlist crates and items) use the lowercase keys `edithistory` and `metadata`. Capitalized names appear in code only as header strings inside mappings and header parsing.

| Spreadsheet  | Tabs                   | Business key (informational only) | Notes                                                                     |
| ------------ | ---------------------- | --------------------------------- | ------------------------------------------------------------------------- |
| `INVENTORY`  | every category tab     | `ITEM#` → `itemNumber`            | Also carries scheduled changes in `p`                                     |
| `PACK_LISTS` | every packlist tab     | none                              | Crate rows and item rows are flattened into one row list before save      |
| `CACHE`      | `Notes`, `Preferences` | `Path`, `ID` → `id`               |                                                                           |
| `PROD_SCHED` | —                      | —                                 | Not tracked (no `EditHistory` column)                                     |

Business keys are **not** used for row matching (see Row Identity). They are listed so readers can label rows.

Saves rewrite a tab with only its mapped columns, so `EditHistory` is the only place guaranteed to carry row-level metadata across saves.

---

## Row EditHistory JSON Shape

Stored as a JSON string in the `EditHistory` cell:

```json
{
  "i": 7,
  "h": [
    {
      "u": "dan",
      "t": 17309064000,
      "s": "web",
      "c": [{ "n": "quantity", "o": "5" }]
    }
  ],
  "p": []
}
```

Root keys:

| Key | Meaning                                                                     |
| --- | --------------------------------------------------------------------------- |
| `i` | Row identity (see Row Identity). Positive integer.                          |
| `h` | History entries, newest first.                                              |
| `p` | Scheduled (pending) changes — inventory only, see Appendix.                 |

Writers must preserve root keys they do not understand.

### History entry (`h[]`)

Every `h` entry has `{u, t, s, c}`:

| Field | Meaning                                                                                              |
| ----- | ---------------------------------------------------------------------------------------------------- |
| `u`   | User short name (email prefix before `@`).                                                           |
| `t`   | Timestamp in deciseconds since epoch (`Math.floor(Date.now() / 100)`).                               |
| `s`   | Optional. Source or reason — see Source rules.                                                       |
| `c`   | Changed fields array. Empty array (`[]`) is a creation marker.                                       |
| `d`   | Optional. Present only on applied scheduled entries: when the change was scheduled (deciseconds). For those entries `t` is the effective date. |

Change item (`c[]`): `{ "n": <field>, "o": <old value> }`

- `n` is the **application field name** (the mapping key), not necessarily the sheet header. Inventory uses `itemNumber`, `quantity`, `description`, `notes`. Packlists, Notes, and Preferences map headers 1:1 to keys of the same text (packlist `MetaData` is mapped as `metadata`).
- `o` is the old value only; the new value is the current row value (or the `o` of the next-newer entry for that field).

### Source rules

- `cad` — written by CAD automation. The only value that means "CAD".
- `web` — this web app. Missing `s` and legacy `app` are read as `web`.
- Inventory web saves store the user's save note in `s` when one is given and **omit `s`** when there is no note; applied scheduled changes store their note in `s`. Readers must therefore treat **any value other than `cad`** as a non-CAD (web) entry. Older inventory entries may still hold `web` where no note was given; displays hide `web`/`app` as a note (`EditHistoryUtils.entryNote`).

---

## Row Identity

### Contract

- Each tracked row's identity is `EditHistory.i`: a positive integer, unique within its tab, **immutable** once assigned, and stored with the row.
- `i` is generated if absent on first touch: the first save that processes a row without `i` assigns one. Reads never write.
- Allocation: `i = (largest i present in the tab, counting both stored and incoming rows) + 1`. Numbering starts at `1`. Values are never reused or renumbered, and are independent of row position.
- When a row is moved, inserted around, or reordered, its `EditHistory` (including `i`) travels with it unchanged.

### Matching rows during a save

To diff a save, each incoming row is matched to its stored row:

1. **By `i`.** Incoming row with `i` ↔ stored row with the same `i`.
2. **Duplicate `i`** (a copied row carries the same `EditHistory`): the incoming row closest in position to the stored row keeps the identity. Every other copy is a new row: it gets a fresh `i` and a fresh history containing only a creation marker (copied `h` and `p` are dropped).
3. **Legacy rows (no `i`)** are matched only against stored rows that also lack `i`:
   - first by identical content (all fields except `edithistory`/`AppData`), nearest position wins;
   - then within the gap between the nearest matched neighbors, by most equal non-empty fields; if nothing is similar but the gap has equal counts on both sides, by order within the gap.
   This fallback only runs on a row's first touch; afterwards every row has `i`.
4. **Unmatched incoming row** → new row. Without prior history: `h` gets a creation marker (`c: []`) and a new `i`. With prior history but no `i` (unmatched legacy row): keeps `h`, gains `i`. With an `i` not present in the tab (moved in from elsewhere): kept as-is.
5. **Unmatched stored row** → deleted; archived (see Archive Table).

Business keys never participate in matching.

### Forward compatibility with an id column (Planned)

When tables migrate to a database (or gain an immutable id column), identity resolves as:

1. the table's immutable id column, when the table defines one;
2. otherwise `EditHistory.i`.

Migration seeds the id column from `i`. While any Sheets-based writer still exists, writers keep `i` equal to the id column. Archive `RowIdentifier` values (which are `i`) therefore remain valid row ids after migration.

---

## Write Rules (Required)

- Always parse existing `EditHistory`; never overwrite blindly. Preserve unknown root keys.
- Ensure the row has `i` (see Row Identity).
- Diff every mapped field except `edithistory` and `AppData`. `metadata` (the `MetaData` column, e.g. packlist grouping) **is** diffed and recorded.
- If there are no changes, do not append an entry.
- Otherwise build `{u, t, s, c}` and add it to the front of `h`, applying aggregation:
  - **Aggregation:** if the newest existing entry has the same `u`, the same normalized source (`s`, with missing/`app` → `web`), no `d`, a non-empty `c`, and its `t` is within one hour (36000 deciseconds) of the new entry, merge instead of adding: keep the existing entry's `o` for fields it already lists (it is the older value), add fields it does not list, set `t` to the new timestamp. Fields whose merged `o` equals the current value (edited and reverted) are dropped; if nothing remains the merged entry is removed.
  - Creation markers (`c: []`) and applied scheduled entries (with `d`) are never merged into.
- Cap `h` at **10** entries (drop the oldest). The cap keeps cells well under the Google Sheets 50,000-character cell limit.
- Readers must not assume one entry per save (aggregation merges saves).

---

## Reconstructing Past Row States (Readers)

Each `h[k]` entry stores the metadata of change *k* (`u`, `t`, `s`) and the **old** values of the fields it changed (`o`). The state *after* change *k* is not stored on entry *k*; readers rebuild it:

1. Start from the row's **saved** values (never from unsaved edits).
2. State after `h[0]` = the saved values.
3. For *k* = 1, 2, …: state after `h[k]` = state after `h[k-1]` with every `o` in `h[k-1].c` applied. Keep one running copy, because `c` lists only changed fields.
4. If the oldest entry is a creation marker (`c: []`), its state is the row as created. Otherwise, applying the oldest entry's `o` values gives the earliest known state (history may have been capped).
5. Ignore `c` items without `n` (planned move records) and the `p` array.

Applied scheduled entries are read like any other entry, using `t`.

Restoring ("reverting to") a past state writes that state's field values onto the row. This rewinds every newer change, and the save that follows records a normal history entry.

Implemented in `EditHistoryUtils.getHistoryStates` (used by the inventory Edit History page and the item timeline).

## Archive Table (Deleted Rows)

Rows that disappear during a tracked save are appended to the `_EditHistory` tab in the **same spreadsheet** as the source tab (created on demand; hidden from tab lists by the `_` prefix). Existing archive rows are never rewritten.

| Column          | Value                                                                 |
| --------------- | --------------------------------------------------------------------- |
| `SourceTable`   | Spreadsheet id (`INVENTORY`, `PACK_LISTS`, `CACHE`)                   |
| `SourceTab`     | Tab name                                                              |
| `RowIdentifier` | The row's `i`; `row_<n>` (1-based stored position) for a row deleted before it was ever assigned `i` |
| `Username`      | Full email of the deleting user                                       |
| `Timestamp`     | Deciseconds                                                           |
| `Operation`     | `delete`                                                              |
| `RowData`       | JSON of the stored row, including its `edithistory`                   |

Rows with no content and no history are not archived.

---

## Current Save Paths

| Path                                    | History                      | Notes                                               |
| --------------------------------------- | ---------------------------- | --------------------------------------------------- |
| Inventory save (apply now)              | tracked, `s` = note or none  | via `Database.setData`                              |
| Inventory save (scheduled, future date) | `p` entry only               | writes with `skipMetadata`; `i` assigned on next tracked save |
| Inventory apply/edit/delete pending     | moves/edits `p`, `h`         | writes with `skipMetadata`; preserves `i`           |
| Inventory proposal commit / new items   | tracked, `s` = note          | normal inventory save; note defaults to `proposal: <name>`. Proposals themselves live in `CACHE/InventoryProposals` (no history) |
| Packlist save                           | tracked, `s` = `web`         | crates and items flattened, then matched by `i`     |
| CACHE Notes / Preferences save          | tracked, `s` = `web`         |                                                     |
| Other CACHE writes (user data, locks…)  | none                         | `skipMetadata` or no `EditHistory` column           |

---

## Packlist CAD Warning Logic

Purpose-built for packlists. It reads `s` only to distinguish `cad` from everything else, so inventory notes in `s` do not affect it, and it is not run on inventory tables.

Analysis key: `cadSourceAlert` in packlist item `AppData`.

Trigger condition:

- Most recent history entry source is `cad`, and
- there is any earlier normalized `web` entry.

Alert payload includes:

- `message`: `changed in cad by <user>`
- `previousWebSummary`: last web edit before the leading CAD block
- `restoreChanges`: old-value changes collected from the contiguous leading CAD entries, newest first

Restore behavior in Packlist UI:

- Alert card is clickable.
- Modal shows: `Previously: <previousWebSummary>`.
- Restore applies `restoreChanges` in order (`item[change.n] = change.o`), so the oldest CAD entry's value wins.
- Restore button is disabled outside edit mode.

---

## Guidance for External Automation

To stay compatible, for every row written:

1. Read the row and parse `EditHistory` JSON (treat empty as `{}`).
2. If `i` is missing, assign `max(i in tab) + 1` (start at 1). Never change an existing `i`.
3. When copying a row, give the copy a new `i` and a fresh `h` with a creation marker; do not copy `p`.
4. When inserting a new row, write `{"i": <new>, "h": [{"u", "t", "s", "c": []}]}`.
5. Compute diffs against pre-write values and create `{u, t, s, c}` with `s = cad` for CAD writes.
6. Prepend to `h` (aggregation is recommended, not required, for external writers), cap at 10, preserve other root keys, reserialize.
7. Write business fields and `EditHistory` together atomically when possible.
8. When deleting a row, append it to `_EditHistory` in the same spreadsheet with the columns above.

---

## (Planned) Move Records

Moves can be detected at save time from matching (a matched row whose position changed relative to its matched neighbors). If implemented, a move is recorded inside `c` as `{ "m": <previous position> }`. Only genuine reorders should be recorded, not position shifts caused by inserting or deleting other rows. Readers must ignore `c` items without `n`.

---

## Appendix: Scheduled (Pending) Quantity Changes — Date-Based Inventory Queries

Inventory rows carry a `p` array inside their `EditHistory` value. These are future-dated changes that have not yet been applied to the live row data. To query inventory as it will appear on any given date, a reader must apply all pending entries whose effective date falls on or before the query date.

### Pending Entry Shape

```json
{
  "u": "dan",
  "t": 17400000000,
  "d": 17380000000,
  "s": "restock",
  "c": [{ "n": "quantity", "ne": "+5" }]
}
```

Field contract:

- `u`: user short name (email prefix before `@`).
- `t`: **effective date** in deciseconds (start-of-day precision — compare dates only, ignore time-of-day).
- `d`: creation timestamp in deciseconds (when the entry was scheduled).
- `s`: note text, at most the `InventoryNoteMaxLength` preference (CACHE/Preferences, default 25). The same limit applies to inventory notes in `h` entries.
- `c`: changed fields array.
- `n`: application field name (e.g. `"quantity"`).
- `ne`: new value descriptor — either an absolute value (`"10"`, `10`) or a numeric delta string (`"+5"`, `"-2"`). A delta string starts with `+` or `-` followed by a digit. Numeric fields are always scheduled as deltas.

### Algorithm: Project Inventory to a Reference Date

1. Read `edithistory` from the row and parse the JSON.
2. Normalize the reference date to start-of-day (midnight local time), expressed in deciseconds.
3. Filter `p` entries where `entry.t` (normalized to start-of-day deciseconds) `<=` reference cutoff.
4. Sort the filtered entries ascending by `t`.
5. For each entry in order, apply each change in `entry.c`:
   - If `ne` is a string matching `/^[+\-]\d/`, treat it as a numeric delta: `newValue = parseFloat(currentValue) + parseFloat(ne)`.
   - Otherwise treat `ne` as an absolute replacement: `newValue = ne`.
6. The result is the projected row state on that date.

### Application Lifecycle

- When the application processes a date at or past today, it calls `checkAndApplyPendingChanges`, which applies due entries permanently: they are removed from `p` and prepended to `h` as `{u, t, d, s, c: [{n, o}]}` (capped at 10), where `o` is the value before applying. After this, the live row data reflects those changes.
- Before that permanent apply, the `p` entries are the only source of truth for future state — live row values do not include them.
- Entries in `p` have no cap on array length; they accumulate until applied or deleted.

### Inventory Column Mapping

| Sheet column header | Application field name (`n`) |
| ------------------- | ---------------------------- |
| `ITEM#`             | `itemNumber`                 |
| `QTY`               | `quantity`                   |
| `Description`       | `description`                |
| `NOTES`             | `notes`                      |
| `EditHistory`       | `edithistory`                |
