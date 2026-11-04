# Views System & Unified Renderers: Refactor Plan

**Status:** revision 9, decisions applied; Phases 0–6 implemented and committed on `views-system`, awaiting manual testing · **Branch:** `views-system` · **Date:** 2026-11-02

## Implementation status (2026-10-30)

All six phases are implemented in the working tree. The in-browser suite passes (207 tests, including new `VIEWS *`, `INSTANT WRITE` and `VIEWS CARDS` groups), and every migrated page was rendered headlessly against FakeGoogle.

**Before deploying**

- **Live data for Phase 2.** Add the `InstantWriteTables`, `DesignQueueFields` and `DesignQueueAssignees` preference rows (values in §4.16), the `Assignee` column on the Production Schedule, and a `CACHE/ShowNotes` tab with headers `Identifier | Note | EditHistory`. Until then the design queue shows its cells read-only with a "write disabled" hint, and notes can't be saved.
- **Manual testing period (R3.11)** on the dev site, using the §9 checklist. Not yet exercised by hand: dashboard cards (view switch rewriting the card path, double-wide cards at the medium tier), print, drag/drop and clipboard in edit mode, and the §4.17 audit of the formerly content-sized modals at `card` width.

**Where things live**

- Engine: `js/application/utils/views/` (`resolveView.js`, `cardsAdapter.js`, `fieldFormat.js`, `viewColor.js`, `searchMatch.js`), `js/application/utils/useContainerSize.js`.
- Components: `dataViewComponent.js`, `viewSelectComponent.js`, `contentHeaderComponent.js`, `rowDetailsComponent.js`, `cells.js` (registry: image, itemId, navigate, checkbox, select, text).
- Data layer: `data_management/abstraction/scheduleFields.js`, `instant-write-utils.js` (`writeCellsVerified`, `saveShowNote`), `utils/checkbox-values.js`, `utils/instant-write-config.js` (the preference and the failure messages); `Requests.writeCellsVerified / saveShowNote / getShowNotes / getJsonPreference / getInstantWriteConfig`.
- New page: `content/DesignQueueContent.js` (route `schedule/design-queue`, Schedule hamburger menu → Design Queue).

**Choices made during implementation (all reversible)**

- `cell-edit` is now `(rowIndex, columnKey, value)`; dirty state is keyed by column key.
- Decorations take a `decorationKeys` list; a decorated key a renderer doesn't display moves to row level (chip end, card footer, details button bar), which is how calendar chips gained the transship badges (D5).
- Fields may carry `cellOptions` (e.g. which key holds the item number for the image cell) and `format: 'multiline'`.
- The calendar skips table group-master rows, so ItemReport uses one row set for both views.
- PacklistTable resolves its views directly (no DataView), per C3.
- The renderer contract keeps individual state props (`isLoading`, `error`, …) instead of one `state` object. Every renderer (table, calendar, cards) takes `resolved`, `data`, `action` and decorations; cards build their cards with the adapter themselves.
- `resolved.sort` is always a list of `{ key, direction }`. Whether search hides rows is view data only (`table.hideRowsOnSearch`); a page that needs a different default passes a patch.
- Search highlighting and HTML escaping each have one implementation: `searchMatch.makeHighlighter` and `fieldFormat.escapeHtml`. Decoration placement lives in `views/decorations.js`.
- Batch edits match rows to loaded rows by `rowKey` everywhere; rows added, removed or moved mark the table changed without marking cells.
- `Requests.getInventoryHiddenSearchData` was removed (D7); category cards search the item rows.

## Purpose

Replace today's built-in, scattered presentation model with **one precise, data-driven views system** applied to the existing pages. Today presentation is spread across:

- column flags set inside page components,
- `hideColumns` props,
- `viewModes`,
- `chipColorClass`, `cardClass`, `cellClass` functions,
- hand-built card items and `hiddenSearchData`,
- three different row-action paths (`event-click`, `onItemClick`, `#details-cell` overrides).

**The separation:**

- **View data** says what is shown, where, in what colour, at what size, and how the primary action is triggered. It is plain data, shared by every renderer.
- **Renderers** (`TableComponent`, `CalendarComponent`, `CardsComponent`) only draw a resolved view.
- **Pages** own data, domain logic, edit mode and actions.

Once every page runs on the system it becomes the single mechanism for presentation defaults, and all other mechanisms are removed. New pages and customization options can then be added to the views layer as their own concern, separate from rendering and data manipulation.

Revision history: the answers to revisions 1–8 are folded into the plan and logged in [§10](#10-decisions-log). Remaining questions are in [§11](#11-open-questions).

Related notes: [notes.md](notes.md) (TODO items L80–82, L131–135), [calendar-view-feature.md](calendar-view-feature.md), [item-grouping-implementation.md](item-grouping-implementation.md), [memory-optimization-analysis.md](memory-optimization-analysis.md).

---

## Contents

1. [Goals, non-goals, ship criteria](#1-goals-non-goals-ship-criteria)
2. [Current state](#2-current-state)
3. [Target architecture](#3-target-architecture)
4. [Specification](#4-specification)
5. [Per-page migration](#5-per-page-migration)
6. [Phased delivery](#6-phased-delivery)
7. [Challenges](#7-challenges)
8. [Feature parity matrix](#8-feature-parity-matrix)
9. [No-feature-loss verification checklist](#9-no-feature-loss-verification-checklist)
10. [Decisions log](#10-decisions-log)
11. [Open questions](#11-open-questions)

---

## 1. Goals, non-goals, ship criteria

### Goals

1. **One presentation model.** Every renderer instance gets its presentation from a view: visibility tiers, placement, stacking, colour, theme, default sort, size variants, print, action trigger.
2. **Strict separation.**
   - Fields describe the data (§4.1). Views describe presentation (§4.2).
   - Page hooks supply actions and derived values; the page also sets the edit mode (§4.8, §4.16).
   - Renderers consume a resolved view through a fixed contract (§4.4) and contain no page-specific presentation logic.
3. **Single mechanism.** Once migration is complete, renderers no longer accept presentation settings from pages, only through `DataView` (Phase 5).
4. **Parity by construction.** Visibility, size adaptation, colour, the primary action (details or a page action), search and decorations are each one concept that every renderer interprets.
5. **Ready to extend.** `resolveView` accepts view patches from components (§4.15), so customization, new views and new pages are later additions to the views layer and need no renderer changes.

### Principle: page or view?

- **New page:** content that is different in purpose (its own analysis, endpoints, or actions). Example: the design queue gets its own page under Schedule.
- **New view:** a different visualization of the same data for the same purpose. Example: Schedule table and calendar, or a ship/return calendar.

### Principle: data or view?

Every property has one home. When adding one, put it where its question is answered:

| Question | Home | Examples |
| --- | --- | --- |
| What is this value, and may it be written? | **Field** (page code, the data layer, preferences such as `ColumnTypes` and `InstantWriteTables`) | `key`, `label` (the field's name), `type`, `format`, `editable`, a select's `options` (allowed values) and `optionList` (list name) |
| Which columns show, in what order, and how do they look and behave? | **View** (`columns`, `sortable`, `style`, …; a registry may share `style` and `sortable` with all its views) | header text and icons (`style.label`, `labelHtml`, `title`), widths, fonts, colours, sortability, which cell draws a value (`style.cell`, `cellOptions`), column span |
| What does a row's data say? | **Derived field** computed by the page, holding a data state | `_unattached: true`, `_status` |
| What colour or style does that state get? | **View colour rule** | `rowColor: { field: '_unattached', rule: 'checked:red', fallback: 'gray' }` |

- A field never carries presentation. `resolveView` ignores presentation properties on fields, with a dev warning, so drift shows up on localhost.
- A view never decides data: types, write permission and allowed values come from fields.
- Cells that follow the data need no view setting: a `checkbox` or `select` field gets its type's cell (read-only ones render disabled), and an editable field without a cell gets the text editor. A view names a cell only for a display choice (`image`, `itemId`, the page's `slot`, `external-edit`).
- Presentation that comes from data at runtime (the assignee colours in a preference, a dynamic column's header) enters through the page as a view patch (§4.15) or the page's computed registry, never as field properties.

### Non-goals

- **Customization UI and per-user override storage.** The system accepts patches (§4.15). The only source built here is the `DesignQueueFields` preference for the design queue; other sources are decided per page later.
- **Views controlling data types or editing.** Checkbox fields and the instant-write edit mode are part of this plan (Phase 2, §4.16), but they are configured by the page with its fields and the instant-write preference. Views only place them.
- **Filters inside views.** Saved searches and filter parameters choose rows; filter options don't depend on the layout.
- **History rows.**
- **More than one dashboard card per page** (§4.11).
- **Layout switching on pages that edit through the table** (InventoryTable, PacklistTable).

### Ship criteria

- **No feature loss**, with one accepted removal: the per-column hide button (`allowHide`, used only by ShowInventoryReport's dynamic show columns). It is removed when that page migrates, and show columns can't be hidden per run until customization exists.
- **Old links:** `?view=categories` works natively. `?layout=calendar` maps to the `calendar` view. `?view=all` (show-all) is **not** kept and becomes `?dateFilter=all`.
- **Visual shifts are allowed if they help** ([§6, Intended visual shifts](#intended-visual-shifts)).
- **Each phase ships on its own.** Phase 5 ships as one change after a manual testing period (R3.11).

---

## 2. Current state

### 2.1 Renderers

|                   | `TableComponent` ([tableComponent.js](../js/application/components/interface/tableComponent.js))                                                                     | `CalendarComponent` ([calendarComponent.js](../js/application/components/interface/calendarComponent.js)) | `CardsComponent` ([cardsComponent.js](../js/application/components/interface/cardsComponent.js))                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Size              | 5,087 lines, including about 1,360 lines of shared selection/drag/clipboard state (`tableRowSelectionState`)                                                         | 492 lines                                                                                                 | 617 lines                                                                                                                                                     |
| Data input        | `data`, `originalData`, `columns`                                                                                                                                    | `data`, `columns`                                                                                         | `items: [{ id, title, content, contentFooter, footerActions, cardClass, hiddenSearchData, AppData }]`                                                         |
| Props             | 39                                                                                                                                                                   | 25                                                                                                        | 23                                                                                                                                                            |
| Emits             | `refresh`, `cell-edit`, `new-row`, `on-save`, `inner-table-dirty`, `row-move`, `row-options`                                                                         | `refresh`, `event-click`                                                                                  | `refresh`, `toggle-pin`                                                                                                                                       |
| Slots             | default (non-editable cell), `header-area`, `cell-extra`, `details-cell`, `row-details`, `row-detail-rows`, `selection-actions`                                      | `header-area`                                                                                             | default (wraps everything), `header-area`                                                                                                                     |
| Column flags read | `key label labelHtml title width font format editable sortable autoColor type cellClass columnClass allowHide details stackUnder sticky colspan`                     | `key firstRow secondRow` (plus `colKey` on action cards)                                                  | none                                                                                                                                                          |
| Search            | Columns not in `hideSet` (details included). Details-only matches light the details button ([L4552](../js/application/components/interface/tableComponent.js#L4552)) | Highlight only                                                                                            | `title/content/contentFooter`, then `hiddenSearchData`, with a matched-fields display ([L180](../js/application/components/interface/cardsComponent.js#L180)) |
| Formatting        | `formatCellValue` ([L2892](../js/application/components/interface/tableComponent.js#L2892))                                                                          | none                                                                                                      | none (consumers preformat HTML)                                                                                                                               |
| Row action        | details button (expand), or a `#details-cell` override; `hover-highlight` theme on some tables, with buttons in cells                                                | chip click → `event-click`                                                                                | card click → `onItemClick`                                                                                                                                    |
| Colour            | `theme`; `autoColor`; `cellClass` (fn/object, [L3042](../js/application/components/interface/tableComponent.js#L3042)); `columnClass`; state classes                 | `theme`; `chipColorClass(row)`                                                                            | `theme`; `item.cardClass`                                                                                                                                     |

### 2.2 Renderer feature inventory

This list defines "no feature loss." Every item maps to a row in §9.

**Table**

- Header: `header-area`, search (hide-rows toggle, navigation), New Item, Save, Refresh/Discard, Undo/Redo, view toggle, loading bar.
- Sticky header clone; sticky columns ([L2426–2471](../js/application/components/interface/tableComponent.js#L2426)); two-high stacks (`stackUnder`, [L2159](../js/application/components/interface/tableComponent.js#L2159)); `colspan` clipping ([L2125](../js/application/components/interface/tableComponent.js#L2125)).
- Hiding: `hideColumns`; ad-hoc hide button (`allowHide`, [L2885](../js/application/components/interface/tableComponent.js#L2885)) **(to be removed)**; always-hidden `AppData`, `EditHistory`, `MetaData`.
- Details: `allowDetails`, `forceDetails`, `rowDetailsVisible`, the `details` grid, and the `row-details`, `row-detail-rows` and `details-cell` slots.
- Sorting: `sortable`, `defaultSortColumn/Direction`, `type: 'item'` comparison.
- Editing: text, number, `external-edit`, revert, hints, dirty tracking, undo/redo, unsaved footer.
- Rows: new row; drag/drop (`dragId`, `dragLabel`, `allowDropOnto`); multi/shift select; selection bubble; delete/restore; cut/copy/paste (OS TSV); row groups; nested inner tables.
- States: error, analyzing, marked-for-deletion, metadata classes, empty drop target, footer counts and Show all.
- Mobile: `theadActive` tap-to-show column buttons.

**Calendar**

- Week rows, month labels, `weekStart`, `yearColumn`, sticky day header, today highlight.
- Chips spanning start→end that split at weeks, with `firstRow`/`secondRow` lines.
- `chipColorClass`; `chipActions` → inline and end cards (end cards hidden when narrow).
- Chip click and Enter/Space → `event-click`; analyzing state; search highlight; header-area; refresh; view toggle; loading; error; empty.

**Cards**

- Header: header-area, search (navigate or filter mode), sort select, refresh, view toggle, loading.
- Card: title, pin (`showPinButtons`, `pinnedItems`, `toggle-pin`), content/footer HTML, `footerActions`, `cardClass`, analyzing, keyboard, `onItemClick`.
- Hidden-field deep search with matched-fields display; "Showing x of y / Show all"; empty/loading.

### 2.3 Consumers

There are 20 renderer instances in 14 components.

| Component                                                                                                                                                                                                                                                             | Renderer(s)       | Presentation set today by                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ScheduleTable.js](../js/application/components/content/ScheduleTable.js) (in [ScheduleContent.js](../js/application/components/content/ScheduleContent.js))                                                                                                          | table ↔ calendar  | `columns()` flags from sheet headers ([L67](../js/application/components/content/ScheduleTable.js#L67)); `#row-details`; `#cell-extra` cards ([L877](../js/application/components/content/ScheduleTable.js#L877)); `chipActionsProvider` ([L190](../js/application/components/content/ScheduleTable.js#L190)); inline detail modal ([L676](../js/application/components/content/ScheduleTable.js#L676)); `isCalendarView`/`viewModes` in ScheduleContent.                    |
| [InventoryItemTimeline.js](../js/application/components/content/InventoryItemTimeline.js)                                                                                                                                                                             | table ↔ calendar  | Derived `calendarStart/End`; `chipColorClass` = autoColor(quantity) or green; `autoColor` on quantity; chip click opens a detail modal ([L181](../js/application/components/content/InventoryItemTimeline.js#L181)).                                                                                                                                                                                                                                                         |
| [InventoryItemReport.js](../js/application/components/content/InventoryItemReport.js)                                                                                                                                                                                 | table ↔ calendar  | `calendarColumns`, `calendarData`, `hide-columns`, `#default` cells (the `itemId` cell is a button that navigates, [L625](../js/application/components/content/InventoryItemReport.js#L625)), `cellClass` autoColor on `minQty` and `columnClass: 'gray'`; `chipColorClass` = autoColor(minQty) or green; chip click navigates; reads `params.view` as a search param ([L243](../js/application/components/content/InventoryItemReport.js#L243)).                            |
| [InventoryContent.js](../js/application/components/content/InventoryContent.js) + [InventoryOverviewTable.js](../js/application/components/content/InventoryOverviewTable.js)                                                                                         | cards ↔ table     | Category items with `_hiddenSearchData`, autosave/lock footers, Save, cardClass ([L113–181](../js/application/components/content/InventoryContent.js#L113)); card click navigates and keeps `searchTerm` ([L293](../js/application/components/content/InventoryContent.js#L293)); overview `details` fields, sticky `image`, `#default` cells, `#details-cell` override that navigates to the item timeline with `searchTerm` (so its details fields can never be expanded). |
| [PacklistContent.js](../js/application/components/content/PacklistContent.js)                                                                                                                                                                                         | cards             | `formatPacklistCard` ([L741](../js/application/components/content/PacklistContent.js#L741)): HTML content, footers, actions, `cardClass` red/gray from schedule attachment; pins, pinned-only and unlinked-only; sort select. Routes `packlist/<name>/details` exist.                                                                                                                                                                                                        |
| [ReportsContent.js](../js/application/components/content/ReportsContent.js)                                                                                                                                                                                           | cards             | Static three-item menu.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [InventoryTable.js](../js/application/components/content/InventoryTable.js)                                                                                                                                                                                           | table (editing)   | `forceDetails`, `rowDetailsVisible`, `#row-detail-rows` (pending changes), `#default` for `image` and `_navigate`.                                                                                                                                                                                                                                                                                                                                                           |
| [PacklistTable.js](../js/application/components/content/PacklistTable.js)                                                                                                                                                                                             | table ×3          | Crates with nested item tables; `colspan` headers; hard-coded `hiddenColumns` ([L154](../js/application/components/content/PacklistTable.js#L154)) and the print toggle ([L1294](../js/application/components/content/PacklistTable.js#L1294)); summary table `theme="purple hover-highlight"` with a "+ Add Item" button per row; `theme="packlist-table"` structural class.                                                                                                |
| [PacklistItemsSummary.js](../js/application/components/content/PacklistItemsSummary.js), [ShowInventoryReport.js](../js/application/components/content/ShowInventoryReport.js), [IndexMismatchReport.js](../js/application/components/content/IndexMismatchReport.js) | table (read-only) | `#default` cells; `cellClass` autoColor and `columnClass: 'striped gray'` on `show_*` (ShowInventoryReport, which also reads `params.view`, [L148](../js/application/components/content/ShowInventoryReport.js#L148)); `allowHide`.                                                                                                                                                                                                                                          |
| [ScheduleModals.js](../js/application/components/interface/ScheduleModals.js) `TransshipmentModal`                                                                                                                                                                    | table ×2          | `hide-columns: ['Year']`, `gray hover-highlight`, two direction buttons per row, no URL.                                                                                                                                                                                                                                                                                                                                                                                     |
| [filterComponents.js](../js/application/components/interface/filterComponents.js) `ScheduleAdvancedFilter`                                                                                                                                                            | table             | Overlapping-show picker: `gray hover-highlight`, a "Select" button per row, no URL.                                                                                                                                                                                                                                                                                                                                                                                          |

### 2.4 Existing view-like mechanisms (all replaced)

| Mechanism                                                                                                                                                                                             | Replaced by                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `ViewChangeComponent` / `viewModes` ([navigationComponents.js:603](../js/application/components/interface/navigationComponents.js#L603))                                                              | `ViewSelectComponent` and the page view registry                                |
| `?layout=calendar`, `?view=categories`, per-page `isCalendarView`                                                                                                                                     | `?view=<id>`                                                                    |
| `?view=all` show-all (`filterComponents` L288, L1375–1523; ItemReport L243; ShowInventoryReport L148)                                                                                                 | `?dateFilter=all` (filter concern)                                              |
| `hideColumns`, `hiddenColumns`, `details`, `stackUnder`, `sticky`, `firstRow/secondRow`, `whenSmall` flags                                                                                            | View tiers, slots, `table.sticky`, `calendar.chip`, variants                    |
| `autoColor`, `cellClass`, `columnClass`, `chipColorClass`, `cardClass`, `theme` strings incl. `hover-highlight`                                                                                       | View `style`, `rowColor`, `theme`, `className`; hover follows the `row` trigger |
| `hiddenSearchData`, `getInventoryHiddenSearchData`                                                                                                                                                    | Bucket member search through `matchRow`                                         |
| Hand-built card items (`categoryList`, `formatPacklistCard`)                                                                                                                                          | `rowsToCards` / `bucketRowsToCards` plus decorations                            |
| `event-click`, `onItemClick`, `#details-cell` navigation override, per-row Select/Add buttons                                                                                                         | One primary action: page `action` hook plus view `action` trigger (§4.8)        |
| Reports' use of `CardsComponent` `items`                                                                                                                                                              | A small card grid inside ReportsContent (R3.7)                                  |
| `defaultSortColumn/Direction` props passed by pages                                                                                                                                                   | `view.sort`                                                                     |
| PacklistTable print toggle                                                                                                                                                                            | `variants.print`                                                                |
| Breakpoints: container 600; media 800 (chrome plus duplicated content rules); `isMobileView` 800; a 768 settle heuristic in [useStickyHeader.js:174](../js/application/utils/useStickyHeader.js#L174) | The size model (§4.10)                                                          |
| Modal width classes `small-menu`, `hamburger-menu` (width part), `page-menu`, `event-detail`, `page-note-edit-menu`                                                                                   | Modal size tiers (§4.17)                                                        |
| `currentView` = last path segment (content components, [HamburgerMenuRegistry.js:248](../js/application/utils/HamburgerMenuRegistry.js#L248)), a name collision with views                            | Renamed `currentSegment` in Phase 5                                             |

### 2.5 Defects found during the survey

- **D1 (fixed 2026-10-28):** Inventory categories passed `:analysis-progress`. It is now `:loading-progress`.
- **D2 (fixed 2026-10-28):** removed the undeclared `readonly` and `external-dirty-state` attributes.
- **D3:** `whenSmall` is dead config. It is replaced by the Schedule narrow variant (Phase 6).
- **D4:** index-based `cell-edit` and `dirtyCells` ([InventoryTable.js:1084](../js/application/components/content/InventoryTable.js#L1084)). Fixed in Phase 0.
- **D5:** Schedule action cards built twice; calendar chips miss the ship-date and transship cards.
- **D6:** custom `#default` slots replace the fallback for all fields; some pages lose highlighting.
- **D7:** inventory rows loaded twice (`getInventoryHiddenSearchData`, [api.js:337](../js/data_management/api.js#L337)).
- **D8:** InventoryOverviewTable defines `details` fields, but its `#details-cell` override replaces the expand toggle, so those fields can only be matched by search and never seen in place. Accepted as designed (R3.8): the timeline it navigates to reveals them.
- **D9:** `$modal.custom()` takes three arguments, but three call sites pass a fourth that is silently ignored: ItemReport [L494](../js/application/components/content/InventoryItemReport.js#L494) and PacklistItemsSummary [L201](../js/application/components/content/PacklistItemsSummary.js#L201) (`{ modalClass: 'hamburger-menu' }`), and the show-overlap picker in [filterComponents.js:834](../js/application/components/interface/filterComponents.js#L834) (`{ size: 'large' }`, which was never applied). Fixed by the modal size tiers (Phase 6).

---

## 3. Target architecture

```
 Page component — data, domain logic, actions, edit mode
 ├─ rows     ← store data + derived fields (computed copy; never written to store.data)
 ├─ fields   ← FieldDef[]: what each key IS (label, type, format, editable, options)
 ├─ editMode ← 'none' | 'batch' | 'instant'  (page data, never view data; §4.16)
 ├─ registry ← page view registry: views (presentation), shared style and sortable, default, theme
 └─ hooks    ← action · decorations · bucketDecorations · commitCells (instant mode)
        │
        ▼
 <DataView>  — the only producer of renderer presentation input
 ├─ viewId   ← ?view= (fallback ?layout=) → registry default; no URL (modal) → default
 ├─ size     ← 'wide' until Phase 6; then useContainerSize() → 'wide' | 'medium' | 'narrow'
 ├─ patches  ← optional, from the component (customization later)
 ├─ resolved ← resolveView(fields, view, { size, print, patches, editMode })  ← pure, tested
 ├─ action   ← resolveAction(hooks.action, resolved, editMode) → { kind, trigger, … }
 ├─ renderer ← resolved.layout
 └─ details  ← RowDetailsModal | table expand
        │  renderer contract: { rows, resolved, action, state, hooks, slots }
        ▼
 TableComponent · CalendarComponent · CardsComponent   (draw only)

 Shared: ContentHeaderComponent · ViewSelectComponent · RowDetailsComponent/RowDetailsModal
         formatValue · matchRow · colorFor · cell registry · decoration cards · useContainerSize
```

**Files**

| File                                                                 | Purpose                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `docs/js/application/utils/views/resolveView.js`                     | `resolveView`, `resolveAction`, slot normalization, key patterns, variants, patches        |
| `docs/js/application/utils/views/cardsAdapter.js`                    | `rowsToCards`, `bucketRowsToCards`                                                         |
| `docs/js/application/utils/views/fieldFormat.js`                     | `formatValue` (from `formatCellValue`)                                                     |
| `docs/js/application/utils/views/viewColor.js`                       | `colorFor(row, field, resolved)`, `rowColorFor(row, resolved)` (wraps `getAutoColorClass`) |
| `docs/js/application/utils/views/searchMatch.js`                     | `SEARCH_LIMITS`, `searchWords`, `matchRow`, `matchRows` (abort)                            |
| `docs/js/application/utils/useContainerSize.js`                      | `useContainerSize()`, `useViewportSize()`, `BREAKPOINTS`                                   |
| `docs/js/application/components/interface/dataViewComponent.js`      | `DataView`                                                                                 |
| `docs/js/application/components/interface/viewSelectComponent.js`    | `ViewSelectComponent`                                                                      |
| `docs/js/application/components/interface/contentHeaderComponent.js` | Shared header                                                                              |
| `docs/js/application/components/interface/rowDetailsComponent.js`    | `RowDetailsComponent`, `RowDetailsModal`                                                   |
| `docs/js/application/components/interface/cells.js`                  | Cell registry                                                                              |

- **Registries** live as a `const` in the page component.
- **Shared fields:** field definitions shared by more than one page (Schedule and the future design queue page) move to a module next to that data's abstraction, for example `scheduleFields.js`.

---

## 4. Specification

### 4.1 Field definition: what the data is

```js
/**
 * @typedef {Object} FieldDef           what the data is (see "Principle: data or view?")
 * @property {string}   key
 * @property {string}   [label]         the field's human name (headers, cards, details, sort menus)
 * @property {string}   [type]          data type / compare semantics: 'item', 'date', 'number', 'checkbox', 'select', …
 * @property {'date'|'currency'|'number'|'multiline'|string} [format]   display format implied by the type
 * @property {boolean}  [editable]      configured with the page's data, not by views (§4.16)
 * @property {string[]} [options]       select: the allowed values (the page supplies them)
 * @property {string}   [optionList]    select: the option list ColumnTypes names
 */
```

Presentation properties are **not** field properties: `labelHtml`, `title`, `sortable`, `cell`, `cellOptions`, `colspan`, `isIndex`, and the older `width`, `font`, `autoColor`, `cellClass`, `columnClass`, `allowHide`, `details`, `stackUnder`, `sticky`, `firstRow`, `secondRow`, `whenSmall`. `resolveView` ignores them on fields, with a dev warning; they belong in the view (§4.2).

**Resolved fields.** Renderers read `resolved.fields` / `resolved.fieldMap`: each data field with the view's presentation merged in (`style` props, `sortable`, and the type's cell). Pages never build presented fields themselves.

**Columns without data (custom, kept).** The ideal is that every column holds data and anything else is an action. These stay as bare fields (`key` + `label`) with their presentation in the view; no new mechanism is added for them:
- the item thumbnail (`image`): ideally the inventory data stores an image URL and a view styles that column as a thumbnail, with editing following its data controls (see Later);
- the Schedule `packlist` column: ideally tables allow several row actions with their own styling (see Later).

The inventory calendar button is no longer a column: it is the inventory table's row action, with a calendar header icon (`action: { to, icon, headerIcon, title }`).

### 4.2 View definition: presentation as data

```js
/**
 * @typedef {string|string[]} Line      one key, or keys shown inline on one line
 * @typedef {string|Line[]}   Slot      one key, or a stack of lines (top → bottom)
 * @typedef {'auto'|string}   ColorRule 'auto' = getAutoColorClass(value); 'value' = the value is the class; otherwise a class name
 *
 * @typedef {Object} ViewDef
 * @property {string}  id                 stable, never renamed
 * @property {string}  name
 * @property {string}  [icon]
 * @property {'table'|'calendar'|'cards'} layout
 * @property {string}  [theme]            header/footer/button colour; defaults to registry.theme
 * @property {string}  [className]        structural CSS hook (e.g. 'packlist-table'); never colour
 * @property {boolean} [fullWidth]        full-width container mode: the page container drops its max-width
 *
 * // Visibility
 * @property {Slot[]}  [columns]          shown, in order
 * @property {string[]|'rest'} [details='rest']  'rest' = every field not listed elsewhere
 * @property {string[]|'rest'} [hidden]          never shown, never searched
 * @property {{key:string, dir:'asc'|'desc'}} [sort]
 * @property {string[]} [sortable]        keys (or patterns) the user can sort by; unlisted keys don't
 *                                        sort; names a sheet lacks are ignored
 *
 * // Interaction
 * @property {'button'|'row'} [action='button']   how the primary action is triggered (§4.8)
 *
 * // Style and colour (keyed by field key or pattern; exact keys override patterns)
 * @property {Object<string,{ width?:number, font?:string, color?:ColorRule, columnColor?:string,
 *           label?:string, labelHtml?:string, title?:string, cell?:string, cellOptions?:Object, colspan?:number }>} [style]
 *           columnColor = column background class (table); label/labelHtml/title = header text, header
 *           HTML (icon) and tooltip; cell = the cell that draws the value when it isn't the type's
 *           (§4.14); colspan = table-structural (PacklistTable's nested item header only)
 * @property {{ field:string, rule:ColorRule, fallback?:string }} [rowColor]
 *
 * // Layout sections
 * @property {{ sticky?: {start?:string[], end?:string[]}, hideRowsOnSearch?: boolean }} [table]
 * @property {{ start:string, end:string, weekStart?:'sunday'|'saturday', yearColumn?:string, chip:Line[], actions?:string[] }} [calendar]
 *           actions = keys whose cells draw in the chip's end button bar (before the decoration cards
 *           and the action button), like a card footer
 * @property {{ bucketBy?:string, card:Line[], footer?:Line[], hideOnSearch?:boolean }} [cards]
 *
 * // Variants: partial ViewDefs by condition
 * @property {{ medium?: Partial<ViewDef>, narrow?: Partial<ViewDef>, print?: Partial<ViewDef> }} [variants]
 */
```

**Rules**

- **Key patterns:** a trailing `*` (`'show_*'`) works in every key list and in `style` keys, using the same rule as `matchesPagePattern` in [preferencesComponent.js](../js/application/components/interface/preferencesComponent.js).
- **Variant cascade:** `medium` applies at medium and narrow sizes; `narrow` applies on top of it at narrow size; `print` applies last. Objects merge deeply, arrays replace.
- **Colour rules are data only** (R3.5). Rules: `'auto'`, `'value'` (the value is the class), `'checked:<class>'` (the class when the value is a checked checkbox value or `true`), `'sign:<pos>:<neg>'` (by the sign of a number), `'differs:<key>:<class>'` (the class when the value differs from the row's `<key>`, e.g. a proposed description against the current one), or a literal class. Logic (packlist unattached) becomes a **derived field holding a data state**, computed by the page (`_unattached: true`), and the view maps it to a colour: `rowColor: { field: '_unattached', rule: 'checked:red', fallback: 'gray' }`. A derived field holds a state, not a class name.
- **Registry-level presentation:** a registry's `style` and `sortable` apply to all its views (`withRegistryDefaults`); a view's own entries win (objects merge, lists replace).
- **Validation:** dev warnings, never throws.
  - Unknown keys are ignored.
  - The first tier wins on duplicates. At most one of `details` and `hidden` may be `'rest'`.
  - Editable fields inside a stack child render read-only.
  - A view with a missing calendar start or end field falls back to the default view.
  - `action: 'row'` with an `editMode` other than `'none'` falls back to `'button'` (§4.8).

### 4.3 Page view registry

```js
const SCHEDULE_VIEWS = {
  id: "schedule", // page-type identity (future patch scope: per page type)
  default: "table",
  theme: "gray",
  views: [
    {
      id: "table",
      name: "Schedule",
      icon: "table",
      layout: "table",
      columns: [
        "Show",
        "Client",
        ["Ship", "Recieved"],
        ["S. Start", "S. End"],
        "City",
        "Size",
        "packlist",
      ],
      variants: {
        narrow: {
          columns: [
            ["Show", "Client"],
            ["Ship", "Recieved"],
            ["S. Start", "S. End"],
            "packlist",
          ],
        },
      },
    },
    {
      id: "calendar",
      name: "Calendar",
      icon: "calendar_month",
      layout: "calendar",
      calendar: {
        start: "S. Start",
        end: "S. End",
        weekStart: "sunday",
        yearColumn: "Year",
        chip: [
          ["Show", "Client"],
          ["City", "Size"],
        ],
      },
    },
  ],
};
```

- **Single-view registries** have no switcher. Modal tables are single-view and have no URL.
- **Schedule Phase 1** reproduces today: shown `Show, Client, Ship, City, Size, S. Start, S. End, Recieved, packlist`, with the rest in details. The narrow variant ships in Phase 6.

### 4.4 `resolveView` and the renderer contract

```js
resolveView(fields, view, { size = 'wide', print = false, patches = [], editMode = 'none' }) → ResolvedView
```

**Steps**

1. Apply variants (`medium`, `narrow`, `print`) for `size` and `print`.
2. Apply `patches` (§4.15) whose `sizes` include `size`.
3. Expand patterns; assign tiers (shown, details, hidden; unlisted fields go to whichever of `details` or `hidden` is `'rest'`); always hide `AppData`, `EditHistory`, `MetaData`.
4. Resolve style per field (`width`, `font`, `color`, `columnColor`) and `rowColor`.
5. Resolve the action trigger (with the edit-mode rule).
6. Build the output.

```js
/** @typedef {Object} ResolvedView
 *  @property {string} viewId, layout, theme, className
 *  @property {ResolvedSlot[]} slots      [{ key, field, lines: Line[], width, font, color, columnColor, sticky }]
 *  @property {FieldDef[]} details
 *  @property {Set<string>} hidden
 *  @property {Object} rowColor, sort, table, calendar, cards
 *  @property {'button'|'row'} trigger
 *  @property {boolean} hasDetails
 */
```

**Two output forms**

- **Phases 1–4 (adapter):** `toLegacyColumns(resolved)` converts the result into the column flags renderers read today: `stackUnder`, `details`, `sticky`, `firstRow/secondRow`, `width`, `font`, `cellClass`, `columnClass`. Renderer internals don't change while pages migrate, except for the primary action, which tables and calendars gain in Phase 1 and cards in Phase 3, and the instant-edit additions in Phase 2.
- **Phase 5 (contract):** renderers read `ResolvedView` directly. The adapter, the legacy flags and the public presentation props are deleted.

**Renderer contract** (Phase 5 end state)

- `rows`
- `resolved: ResolvedView`
- `action: ResolvedAction` (§4.8)
- `state: { isLoading, isAnalyzing, loadingProgress, loadingMessage, error, emptyMessage }`
- `hooks: { decorations, bucketDecorations, commitCells }`
- slots: `#cell`, `#row-details`, `#header-area`, plus table-only `#cell-extra`, `#row-detail-rows`, `#selection-actions`
- renderer-only behaviour props: table editing/drag/selection/grouping and `editMode`; cards pins

### 4.5 Visibility tiers and search

| Tier    | Table               | Calendar     | Cards        | Searched | Match indicator                                           |
| ------- | ------------------- | ------------ | ------------ | -------- | --------------------------------------------------------- |
| shown   | column / stack line | chip line    | card line    | yes      | highlight                                                 |
| details | expand              | modal        | modal        | yes      | action button glows, or `details-match` on the row (§4.8) |
| hidden  | not rendered        | not rendered | not rendered | no       | n/a                                                       |

- **One matcher:** `matchRow(row, { shown, details }, words) → { matched, shownMatch, detailMatches }`. All renderers use it, and `useSearch.matchesRow` wraps it. This is today's table `visibleRows` rule (AND across words).
- **Search is for pinpointing (R4.2).** Two app-wide rules apply to every search, in every renderer:
  1. **Minimum term length 2.** `searchWords(term, minTermLength)` splits the term and drops words shorter than 2 characters before matching **and** highlighting. "TV", "AV" and two-digit numbers still search; single characters don't. If no words remain, search is inactive: no filtering, highlighting or glow.
  2. **Broad-search abort.** If the searched set has more than 100 rows and the search matches more than 80% of them, the search is aborted. Results aren't processed: the unfiltered set is shown with no highlighting, glow or matched-field lists, and no message (R5.1). If the search-navigation card is visible, it shows `∞` with no previous/next buttons. `SearchBoxComponent` ([useSearch.js:552](../js/application/utils/useSearch.js#L552)) receives `matchCount: Infinity` and adds one template branch for it, next to today's `0 / 0` branch.
- **Abort mechanics:**
  - `matchRows(rows, tiers, words, limits)` counts matches before any highlighting or rendering work.
  - It stops early once the count passes the threshold, so an aborted search costs one partial pass over the rows and no highlighting.
  - The searched set is the rows handed to the renderer, after page filters. For bucket cards that means the member rows, not the buckets.
- **Constants:** `SEARCH_LIMITS = { minTermLength: 2, abortRatio: 0.8, abortMinRows: 100 }` lives in `searchMatch.js`. It is the one app-wide setting; views can't override it (R6.6).
- **Navigation:** the URL `searchTerm` is passed on unchanged, and the destination page applies the same rules to its own rows.
- **Details with a navigating action (R3.8):** details fields stay searchable when the primary action navigates away. A details-only match lights the indicator even though the value isn't visible in place, and the navigation carries `searchTerm` so the destination can reveal it. Pages that use this must make sure the destination shows those fields; InventoryOverviewTable → timeline already does.
- **Migrating `hideColumns`:** those fields go to `hidden`.
- **Bucket cards:** tiers apply to member rows. The categories view declares no tier lists, so every non-hidden item field is searched. That matches the overview table exactly (R2.12). A short number that matches quantities across most items trips the broad-search abort (R4.2). Matched member fields are listed on the card as today.

### 4.6 Cards adapter

```js
rowsToCards(rows, resolved, hooks); // one card per row
bucketRowsToCards(rows, resolved, { bucketKeys, bucketDecorations }); // one per distinct row[cards.bucketBy]
// → [{ id, title, content, contentFooter, footerActions, cardClass, searchFields, hasDetails, AppData, row }]
```

- **Lines:** `card[0]` → title, other lines → content, `footer` → contentFooter. Values pass through `formatValue` and are HTML-escaped. Field colour renders as a badge on the value.
- **Colour:** `rowColor` → `cardClass`.
- **Decorations:** row-level decorations → `footerActions`. Status text ("Locked for edit by …", "Unsaved changes") comes from decorations or derived fields.
- **Bucket cards:**
  - `bucketKeys` seeds empty buckets.
  - `bucketDecorations` supplies autosave/lock/Save.
  - They have **no details** (R2.7); their primary action is the page's navigation.
- **No items mode (R3.7).** `CardsComponent` takes only adapter output from `DataView`. ReportsContent builds its own three-card menu with the shared card CSS and drops `CardsComponent`.
- **`bucketBy`** is unrelated to packlist row groups (`hideGroupMembers`, `MetaData`). Code comments must say so.

### 4.7 Calendar mapping

- **Props:** `calendar.start/end/weekStart/yearColumn` → the existing props. `calendar.chip` → `firstRow`/`secondRow` (adapter), and N lines in Phase 5.
- **Values:** pass through `formatValue`. Field colour renders as a badge; `rowColor` sets the chip colour, replacing `chipColorClass`.
- **Derived fields** (Timeline end dates, ItemReport ranges) are computed on a computed copy of the rows.
- **Interaction:** the primary action (§4.8). With `action: 'button'` the action button sits at the chip start and stays visible when narrow; with `action: 'row'` the chip body is the trigger. Inline decorations stay clickable either way.

### 4.8 The primary action (R3.4, R3.8, replacing R2.6/R2.7)

Row click and the details button are **one mechanism**. Every row has at most one primary action, and the view chooses how it is triggered.

**What the action is** (page data, `DataView` prop `action`):

```js
/** @typedef {Object} ActionDef
 *  @property {(row) => string} [to]     navigation path; DataView adds the current searchTerm
 *  @property {(row) => void}   [run]    in-place action (select, add)
 *  @property {string} [label]           button text, e.g. 'Select', '+ Add Item'
 *  @property {string} [icon]            button icon: a glyph or a material symbol name; default is the details icon (☷)
 *  @property {string} [headerIcon]      the table's action column header (glyph or symbol name; details default ⓘ)
 *  @property {string} [title]           the button's tooltip
 *  @property {(row) => boolean} [disabled]  e.g. the picker disables Select for shows without dates
 */
```

An `ActionDef` has exactly one of `to` and `run` (R6.5). If both are given, `resolveAction` logs a dev warning and uses `to`.

`resolveAction(actionDef, resolved, editMode)` picks one, in order:

1. **Page action:** the page defines `to` or `run`.
2. **Details:** otherwise, if the row has details (`resolved.hasDetails` or a `#row-details` slot). Tables expand inline. Calendar and cards open `RowDetailsModal`.
3. **None.**

**How it is triggered** (view data, `view.action`):

| Trigger              | Table                                                                                  | Calendar                 | Cards                     |
| -------------------- | -------------------------------------------------------------------------------------- | ------------------------ | ------------------------- |
| `'button'` (default) | one action button in the trailing sticky cell (today's details cell, `col-sticky-end`) | button at the chip end, last in its button bar | button in the card footer |
| `'row'`              | whole row, with hover highlight, `tabindex="0"` and Enter/Space; no button             | chip body; no button     | whole card; no button     |

- **The action in a column:** a view can draw the primary action as a column's value instead of a separate button: `style[key].cell = 'action'` (for example the item shortage report's purple Item# buttons). While a shown column (or a calendar chip line or `calendar.actions` key) uses that cell, the renderer draws no action button. Use it when the action belongs to one value; other per-row buttons are decorations or cells such as `showList`.

- **Glow:** with `'button'`, the button glows on a details-only match. With `'row'`, the row, chip or card gets a `details-match` class instead; cards also keep their matched-fields list.
- **Row-trigger guards:** a click is ignored when it lands inside an interactive element (`button, a, input, select, textarea, [contenteditable], .column-button`), when text is selected (`!getSelection().isCollapsed`, so cell contents can still be copied), and during clipboard or drag mode. Use `click`, not `touchend`.
- **Editable data never gets a row trigger.** If `editMode` is not `'none'`, `'row'` falls back to `'button'` with a dev warning.
- **Navigation passes search.** `to` actions append the current `searchTerm`, as InventoryContent and InventoryOverviewTable do by hand today ([L293](../js/application/components/content/InventoryContent.js#L293), [L165](../js/application/components/content/InventoryOverviewTable.js#L165)).
- **In-place actions hide details.** A page with a `run` action and details-tier fields can't show those fields; `resolveAction` logs a dev warning, and the view should move them to `shown` or `hidden`.
- **Bucket cards** use the page's `to` action; they never fall back to details.

**`RowDetailsModal`** (the details action outside tables) contains:

- the details grid (details fields, plus shown fields in calendar and cards), rendered through the **cell pipeline** (§4.14) so details cells can later have data types and become editable (R2.2);
- then `#row-details`, passed as a function prop (modals render in the root app via the `modals` array in [app.js](../js/application/app.js), so slot scope and injections survive);
- then the row-level decorations.

Table-only: `#row-detail-rows` (column-aligned rows, used by InventoryTable).

**Per instance**

| Instance                      | Action                         | Trigger | Change from today                                                  |
| ----------------------------- | ------------------------------ | ------- | ------------------------------------------------------------------ |
| Schedule table                | details (expand)               | button  | none                                                               |
| Schedule calendar             | details (modal)                | button  | chip body no longer opens the modal (R1.7)                         |
| Timeline table                | details (expand)               | button  | none                                                               |
| Timeline calendar             | details (modal)                | row     | none (chip click opens details)                                    |
| ItemReport table, calendar    | `to` item page                 | row     | table rows become clickable; the `itemId` button cell becomes text |
| Inventory overview (items)    | `to` item timeline             | button  | replaces the `#details-cell` override                              |
| Inventory categories (bucket) | `to` category                  | row     | none                                                               |
| Packlist cards                | `to` packlist                  | row     | none; no `/details` link (R4.1)                                    |
| InventoryTable, PacklistTable | details (expand)               | button  | none (`batch` edit mode)                                           |
| Report tables                 | details, if any                | button  | none                                                               |
| Overlapping-show picker       | `run` selectShow, "Select"     | button  | the `_action` column becomes the action cell; no hover highlight   |
| Packlist summary table        | `run` selectItem, "+ Add Item" | button  | the `actions` column becomes the action cell; no hover highlight   |
| Transshipment tables ×2       | none (two cell buttons)        | —       | no hover highlight                                                 |
| Design queue (Phase 2)        | details (expand), if any       | button  | new page; `instant` edit mode, so no row trigger                   |

### 4.9 Colour and theme (R2.8, R3.5, R3.6)

- **Theme** (`view.theme` or `registry.theme`) colours the header, footer and buttons only. Table bodies have no background unless the view colours rows, columns or cells.
- **`className`** carries structural classes (`packlist-table`), never colour.
- **Precedence**, highest first:
  1. State classes: selected, dirty/original, instant-write pending/failed, marked-for-deletion, search-active, `details-match`, drop target, analyzing
  2. Cell colour (`style[key].color`)
  3. Column colour (`style[key].columnColor`)
  4. Row colour (`rowColor`)
  5. None
- **Where each renderer applies it:**

|          | Row colour                                  | Column colour                                     | Cell colour                  |
| -------- | ------------------------------------------- | ------------------------------------------------- | ---------------------------- |
| Table    | `<tr>` class (existing `tr.<color>` styles) | `<col>` class (existing `col.<color>`, `striped`) | cell class                   |
| Calendar | chip                                        | n/a                                               | value badge on the chip line |
| Cards    | card                                        | n/a                                               | value badge on the card line |

- **Colour is per view.** The Timeline calendar view sets `rowColor: { field: 'quantity', rule: 'auto', fallback: 'green' }`, and the Timeline table view doesn't, so table rows keep their current look. A page that wants coloured table rows sets it on the table view.
- **`colorFor` and `rowColorFor`** are pure, wrap `getAutoColorClass`, and are tested.

### 4.10 Size model (R2.10, R3.1)

There are two scopes, each with the same three tiers.

| Tier     | Container width | Typical container                                                                 |
| -------- | --------------- | --------------------------------------------------------------------------------- |
| `wide`   | ≥ 1000px        | full page on a monitor, `page` modal                                              |
| `medium` | 600–999px       | portrait tablet page, double-wide dashboard card (750px, by design), `wide` modal |
| `narrow` | < 600px         | phone page, 360px dashboard card, `card` modal                                    |

**Container scope** (`useContainerSize()`, CSS `@container`) covers all content and views. `DataView` passes a fixed `wide` until Phase 6, then switches to `useContainerSize()` in the same change as the CSS (R6.4).

- It observes the nearest `container-type: inline-size` ancestor (`.container`, `.modal > .content`) with the same thresholds as CSS. JS and CSS therefore agree, and there is no hysteresis.
- Structural changes use `variants.medium` and `variants.narrow`. Visual changes (`hide-when-narrow`, a new `hide-when-medium`, font, grid) use CSS.
- **Padding:** a container query measures the container's content box. `.container` has no padding, so a page or dashboard card measures its full width (1000, 750, 360). `.modal > .content` has `--padding-md` padding, so modal widths add it back (§4.17).

**Viewport scope** (`useViewportSize()`, CSS `@media`) covers app chrome, dashboard layout and default CSS variables: primary nav (`isMobileView`, today 800), root font size, the dashboard grid, `--padding-*`, `--navbar-height`, `--page-width-*`.

| Viewport tier | Chrome (R4.4)                                                 | Dashboard                                                                                       |
| ------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `wide`        | full: 80px navbar, `--padding-md` 12px, `--padding-lg` 30px   | 360px card grid; double-wide cards span 2                                                       |
| `medium`      | compact: 50px navbar, `--padding-md` 8px, `--padding-lg` 16px | 360px card grid; double-wide cards are `min(750px, 100%)` and span 2 when they fit              |
| `narrow`      | compact                                                       | full-width cards (`--page-width-card: calc(100vw - 16px)`); double-wide collapses to one column |

- **Compact chrome** covers medium and narrow (R4.4). It replaces today's ≤ 800px block, so portrait tablets and small laptop windows up to 1023px get the compact navbar.
- **Full-width dashboard cards** stay narrow-only, so medium screens keep the card grid.
- **Viewport thresholds include the page gutter**, so a viewport tier matches the tier of a full-width page container. `#app-content` has `--padding-md` on each side, and the gutter is the one in effect on the larger side of each boundary:
  - narrow: `width < calc(600px + 2 * 8px)` (616px). Compact chrome is on both sides, so this boundary matches the container exactly.
  - wide: `width >= calc(1000px + 2 * 12px)` (1024px).
- **Residual mismatch at the wide boundary only:**
  - Between 1016 and 1023px the viewport is medium (8px gutter) while a full-width container already measures at least 1000px (wide). That is an 8px band.
  - On desktop Windows the `#app-content` scrollbar (about 17px) adds a band of that width. Overlay scrollbars on mobile and macOS add none.
  - Both bands are harmless because views follow the container, not the viewport.
- **Height:** there is no height tier (R6.6). The `short` flag was dropped because compact chrome now covers medium and nothing else needed it. Add it if a height-bound rule appears.

**Constants**

- Defined once in `BREAKPOINTS` (JS: `{ narrow: 600, wide: 1000, gutterCompact: 8, gutterFull: 12 }`) and documented in [theme.css](../css/theme.css).
- `@media` and `@container` conditions can't use CSS variables, but they can use `calc()` with literals. The numbers are therefore repeated as `calc(600px + 2 * 8px)` and similar, each with a comment pointing at `BREAKPOINTS`. `useViewportSize()` computes the same sums.

**Migration**

- Content rules move out of the 800px media block into container rules.
- Chrome rules move to the viewport tiers.
- The 768 settle heuristic in `useStickyHeader` becomes an unconditional second update after 100 ms.

### 4.11 URL, switcher, dashboard (R1.1, R1.13, R2.9, R3.3)

- **View id:** `?view=<id>`. Absent, or an unknown id with a dev warning, falls back to the registry default.
- **Calendar fallback:** if `view` is absent and `layout` is present, `layout` is used as the view id, and switching rewrites to `view`.
- **Show-all rename:** `?view=all` → `?dateFilter=all` in Phase 0, with no compatibility.
- **Ids are never renamed.** An alias map is added when first needed.
- **`ViewSelectComponent`:** an icon toggle for 2 views; a named menu for 3 or more; it keeps the dashboard `updatePath` branch.
- **Dashboard:** one card per page path stays.
  - Switching views inside a dashboard card rewrites that card's stored path, so the card remembers its last view. This stays until a "set as primary view" action exists (R3.3).
  - Views that are truly unique get their own page.

### 4.12 Print

`variants.print` is applied while `printing` is true.

- **`DataView`:** `printing` is a prop.
- **PacklistTable:** it resolves once for all crates (§5), so `printing` is its own data property passed to `resolveView`.

This replaces the `hiddenColumns` mutation and the 100 ms restore.

### 4.13 Shared header

`ContentHeaderComponent` contains `header-area`, a spacer, search, refresh/discard, `ViewSelectComponent`, the loading bar, and an `#actions` slot (table: New Item, Save, Undo/Redo; cards: sort). Sticky positioning stays in each renderer.

### 4.14 Modularity: cells, decorations, slots

1. **Cell registry.** A cell is the component that draws a value. Renderers read it from the resolved field (`resolvedField.cell`), which comes from the data or the view:
   - **From the data** (no view setting): a `checkbox` field gets `checkbox`, a `select` field gets `select` (both render disabled when read-only), and an editable field without a cell gets `text`, the one text editor.
   - **From the view** (`style[key].cell`, a display choice): `image` (item thumbnail, custom: see §4.1), `itemId`, `action` (the row's primary action as this value's button; `cellOptions.class` colours it), `showList` (a list of show identifiers as full-width buttons; past `cellOptions.max` one "N shows" button opens them in a modal; `cellOptions.to` is the show path with `{value}`), `slot`, `external-edit`. Its options are `style[key].cellOptions`, so each view sets them for its layout: the item shortage report lists two shows in the table, always uses the "N shows" button on calendar chips (`max: 0`), and lists every show when printing (`variants.print`, `max: null`).
   - Button lists in a cell use the shared `.cell-button-list` style (stacked, full width; left-aligned lines in print).
   - Props: `{ row, field, value, renderer, density, search }`, where `density` is `'full'` or `'compact'`. A missing compact form falls back to text.
   - The table, chips, cards **and the details grid** all use this pipeline, so a new data type is added once.
2. **Page slot** (`style[key].cell = 'slot'`). `#cell="{ row, field, renderer, density }"` is called only for those fields, and other fields keep the fallback (fixes D6). Clickable content inside chips and cards is allowed. `'external-edit'` also draws through the page slot, for a value edited outside the cell (a modal): the table shows no editor and no revert control for it.
3. **Decorations** `decorations(row, key) → Card[]`, where `key = null` is row-level.
   - Table: rendered after the cell content. `#cell-extra` stays for markup that isn't a card.
   - Calendar: inline on the chip line, or at the chip end (hidden when narrow).
   - Cards: after the line, or as footer actions.
   - Details modal: in its button bar.
   - `bucketDecorations(key, rows)` is the bucket-card equivalent.

### 4.15 Patches: the extension point (R2.4, R2.5, R2.11)

The system's only extension input is a list of view patches supplied by the component:

```js
/** @typedef {{ patch: Partial<ViewDef>, sizes?: Array<'wide'|'medium'|'narrow'> }} ViewPatch */
```

- **Application:** patches apply after variants, in order, with the same merge rules. An omitted `sizes` means all sizes.
- **Narrow toggle (R2.4):** an override created at narrow size defaults to `sizes: ['narrow']`, and a UI can toggle each override per size later.
- **Scope:** per page type (registry `id`), not per path (R2.11).
- **First source: the design queue fields preference (R6.1, R7.2).** The `DesignQueueFields` preference (§4.16) is a plain array of column names that chooses which columns show. The view orders them: the page passes one patch, `{ patch: { columns } }`, with the view's columns that the preference names, in the view's order, then any other named columns in the preference's order. It affects only the design queue, never the Schedule page. Unknown names are ignored as usual, so the list can name a sheet column before it exists.
- **Still not decided** (R2.5): other sources (session, local, per-user), which other pages allow patches, and any UI. Code-defined default views _are_ the app defaults; a preference only patches them.

### 4.16 Edit modes and other data concerns (R2.1, R2.2, R3.9)

These are set by the content component with its data, never by views.

**Edit mode** (`DataView` prop `editMode`). Every table is in one of these modes:

| Mode      | Used by                       | Behaviour                                                                                                                                        |
| --------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `none`    | report, modal, Schedule       | Read-only.                                                                                                                                       |
| `batch`   | InventoryTable, PacklistTable | Today's model. An edit (text, number, and later a checkbox toggle) changes the store data, marks the cell dirty by column key, and prompts Save. |
| `instant` | Design queue (Phase 2)        | Each edit is one verified single-cell write, after a short delay. No dirty tracking and no Save.                                                 |

**`editMode` and `editable` (R6.3).** `editMode` picks how edits are saved; `editable` on a field picks which fields can be edited. With `editMode: 'none'`, `editable` flags are ignored with a dev warning. A table with any editable field in `batch` or `instant` mode can't use the `row` trigger.

**Instant write contract** (Phase 2):

1. The renderer emits `cell-commit(row, columnKey, value)`. The cell shows the new value **immediately** (R7.3), on the local computed row.
   - `DataView` holds the commit in a small queue keyed by row identity and column for `INSTANT_WRITE_DELAY_MS` (1200 ms).
   - Another commit to the same cell within the delay replaces the queued value and restarts the timer. If the final value equals the loaded value, nothing is written, so a quick check-then-uncheck costs no write.
   - When the timer fires, `DataView` calls the page's `commitCells` hook with every queued cell, which returns a promise of one result per cell. The cells show a pending state until it settles.
   - Queued commits flush immediately when the page unmounts (in-app navigation). A browser cannot be relied on to finish a write while a tab is closing, so while commits are queued or in flight, `beforeunload` shows the browser's leave-confirmation prompt and starts the flush.
2. `commitCells` calls one data-layer function, `Requests.writeCellsVerified(database, tab, [{ row, column, value }])`. Steps 3–6 live there, in the abstraction layer, not in the page (per the [notes.md](notes.md) TODO on moving API logic into abstractions).
3. It locates the target by **identity, not position**: the row by its identity fields, the column by header name. It resolves both to live sheet indices just before writing.
4. It reads the exact cell and aborts if the read fails or the row no longer matches.
5. It writes only the desired state, in the sheet's existing convention (see checkbox values below), optionally with date metadata. A formula cell is replaced by the written value.
6. It re-reads to verify. If rows or columns moved while the write was in flight, it re-locates by identity and retries once. Otherwise it returns a failure, and `DataView` reverts the cell, shows the failed state and an error, and refreshes the data.

Phase 0's key-based `cell-edit` contract serves `batch`. `instant` adds `cell-commit` beside it and leaves `cell-edit` unchanged.

**One edit mechanism** ([cellEdits.js](../js/application/utils/cellEdits.js)). `useBatchEdits` (one per table: changed cells, revert, nested tables, undo while typing) and `useInstantEdits` (one per `DataView`: the delayed queue, overlay, write results) keep the same per-cell states, shown as the classes `cell-unsaved` and `cell-failed`. Every batch table colours unsaved cells except pack lists, whose edits change most cells.

**One editor per cell type, in both modes.** A column is `editable` when the edit mode isn't `none` and its field is editable; the table has no second flag. Every edit goes through one table method that routes by `editMode`: `batch` → `cell-edit` (dirty tracking, undo, Save), `instant` → `cell-commit`. An editable field without a `cell` edits through the `text` cell (number and `external-edit` fields keep their own editors). The text cell is the only text editor: in `batch` it reports every change, in `instant` it reports the finished edit on blur; pasting inserts plain text, and in `batch` pasted text with tabs or line breaks is left to the table's row paste.

**Preferences (R4.5, R5.2, R7.1, R7.2).** Everything an instant-write page needs from the sheet lives in the live database, so a renamed header or a new assignee needs no code change. For Schedule data the identity is Client + Year + Show, the same three inputs as `ProductionUtils.computeIdentifier` ([production-utils.js:332](../js/data_management/abstraction/production-utils.js#L332)).

_Before Phase 2 starts_, add these rows to the live `CACHE/Preferences` sheet. All use the existing `json` type, which the preferences editor already validates:

| ID                     | Name                   | Page                     | Type   | Value                                                                                                                                                                             |
| ---------------------- | ---------------------- | ------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InstantWriteTables`   | Instant-write tables   | `schedule*`              | `json` | `{"PROD_SCHED/Production Schedule": {"identity": ["Client", "Year", "Show"], "columns": ["Elev", "Panels", "Setups", "Assignee"]}}` |
| `DesignQueueFields`    | Design queue fields    | `schedule/design-queue*` | `json` | `["Client", "Show", "Size", "Note", "Elev", "Panels", "Setups", "Assignee", "Account Manager", "Ship", "Booth#"]`                                                                 |
| `DesignQueueAssignees` | Design queue assignees | `schedule/design-queue*` | `json` | `["<name>", ["<name>", "<colour word>"]]`                                                                                                                                         |
| `ColumnTypes`          | Column types           | `schedule*`              | `json` | `{"PROD_SCHED/Production Schedule": {"Elev": "checkbox", "Panels": "checkbox", "Setups": "checkbox", "Assignee": {"type": "select", "options": "DesignQueueAssignees"}}}`         |

- **Keys:** `InstantWriteTables` is keyed by `<database>/<tab>`, the same pair passed to `Database.getData`.
- **Writable columns:** `columns` lists every column an instant write may touch; `identity` lists the columns that together identify a row. Both are read through `utils/instant-write-config.js` everywhere (writes, the design queue's row identity and duplicate check, and the test-only sheet health check in `tests/sheetHealth.js`). `writeCellsVerified` refuses any column not listed. A listed column missing from the sheet is skipped with a dev warning. The older form, `"columns": {"Elev": "checkbox", ...}`, is still read: its keys are the columns and the types are ignored (types live in `ColumnTypes`).
- **Column types are declared.** `ColumnTypes` (keyed like `InstantWriteTables`) says what each column holds: `checkbox`, `select`, `date`, `number`, `currency` or `text` ([column-types.js](../js/data_management/utils/column-types.js)). Declared types win. An undeclared column is text, unless its name reads as a date, number or currency (`guessColumnType`, the only guess). `Requests.getColumnTypes` is the one cached read; the Schedule fields, the schedule filters and the design queue all use it. The table draws an editable column's cell from its type (checkbox, select, else text).
- **Select options:** a select names its option list (`"options": "DesignQueueAssignees"`), and the page that shows the column supplies its lists by name. The design queue takes `DesignQueueAssignees` (names, optionally with a colour word) from preferences. A current value that isn't in the list still shows, as an extra option, so nothing is hidden or overwritten.
- **Checkbox values (R7.3).** The sheet marks done with `X`. Unchecked cells may hold blank, `-`, `FALSE` or a date ([FakeGoogle.js:575](../js/google_sheets_services/FakeGoogle.js#L575)). In a column configured as a checkbox:
  - `X` (or `TRUE`) reads as checked, and **any other value reads as unchecked**;
  - checking writes `X`; unchecking writes blank;
  - a non-`X` value such as a date is replaced when the cell is checked, and isn't restored if it is later unchecked after the write. That is accepted for now (R8.2): these dates are disposable once the step is done. The write delay protects quick mistakes.
- **Identity source:** the fake Schedule data also has an `Identifier` column (`ALLEN ARMS 2025 SHOT`). If the live sheet keeps it filled in reliably, the preference could use `["Identifier"]` instead. The plan keeps Client + Year + Show as you specified.
- **Matching:** values are compared trimmed and case-insensitively against the raw sheet values in those columns. `computeIdentifier`'s normalized identifier isn't used, because the write has to find the raw row.
- **Guards:**
  - If a table in `instant` mode has no entry, or names a column that doesn't exist, its instant cells render read-only with a visible "write disabled: no row identity" hint.
  - If two loaded rows share an identity, instant cells on those rows are disabled. The write never guesses.
- **Read path:** the page (for `columns` and the design queue preferences) and `writeCellsVerified` (for `identity` and `columns`) read the preferences through `Requests.getPreferences`. Every read of `CACHE/Preferences` uses the one `PREFERENCES_MAPPING` in `helpers.js`, so they share a cache entry. The inventory tab lists (`INVENTORY_TAB_PREFERENCES`) are read with `InventoryUtils.getPreferenceTabs` in the data layer and `getInventoryTabList` in the UI.

**Field data types and editability** belong to field definitions. In future, details cells get data types and editing through the same cell pipeline (§4.14).

**Show notes (design queue `Note`, R6.1).** The note isn't a Schedule column, so it is saved separately in a new `CACHE/ShowNotes` tab, the same pattern as page notes in `CACHE/Notes` ([api.js:1534](../js/data_management/api.js#L1534)):

- **Columns:** `Identifier`, `Note`, `EditHistory`. `Identifier` is the value `ProductionUtils.computeIdentifier(show, client, year)` returns, so the same note follows the show on any page.
- **Reading:** the page joins notes into its rows as the field `Note`, so the `DesignQueueFields` preference can use the plain name. If the Schedule sheet ever gets its own `Note` column, the join logs a dev warning and the sheet value wins.
- **Writing:** an edit commits on blur, through the same delayed `cell-commit` queue, and `commitCells` routes it to `Requests.saveShowNote(identifier, text)`. This is an upsert: it updates the note row if it exists, appends one otherwise, and verifies by re-reading. It is not `writeCellsVerified`, because the note's row may not exist yet.
- **Setup:** add the `ShowNotes` tab to the live CACHE spreadsheet and to FakeGoogle before Phase 2.

### 4.17 Modal size tiers (R3.2)

**Survey of today's modal widths** ([styles.css:640–700](../css/styles.css#L640), [modalComponent.js](../js/application/components/interface/modalComponent.js)):

| Class today           | Rule                                                             | Effective width      | Used by                                                                                                                            |
| --------------------- | ---------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| (none)                | `.modal > .content { min-width: 360px }`                         | content-sized, ≥ 360 | Timeline detail, PacklistSelect, ImageUpload, InventorySaveModal, NewItemNumberPrompt (`''`), SaveSearch, Schedule IndexResolution |
| `small-menu`          | `max-width: 360px`                                               | 360                  | `alert`, `confirm`, preferences edit, settings menu, OverlappingShows                                                              |
| `hamburger-menu`      | `width: 360px` plus full-width buttons                           | 360                  | hamburger registry, LinkModal, RowOptionsMenu, IndexResolution family, IndexMismatch resolution                                    |
| `page-menu`           | `min-width: 800px` (100vw − 16 below 800), fixed viewport height | ≥ 800                | Transshipment, ScheduleAdvancedFilter, show-overlap picker, InventorySelector, ImageViewWithReplace, packlist template             |
| `event-detail`        | `min-width: min(90vw, 1000px)`                                   | ≈ 1000               | Schedule detail modal                                                                                                              |
| `page-note-edit-menu` | on `.modal` itself: flex column, `min-width: min(480px, 360px)`  | 360                  | page note editor                                                                                                                   |
| `reading-menu`, `red` | spacing / colour only                                            | —                    | alert, confirm, error, image, packlist new/duplicate, CadSourceRestore, DescriptionMismatch                                        |

The real committed widths are 360, about 800 and about 1000, plus content-sized. Width is mixed into layout classes, and D9 shows intended sizes that were never applied.

**Target:** exactly one size per modal, chosen by a `size` option on `$modal` (like dashboard cards), with layout and colour classes kept separate.

| `size`           | Container content width        | Container tier  | Default for                                                                                      |
| ---------------- | ------------------------------ | --------------- | ------------------------------------------------------------------------------------------------ |
| `card` (default) | 360px                          | narrow          | `alert`, `confirm`, `error`, hamburger menus, settings, preferences, page note, small prompts    |
| `wide`           | 750px (two cards plus gap)     | medium          | reading modals with more content (CadSourceRestore, DescriptionMismatch, packlist new/duplicate) |
| `page`           | `min(100vw − margins, 1000px)` | wide on desktop | `page-menu` users, every `RowDetailsModal`, any modal hosting a `DataView`                       |
| `auto`           | content-sized                  | n/a             | `image` only                                                                                     |

- **Height:** a `tall` modifier keeps `page-menu`'s fixed viewport height, like the dashboard `.tall`.
- **Padding:** each width is set on `.modal > .content` as `calc(<tier width> + 2 * var(--padding-md))`, so the container's content box is exactly the tier width.
- **Small screens:** every size is capped at `100vw − 2 × margin`, so all modals become narrow on phones.
- **Layout classes stay:** `reading-menu` (spacing), `hamburger-menu` (button layout, width removed), `red`. `page-note-edit-menu` moves its layout onto its own component.
- **Dead arguments:** D9's ignored 4th arguments are removed. The show-overlap picker gets `size: 'page'` explicitly.
- **Audit:** the modals in the "(none)" row have no fixed size today. Each one is checked at `card` width, and moved to `wide` if its content needs more room (R4.3).

---

## 5. Per-page migration

| Component                                                      | Phase | Views                                                    | Specific work                                                                                                                                                                                                                                                                                                                                                                         | Risk   |
| -------------------------------------------------------------- | ----- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| ScheduleTable                                                  | 1     | `table`, `calendar`                                      | Flags move into views. `#cell-extra` cards and `chipActionsProvider` become decorations. The inline modal becomes `RowDetailsModal` (with `#row-details`). Action is details with `button` in both views. `ScheduleContent` view state is removed. Fields go to `scheduleFields.js`.                                                                                                  | Medium |
| InventoryItemTimeline                                          | 1     | `table`, `calendar`                                      | Derived dates on a computed copy. Calendar view `rowColor` = auto(quantity), fallback green. `style.quantity.color = 'auto'`. `DetailModalComponent` → `RowDetailsModal`; calendar `action: 'row'`.                                                                                                                                                                                   | Low    |
| InventoryItemReport                                            | 1     | `table`, `calendar`                                      | `calendarColumns` → `chip`. `hide-columns` → `hidden`. `cellClass` → `style.minQty.color='auto'`. `columnClass` → `style.overlappingShows.columnColor='gray'`. `#default` → slot plus registry. Action `to` item page, `action: 'row'` in both views. Show-all reader → `dateFilter` (Phase 0).                                                                                       | Medium |
| Design queue (new page)                                        | 2     | `table` (one view)                                       | New content component and registry (`design-queue`) under Schedule, sharing `scheduleFields.js` and the Schedule data. Columns from `DesignQueueFields`; `Elev`/`Panels`/`Setups` checkboxes; `Assignee` select; `Note` from `ShowNotes`; completed rows gray; `view.sort` on Ship; default filter upcoming shows; `editMode: 'instant'`. Schedule page stays read-only. See Phase 2. | Medium |
| Inventory categories + overview                                | 3     | `items` (table), `categories` (cards, `bucketBy: 'tab'`) | `bucketKeys` and `bucketDecorations` from `categoriesStore`. Remove `_hiddenSearchData`. Widened search (§4.5). Categories: action `to` category, `row`. Overview: action `to` timeline, `button` (replaces `#details-cell`; details fields stay searchable, R3.8). Sticky `image` → `table.sticky`.                                                                                  | High   |
| PacklistContent                                                | 3     | `cards`                                                  | `formatPacklistCard` → derived fields (`_shipDate`, `_status`, `_unattached`) plus decorations. Action `to` packlist, `row`. Pins and subpage filters stay page logic. `view.sort` sets the default sort. Cards don't link `/details` (R4.1).                                                                                                                                          | Medium |
| ReportsContent                                                 | 3     | none                                                     | Builds its three-card menu inline with the card CSS; no longer uses `CardsComponent` (R3.7).                                                                                                                                                                                                                                                                                          | Low    |
| PacklistItemsSummary, ShowInventoryReport, IndexMismatchReport | 4     | one each                                                 | `hide-columns` → `hidden`. `cellClass`/`columnClass` → `style` (with `show_*` patterns). `#default` → slot plus registry. **Remove `allowHide`** with the ShowInventoryReport migration.                                                                                                                                                                                              | Low    |
| TransshipmentModal ×2, overlapping-show picker                 | 4     | one each, no URL                                         | `hide-columns` → `hidden`. The picker's action is `run` selectShow with label "Select". Modal size `page` (Phase 6).                                                                                                                                                                                                                                                                  | Low    |
| InventoryTable                                                 | 4     | one                                                      | Needs Phase 0's key-based edits. `editMode: 'batch'`. `forceDetails`, `rowDetailsVisible`, `#row-detail-rows` unchanged. `_navigate` → `navigate` cell.                                                                                                                                                                                                                               | Medium |
| PacklistTable (crates, items, summary)                         | 4     | one each, immutable; items view has a `print` variant    | `resolveView` once, shared by all crates (no `DataView` per crate). `editMode: 'batch'`. Summary: action `run` selectItem with label "+ Add Item", `theme: 'purple'`; `packlist-table` → `className`.                                                                                                                                                                                 | High   |

After Phase 4, every renderer instance gets its presentation from a view.

---

## 6. Phased delivery

### Phase 0: Groundwork (no intended visible change)

1. **Key-based edit contract:** `cell-edit` gains `columnKey`; `dirtyCells` are keyed by column key; nested dirty propagation and the `[-1]` sentinel are kept. This is the `batch` mode contract; `instant` is added beside it in Phase 2 (§4.16).
2. **Show-all rename** to `?dateFilter=all` (filterComponents, ItemReport, ShowInventoryReport, and [json-path-segment-implementation.md](json-path-segment-implementation.md) / [navigation-system.md](navigation-system.md)).
3. **Extractions:** `formatValue`, `colorFor`/`rowColorFor`, `searchWords`/`matchRow`/`matchRows`, `ContentHeaderComponent`, `RowDetailsComponent`.
4. **`useContainerSize` and `BREAKPOINTS`** (defined, unused).
5. **Tests** for the pure functions.
6. ~~D1, D2~~ done.

### Phase 1: Engine plus table/calendar pages

1. `resolveView` and `resolveAction` (variants, patches, tiers, style, colour, trigger, legacy adapter) with tests.
2. `DataView`:
   - view id, size (always `wide` until Phase 6, R6.4), resolve, renderer pick;
   - `$attrs` and slot forwarding;
   - `RowDetailsModal` (uses the existing `event-detail` class until Phase 6);
   - the primary action, `searchTerm` passing for `to` actions, decorations.
3. `ViewSelectComponent`.
4. Calendar: `formatValue`, decorations, `rowColor`, both action triggers (with aliases for `event-click` and `chipColorClass` until all three calendar pages migrate).
5. Table: both action triggers, the trailing action cell (generalizing today's details button), row-trigger guards, `details-match`. All renderers in this phase get the search limits: minimum term length, broad-search abort, and the `∞` counter (§4.5).
6. Migrate Schedule, Timeline, ItemReport. Verify §9.

### Phase 2: Checkboxes and the design queue (R5.3)

Depends only on Phases 0–1.

**Prerequisites in the live data** (you add these; FakeGoogle gets the same):

- Preferences `InstantWriteTables`, `DesignQueueFields` and `DesignQueueAssignees` (§4.16).
- An `Assignee` column on the Production Schedule.
- An `Account Manager` column in the FakeGoogle Schedule data (it exists live).
- A `CACHE/ShowNotes` tab (§4.16).

1. **`checkbox` and `select` cells** in the cell registry.
   - Checkbox works in both edit modes: in `batch` a toggle marks the cell dirty and prompts Save; in `instant` it emits `cell-commit`.
   - Select takes its options from a page-supplied list.
2. **`Requests.writeCellsVerified`** in the data layer: identity lookup, writable-column check, read, verify, write, re-read, one retry by identity, revert on failure (§4.16). Tested against FakeGoogle in [tests.js](../js/tests/tests.js), including a row moved mid-write and a duplicate identity.
3. **`instant` edit mode** in `DataView` and `TableComponent` (still through the legacy adapter):
   - the delayed `cell-commit` queue with immediate local display (§4.16);
   - pending and failed state classes;
   - no dirty tracking;
   - the `row` trigger is refused, as for any editable table.
4. **Design queue page** under Schedule (R6.1, R7.1): its own content component and registry (`design-queue`), sharing `scheduleFields.js` and the Schedule data, with `editMode: 'instant'`. The Schedule page itself stays read-only (`none`).
   - **Route:** `schedule/design-queue`, one view (`table`). It gets its own dashboard card, as a separate page (R2.9).
   - **Fields** use the production sheet's header names. The `DesignQueueFields` preference (§4.15) chooses the shown columns; the view's list (below) sets their order:
     `Client`, `Show`, `Size`, `Elev`, `Panels`, `Setups`, `Assignee`, `Account Manager`, `Ship`, `Note`, `Booth#`.
   - **`Elev`, `Panels`, `Setups`** are shown directly as checkboxes. There is no Task aggregation for now (R7.1).
   - **Completed rows** (Setups checked) stay in the list, unchanged in order. The view styles them gray with a colour rule on the checkbox itself: `rowColor: { field: 'Setups', rule: 'checked:gray' }` (R3.5). The rule reads the shown row, which carries the local edit, so the row greys as soon as Setups is checked.
     A row is complete when each of the three columns is `X`, `-` or `N/a` (R8.2). `-` and `N/a` count as done for this rule only; the cell itself still shows unchecked, and checking it writes `X`.
   - **Assignee** is a `select` whose options come from `DesignQueueAssignees`.
   - **Note** is an editable text field saved to `CACHE/ShowNotes` (§4.16).
   - **Routing writes:** `commitCells` routes by field: `Note` → `saveShowNote`; every other column → `writeCellsVerified`.
   - **Order and filter:** `view.sort = { key: 'Ship', dir: 'asc' }`, so the most urgent work is first. The initial filter is upcoming shows (Ship on or after today), set through the existing Schedule filter parameters. Filters stay a page concern (R1.16).
5. Verify the instant-write and design queue items in §9.

### Phase 3: Cards

1. `rowsToCards` and `bucketRowsToCards` with tests.
2. `CardsComponent` uses `matchRow` and the primary action (footer button or whole card), replacing `onItemClick`.
3. ReportsContent builds its own menu grid; `CardsComponent` drops `items`.
4. Migrate PacklistContent, then Inventory categories plus overview.

### Phase 4: Remaining tables

1. Report tables (removing `allowHide`), modal tables, InventoryTable, PacklistTable.
2. **Milestone:** every renderer instance is view-driven.

### Phase 5: Renderer contract (one change, R3.11)

1. Renderers read `ResolvedView` and `ResolvedAction` directly: parent-owned N-high stacks (single-row header, simpler sticky clone), calendar N chip lines, sticky from `table.sticky`, colour from `ResolvedView`.
2. **Delete the old mechanisms:**
   - `toLegacyColumns` and the column presentation flags;
   - public props `hideColumns`, `viewModes`, `chipColorClass`, `chipActions`, `onItemClick`, `items`, `defaultSortColumn/Direction`, `theme` strings including `hover-highlight`;
   - the `event-click` emit and the `#details-cell` slot;
   - `ViewChangeComponent`, `whenSmall`, `allowHide`, `handleHideColumn`.
3. Rename the path-segment `currentView` to `currentSegment` (content components and `HamburgerMenuRegistry`).
4. A dev check warns if a page passes a removed prop.
5. Manual testing period on the dev site before deploying.

### Phase 6: Size model

1. Three tiers in CSS and JS, with gutter-adjusted viewport thresholds (§4.10). Move rules out of the 800px block. `DataView` switches from a fixed `wide` to `useContainerSize()`, so JS and CSS tiers turn on together (R6.4).
2. `variants.medium`/`narrow` support verified. Schedule narrow variant.
3. Modal size tiers for **all** modals (§4.17), with the audit and the D9 cleanup.

### Later (not scheduled, built on this system)

- Other patch sources (beyond the `DesignQueueFields` preference) and customization UI (per page).
- Item images as data: the inventory stores each item's image URL, and the thumbnail is how a view styles a URL column (`style.cell`); editing follows that column's data controls. Replaces the custom `image` column (`itemImageStyle`) and the image cell's own lookup and `editable` option.
- Several row actions per table, each with its own styling, so the Schedule `packlist` column becomes an action.
- Instant-write checkboxes on the Schedule page itself, and a Task column that aggregates design progress (R7.1).
- Editable details cells.
- Ship/return calendar view.
- Dashboard "set as primary view".
- Performance monitoring.

### Intended visual shifts

- **Calendar:**
  - chips show formatted values and gain ship-date and transship badges (D5);
  - Schedule chips get a ☷ action button, and their bodies no longer open the modal.
- **Tables:**
  - the picker's Select and the summary's "+ Add Item" buttons move from their own columns into the sticky action cell, and those tables lose hover highlight;
  - ItemReport rows become clickable (navigate to the item), and the `itemId` button becomes text;
  - transshipment tables lose hover highlight;
  - stacked headers become labels in one cell (Phase 5);
  - inventory overview's action button uses the standard action button style (it already navigated).
- **Search:**
  - report fallback cells gain search highlighting (D6);
  - category card search matches the same fields as the overview table;
  - single-character words are ignored on every page;
  - a search matching more than 80% of a set over 100 rows is ignored: the set stays unfiltered and unhighlighted, and the match counter shows `∞`.
- **Design queue (Phase 2):** a new page with checkboxes and an assignee pick list that write to the Schedule sheet after a 1.2-second delay, and a saved note per show; completed rows turn gray.
- **Sizes:**
  - viewports and containers in the 600–999px range follow the medium tier (Phase 6);
  - the compact navbar and padding now apply below 1024px instead of at 800px and below, so tablets and small laptop windows get compact chrome;
  - Schedule narrow stacks Client under Show;
  - modals snap to the `card`, `wide` or `page` widths; `page-menu` modals grow from about 800px to 1000px on desktop.

---

## 7. Challenges

Each entry gives the problem (where it isn't obvious), the approach, and the risk that remains.

**C1. Index-based edits.** Phase 0. Watch nested dirty propagation and the `[-1]` sentinel ([L3303](../js/application/components/interface/tableComponent.js#L3303)).

**C2. `TableComponent` size.**

- _Approach:_ the adapter keeps Phases 1–4 out of table internals, except the action cell and row trigger. Phase 5 changes the stack, header, sticky and colour code together.
- _Residual risk:_ the sticky-clone width mirroring (`stickyColumnWidths`, `getCloneStickyThStyle`).

**C3. Forwarding through `DataView`.** `inheritAttrs: false` with `v-bind="$attrs"`; slots forwarded with `<template v-for="(_, name) in $slots" #[name]="scope"><slot :name="name" v-bind="scope || {}"/></template>` (runtime compiler). PacklistTable's crates bypass `DataView`.

**C4. Dynamic fields.** Unknown keys are ignored, and patterns are supported. A renamed sheet header silently moves a field to details (logged in dev).

**C5. Derived fields**, including the new colour fields, live on computed copies and never reach store save paths (the [notes.md](notes.md) date rule). The design queue `Note` (joined from `CACHE/ShowNotes`, not a Schedule column) is saved only through `saveShowNote`, never through the Schedule store.

**C6. Size detection.**

- Container scope uses the same thresholds as CSS.
- Modal content boxes get definite widths with padding added back (§4.17).
- Viewport thresholds add the page gutter; the residual bands are documented in §4.10.

**C7. Sticky × stack × size.** Re-measure on every change to the view id, size or patches.

**C8. Categories data path.**

- _Decision:_ accepted.
- _Approach:_ render from `bucketKeys` immediately; add a dev timing log; revert via git if slow.

**C9. Bucket state** comes from `bucketDecorations` (`categoriesStore`).

**C10. Search changes.**

- `hideColumns` → `hidden`, with search compared before and after per page.
- Category search widens to all item fields. The broad-search abort (R4.2) stops short numbers that match most quantities, and single characters are ignored everywhere.

**C11. Details in the modal.** `#row-details` content that relies on table row context gets `rowIndex: null` and `isExpanded: true`. Audit Schedule's slot.

**C12. URL.** Show-all rename across four readers; the `layout` fallback; dashboard paths with `view=all` lose show-all (accepted).

**C13. Reactivity.** Keep the explicit `isAnalyzing`/`analysisProgress` reads, memoize adapters per row and bucket, and avoid deep watchers.

**C14. Row trigger versus everything else in a table.**

- _Problem:_ clipboard row click, search-result click, selection and drag share `<tr>` clicks.
- _Approach:_ the guards in §4.8. Editable tables never get a row trigger.
- _Residual risk:_ accidental activation on touch scroll, so use `click`, not `touchend`.

**C15. Testing.** Pure functions get tests; behaviour uses the §9 checklist.

**C16. Undo across view switches.** Same-layout switches keep the renderer mounted. Verify `undoRegistry` survives layout remounts.

**C17. Colour as data.**

- _Problem:_ every colour decision that is logic today (cardClass branches, chipColorClass fallbacks, cellClass functions) has to become `auto`, a static class, or a derived field.
- _Approach:_ migrate the four current function rules: ItemReport `minQty`, ShowInventoryReport `show_*`, Timeline and ItemReport chip colours, and packlist cardClass.
- _Residual risk:_ the object form of `cellClass` (`{ className: condition }`) is supported by the table but unused by pages, so it is dropped.

**C18. Phase 5 removal.** Removing public props breaks any page that wasn't migrated. Phase 4's milestone, the dev prop check and the manual testing period gate it.

**C19. One action per row.**

- _Problem:_ pages that today have both a row action and a details view (the inventory overview; Packlist `/details`, which cards won't link, R4.1) must pick one primary action.
- _Approach:_ navigating actions keep details searchable and pass the search (R3.8). Any secondary action becomes a decoration.
- _Residual risk:_ an in-place `run` action with details fields hides those details; `resolveAction` warns.

**C20. Modal consolidation.**

- _Problem:_ snapping content-sized modals to fixed widths can clip or crowd content.
- _Approach:_ audit every "(none)" modal (§4.17) at its new size, and keep `auto` only for images.
- _Residual risk:_ about 30 call sites change in one phase; each needs a quick visual check.

**C21. Instant writes.**

- _Problem:_ rows and columns can move between the read and the write.
- _Approach:_ identity-based location, read-verify-write, one retry, then revert and refresh (§4.16).
- _Residual risks:_
  - Duplicate identities (two rows with the same Client + Year + Show). Those rows are write-disabled, not guessed (§4.16).
  - The 1.2-second write delay. In-app navigation flushes queued writes. Closing the tab shows the leave prompt, but a user who forces the close can lose the last change.
  - Overwritten values. Checking a box replaces a date or `-` with `X`, and unchecking writes blank. Accepted for now (R8.2); the design queue will be improved later.

---

## 8. Feature parity matrix

Legend: ✅ today · 🟢 this refactor · 🔵 later · — not applicable

| Feature                                 | Table                  | Calendar       | Cards                    |
| --------------------------------------- | ---------------------- | -------------- | ------------------------ |
| Tiers (shown/details/hidden)            | ✅ ad hoc → 🟢         | 🟢             | 🟢 (row and bucket)      |
| Search filter / navigate                | ✅ / ✅                | — / ✅         | ✅ / ✅                  |
| Minimum term length, broad-search abort | 🟢                     | 🟢             | 🟢                       |
| Primary action (details or page action) | details ✅ → 🟢        | ✅ ad hoc → 🟢 | ✅ ad hoc → 🟢           |
| Trigger: button / row                   | ✅ / 🟢 (not editable) | 🟢 / ✅        | 🟢 / ✅                  |
| Details-only match indicator            | ✅                     | 🟢             | ✅ (matched fields) → 🟢 |
| Navigation passes search                | ad hoc → 🟢            | 🟢             | ad hoc → 🟢              |
| Formatting                              | ✅                     | 🟢             | 🟢                       |
| Colour (row/column/cell, theme)         | ✅ ad hoc → 🟢         | ✅ ad hoc → 🟢 | ✅ ad hoc → 🟢           |
| Stacks                                  | 2 → 🟢 N (Ph5)         | 2 → 🟢 N (Ph5) | 🟢 lines                 |
| Size variants (medium/narrow)           | CSS → 🟢               | CSS → 🟢       | CSS → 🟢                 |
| Sticky columns / header                 | ✅                     | header ✅      | header ✅                |
| Cells and decorations                   | ✅ → 🟢                | 🟢             | 🟢                       |
| Default sort from view                  | 🟢                     | —              | 🟢                       |
| Print variant                           | 🟢                     | 🔵             | 🔵                       |
| Patches / customization                 | 🟢 input / 🔵 UI       | 🟢 / 🔵        | 🟢 / 🔵                  |
| Edit modes: batch / instant             | ✅ / 🟢 (Phase 2)      | —              | —                        |
| Editing, drag, selection                | ✅ (renderer)          | —              | —                        |

---

## 9. No-feature-loss verification checklist

Run per migrated page at desktop width, in a 360px dashboard card, in a double-width card, in a modal where applicable, and in print where applicable.

**All renderers**

- [ ] Header-area filters, refresh, loading/analysis progress (categories bar now moves)
- [ ] Search: highlight, navigate, filter, Show all, `searchTerm` URL sync, search kept into a category and into the timeline
- [ ] Search limits: single characters ignored; on a set over 100 rows, a search matching more than 80% leaves the set unfiltered and unhighlighted, and the counter shows `∞`; a precise search still filters and highlights; categories count member rows
- [ ] View switch: `?view=` updates, back/forward, dashboard card path updates, `?layout=calendar` and `?view=categories` links
- [ ] Show-all through `?dateFilter=all` (Schedule, ItemReport, ShowInventoryReport)
- [ ] Primary action: right action per §4.8 table; button vs row trigger; glow or `details-match` on details-only matches; row trigger ignores buttons, inputs and selected text; keyboard Enter/Space
- [ ] Details: table expand, or `RowDetailsModal` in calendar and cards (fields, `#row-details`, actions)
- [ ] Colours: theme on header/footer/buttons, row/column/cell colours as before, state classes win
- [ ] Analyzing, error, empty states

**Table**

- [ ] Column order, sticky, sticky-clone alignment, stacks, sort including stack lines, `type: 'item'` ordering
- [ ] Details: expand, `#row-details`, `#row-detail-rows`, `forceDetails`, `rowDetailsVisible`
- [ ] Hidden fields absent and unsearchable
- [ ] Editing (`batch`): all cell types, revert, hints, dirty markers on the right cells, Save, Discard, undo/redo, locks; no row trigger
- [ ] Rows: new row, drag/drop, drop-onto, selection, delete/restore, cut/copy/paste, groups, nested dirty
- [ ] Mobile tap-to-show column buttons; footer counts
- [ ] Packlist print shows Pack/Check, and the screen view is unchanged after printing
- [ ] Modal tables: transshipment flow; picker Select; summary "+ Add Item"

**Calendar**

- [ ] Spans, week splits, labels, year, week start, today, sticky header
- [ ] Chip lines, colours, decorations, end decorations hidden when narrow, action button visible when narrow
- [ ] Schedule chips: modal via button only; Timeline chips open details; ItemReport chips navigate

**Cards**

- [ ] Inventory: all categories including empty ones, colours, footers, Save, member search with matched fields, click navigates with `searchTerm`, no details
- [ ] Packlists: content, footers, actions, pins, subpages, sort, click opens the packlist; no `/details` link
- [ ] Reports menu unchanged (now inline in ReportsContent)

**Instant write and design queue (Phase 2)**

- [ ] Checkbox shows checked at once; nothing is written for 1.2 seconds; check-then-uncheck within the delay writes nothing
- [ ] After the delay, one cell is written: `X` to check, blank to uncheck; a date or `-` in the cell reads as unchecked
- [ ] Leaving the page during the delay still writes the queued change
- [ ] Row moved or inserted above mid-write: re-located by Client + Year + Show and written correctly
- [ ] Duplicate identity: those rows' cells disabled; missing preference: cells read-only with the hint; a column not in `columns` is refused
- [ ] Failed write: cell reverts, error shown, data refreshed; no Save prompt or dirty marker
- [ ] Assignee pick list shows `DesignQueueAssignees`; an existing value outside the list still shows
- [ ] Note saves on blur, creates its `ShowNotes` row the first time, and survives refresh
- [ ] Design queue: upcoming shows by default, sorted by Ship; shown columns follow `DesignQueueFields`, in the view's order; a row turns gray when Setups is checked, and stays in place
- [ ] Schedule page unchanged and read-only; it shows the written values after refresh

**Modals (Phase 6)**

- [ ] Every modal at its new size on desktop and phone: no clipped content, tables in `page` modals at the wide tier

---

## 10. Decisions log

**Revision 1 answers**

| #     | Decision                                                                          | Applied in     |
| ----- | --------------------------------------------------------------------------------- | -------------- |
| R1.1  | URL param `view`; show-all → `dateFilter=all`, no compatibility                   | §4.11, Phase 0 |
| R1.2  | All built-in views migrate as defaults; future pages use the system               | §1, §5         |
| R1.3  | Per-page default views, some with hidden fields; some views immutable             | §4.3           |
| R1.4  | Design queue needs checkbox fields and a write mechanism first (detailed in R2.1) | §4.16          |
| R1.5  | Load all inventory rows for categories; revert if slow                            | C8             |
| R1.6  | Search only shown and details fields (table `visibleRows` rule)                   | §4.5           |
| R1.7  | Details button instead of chip-click details (Schedule calendar)                  | §4.8           |
| R1.8  | Unify breakpoints, moving toward container-based (refined by R2.10, R3.1)         | §4.10          |
| R1.9  | Remove the ad-hoc hide button (refined by R2.3)                                   | §1, Phase 4    |
| R1.10 | The view owns the default sort; user sort is session-only                         | §4.2           |
| R1.11 | Shared colour mechanism (refined by R2.8)                                         | §4.9           |
| R1.12 | Details parity: shared modal, `#row-details` in the modal (refined by R3.4)       | §4.8           |
| R1.13 | Never rename view ids; alias map when needed                                      | §4.11          |
| R1.14 | `bucketBy`                                                                        | §4.2, §4.6     |
| R1.15 | History is not part of views                                                      | §1             |
| R1.16 | Filters decoupled from views                                                      | §1             |
| R1.17 | Manual checklist for renderer behaviour                                           | C15, §9        |
| R1.18 | Rephrased as R2.13                                                                | —              |

**Revision 2 answers**

| #     | Decision                                                                                                                                                      | Applied in         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| R2.1  | Checkbox writes use atomic read-verify-write (`TRUE`/`FALSE` or `X` replacing a formula), with optional date metadata. Separate from views (refined by R3.9). | §4.16, Phase 2     |
| R2.2  | Data types and editability are configured with fields, alongside default views; views don't control them. Details cells get types and editing later.          | §4.1, §4.8, §4.16  |
| R2.3  | Option (a): remove the hide button and accept it. Removed at ShowInventoryReport's migration, since all other presentation mechanisms are removed.            | §1, §5             |
| R2.4  | Each override can be toggled per size; overrides created at narrow size default to narrow.                                                                    | §4.15              |
| R2.5  | Code default views are the app defaults, and other default mechanisms are removed. Override sourcing is deferred; build the patch input only.                 | §1, §4.15, Phase 5 |
| R2.6  | ~~`onRowClick` as a separate hook~~, superseded by R3.4                                                                                                       | §4.8               |
| R2.7  | No details for bucket cards. Navigation for packlist `/details` and the inventory timeline (refined by R3.4 and R4.1: cards don't link `/details`).           | §4.6, §4.8         |
| R2.8  | Colour is part of views: auto colour, row colour, column colour. Auto colour overrides row colour. Theme colours only header, footer and buttons.             | §4.9               |
| R2.9  | One dashboard card per page; unique views get their own pages; design queue is its own page. "Set as primary view" later.                                     | §1, §4.11          |
| R2.10 | Size tiers wide/medium/narrow, height handled separately; chrome keeps viewport breakpoints.                                                                  | §4.10, Phase 6     |
| R2.11 | Override scope per page type                                                                                                                                  | §4.15              |
| R2.12 | Widen category search for parity with the table                                                                                                               | §4.5               |
| R2.13 | PacklistTable stays immutable for now                                                                                                                         | §5                 |
| R2.14 | Reports stays a hand-built menu (refined by R3.7)                                                                                                             | §5                 |
| R2.15 | Customization is a later stage                                                                                                                                | §1, Later          |
| R2.16 | Different purpose → new page; same data, different visualization → view                                                                                       | §1                 |

**Revision 3 answers**

| #     | Decision                                                                                                                                                                                      | Applied in        |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| R3.1  | Thresholds accepted (narrow < 600, medium 600–999, wide ≥ 1000, short < 500 high). The double-wide dashboard card is medium by design. Viewport thresholds add the page gutter with `calc()`. | §4.10             |
| R3.2  | Modal widths consolidate into a few size tiers, like dashboard cards, applied as defaults; adjust if issues appear.                                                                           | §4.17, Phase 6    |
| R3.3  | A dashboard card keeps remembering its last view until "set as primary view" exists.                                                                                                          | §4.11             |
| R3.4  | Row click and the details button merge into one primary action, triggered by a button or the row. Navigating actions pass the search. Editable tables can't use the row trigger.              | §4.8              |
| R3.5  | Colour precedence accepted (state classes, then cell, column, row). Logic-based colours are page-computed derived fields with `rule: 'value'`.                                                | §4.2, §4.9        |
| R3.6  | `className` carries structural classes; `theme` is colour only.                                                                                                                               | §4.2, §4.9        |
| R3.7  | Reports builds a simple card grid inline; `CardsComponent` drops `items`.                                                                                                                     | §4.6, §5, Phase 3 |
| R3.8  | Details fields can coexist with a navigating action: they're searched and light the indicator without being visible in place. The destination must reveal them.                               | §4.5, §4.8, D8    |
| R3.9  | Tables are batch (store, dirty, Save) or instant (single verified cell write with relocation fallback). The content component's data decides, not the view.                                   | §4.16             |
| R3.10 | Minimum search term length for all fields (refined by R4.2: 2 everywhere, plus broad-search abort).                                                                                           | §4.5              |
| R3.11 | Phase 5 ships as one change after a manual testing period.                                                                                                                                    | §1, Phase 5       |

**Revision 4 answers**

| #    | Decision                                                                                                                                                                     | Applied in          |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| R4.1 | Packlist cards don't link `/details`; no change for now.                                                                                                                     | §4.8, §5, §9        |
| R4.2 | Search is for pinpointing. Minimum term length is 2 on all searches. On sets over 100 rows, a search matching more than about 80% aborts and its results aren't processed.   | §4.5, §6 shifts, §9 |
| R4.3 | `page-menu` modals become `page` (1000px on desktop). Content-sized modals default to `card`.                                                                                | §4.17               |
| R4.4 | Compact navbar and padding at medium and narrow.                                                                                                                             | §4.10, §6 shifts    |
| R4.5 | Schedule rows are identified by Client + Year + Show. Identity columns live in a JSON preference. Only tables with instant-write checkboxes need one (today, Schedule only). | §4.16, C21          |
| R4.6 | Keep the calendar difference: Timeline opens details on chip click (`row`); Schedule uses a button.                                                                          | §4.8                |

**Revision 5 answers**

| #    | Decision                                                                                                                  | Applied in          |
| ---- | ------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| R5.1 | An aborted search shows the unfiltered set with no message. A visible search-navigation card shows `∞`.                   | §4.5, §6 shifts, §9 |
| R5.2 | The instant-write preference also lists the checkbox columns (`InstantWriteTables`: `identity` + `checkboxes` per table). | §4.16, Phase 2      |
| R5.3 | Checkboxes, instant write and the design queue are Phase 2, right after Phase 1. Former Phases 2–5 are renumbered 3–6.    | §5, §6              |

**Revision 6 answers**

| #    | Decision                                                                                                                                                                                                                                                                                                           | Applied in                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| R6.1 | Design queue fields (refined by R7.1): Client, Show, Size, Task (derived from `Elev`, `Panels`, `Setups`), Assignee (new live column), Account Manager (add to fake data), Ship, Note (saved separately), Booth#. Shown fields controlled by a preference. Sorted by upcoming work; initial filter upcoming shows. | §4.15, §4.16, §5, Phase 2 |
| R6.2 | Drop `unlisted`; `details` and `hidden` each accept `'rest'`, and at most one of them may use it.                                                                                                                                                                                                                  | §4.2, §4.4                |
| R6.3 | `editMode` picks how edits are saved, and `editable` picks which fields; `editable` is ignored with `editMode: 'none'`.                                                                                                                                                                                            | §4.16                     |
| R6.4 | `DataView` passes `wide` until Phase 6, so JS and CSS size tiers switch on together.                                                                                                                                                                                                                               | §3, §4.10, Phases 1 and 6 |
| R6.5 | `ActionDef` has exactly one of `to` and `run`.                                                                                                                                                                                                                                                                     | §4.8                      |
| R6.6 | Removed: `table.details: 'modal'`, per-view `search` overrides, the `short` flag, the bare `rowColor` form.                                                                                                                                                                                                        | §4.2, §4.5, §4.8, §4.10   |
| R6.7 | `style[key].column` renamed `columnColor`; "6.7 Intended visual shifts" renamed "Intended visual shifts".                                                                                                                                                                                                          | §4.2, §4.9, §5, §6        |

**Revision 7 answers**

| #    | Decision                                                                                                                                                                                                               | Applied in                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| R7.1 | No Task aggregation yet: the design queue shows the `Elev`, `Panels` and `Setups` checkboxes directly. Completed rows stay in the list unchanged and are styled gray. Assignee is a pick list from a preference array. | §4.16, §5, Phase 2, Later |
| R7.2 | The fields preference is exclusively "Design queue fields" (`DesignQueueFields`) and doesn't affect the Schedule page.                                                                                                 | §4.15, §4.16              |
| R7.3 | In checkbox columns any non-`X` value counts as unchecked. The check shows immediately, and the write waits a short delay so a quick uncheck cancels it.                                                               | §4.16, §9                 |

**Revision 8 answers**

| #    | Decision                                                                                                                                                            | Applied in          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| R8.1 | Checkboxes only in the design queue; the Schedule page stays read-only.                                                                                             | §4.16, §5, Phase 2  |
| R8.2 | For now, dates in checkbox columns are disposable once checked, and `-`/`N/a` count as done for the gray "completed" rule. The design queue will be improved later. | §4.16, Phase 2, C21 |

**Notes on how answers were applied**

- **R3.4:** which trigger each instance uses is in the §4.8 table. Labelled per-row buttons (Select, "+ Add Item") became `button`-trigger actions with labels, so they keep their wording.
- **R3.9:** the mode is per table (`editMode`), not per field, since you described tables falling into two categories. Read-only tables are a third, implicit `none`.
- **R3.10 and R4.2:** "minimum length for all fields" is read as a per-word minimum. Words shorter than the minimum are dropped from the search, across every field.
- **R4.2:** "the set" is the rows handed to the renderer after page filters, and for bucket cards it is the member rows. A row counts as a match if it matches through shown or details fields. "Don't process results" means the count runs first with an early exit, and no filtering, highlighting, glow or matched-field lists are produced.
- **R4.4:** compact chrome now covers medium. That changes the narrow viewport threshold to `calc(600px + 2 * 8px)` and leaves the only residual mismatch at the wide boundary. Full-width dashboard cards stay narrow-only, so medium keeps the card grid.
- **R4.5 and R5.2:** the preference row (`InstantWriteTables`, holding identity and checkbox columns) is for you to add to the live database before Phase 2. The exact row is in §4.16.
- **R6.1 and R7.2:** the design queue fields preference is the first patch source (`DesignQueueFields`, §4.15), so no separate mechanism was added. "Sort based on upcoming work" became Ship ascending.
- **R7.1:** "keep completed in the list without change" is read as: same position and sort, only the colour changes. The Schedule page stays read-only in Phase 2 (R8.1).

---

## 11. Open questions

1. **Batch-mode checkboxes.** Phase 2 builds the checkbox cell for both edit modes, but no `batch` table uses checkboxes yet; only the design queue (instant) does. Proposed: build and test only the instant path in Phase 2. The batch path works the same as any other editable cell (`cell-edit` with a value) and gets added and tested when a batch table first needs a checkbox. OK?
   (Answer) Yes, the batch path just requires checkboxes as an element that mutates store data and follows standard save pathways. It is not really a new feature.
