# TopShelf Live Inventory: conventions for agents

The app is plain ES modules and Vue 3 (Options API, global `Vue`) under `docs/`, served as static files. There is no build step.

## Data or view?

Fields describe what the data is. Views describe how it looks and behaves. Read "Principle: data or view?" in [docs/notes/views-and-renderers-plan.md](docs/notes/views-and-renderers-plan.md) before you change a page, a field, a view or a renderer. `resolveView` ignores presentation set on fields and warns on localhost.

## Styling (docs/css/styles.css)

Style through shared classes, and adapt them to a context with one scoped rule.

- **Shared structural classes, one job each:**
  - `.content`: a padded column with a gap. It is the modal body and the table's row-details panel.
  - `.button-bar`: a joined row of controls.
  - `.card`: a small labelled block or button.
  - `.details-grid` with `.detail-item`: labelled values.
  - `.cell-button-list`: stacked, full-width buttons in one cell.
- **A context adapts a shared class with one parent-scoped rule.** Examples: `.details-container > .content` (the panel look), `.calendar-chip .card`, `td .card, .detail-item > span .card`. Don't add a new class or a wrapper that repeats what a shared class already does.
- **No layout-only wrappers.** A component renders into its container's layout. A modal component's root nodes go straight into the modal's `.content`, which gives the column and gap. Several root nodes need `inheritAttrs: false`.
- **One size scale per context, defined once.** A context with its own sizes sets custom properties on its root, and every child reads them. For example, `.calendar-chip` sets `--chip-control-height` and `--chip-font`.
- **Fix the generic rule you're fighting, not the element.** Before adding an override, find the generic rule that causes the conflict, such as `.button-bar .button-symbol` (28px minimum) or `.button-bar button:not(.button-symbol)` (grows). Scope one context rule above it, instead of patching single elements.
- **Values in the same role look the same.** Cards beside a value share one compact card rule, whether the value is in a table cell or a detail item.

## Working in this repo

- **Others edit the working tree while you work.** Never use `git stash`, `checkout` or `reset` on the tree. When committing, stage only your own changes. Use `git show <rev>:<path>` or a separate worktree to look at old versions.
- **Tests run in the browser.** On localhost the app loads `docs/js/tests/tests.js` after startup. `docs/js/tests/sheetHealth.js` is test-only and never loads on the live site.
