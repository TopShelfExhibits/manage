# TopShelf Live Inventory: conventions for agents

Top Shelf Exhibits' live inventory web app. It is plain ES modules and Vue 3 (Options API, global `Vue`) under `docs/`, served as static files, with no build step.

## Ground rules

- **The app is live, with real users.** Work happens on a development branch, but the data structures in the sheets and the preferences must stay backwards compatible. Otherwise, propose an admin-run, one-time migration plan.
- **Simplicity and modularity first.** Remove unused code. Add a new system only when the existing structure and patterns can't do the job.
- **No extra documentation files.** Don't create markdown files the user didn't ask for, such as "implementation-complete" or "summary-of-work" notes. Update the existing notes instead, mainly [docs/notes/views-and-renderers-plan.md](docs/notes/views-and-renderers-plan.md).

## Domains and layers

- **Domains:**
  - Inventories: items stored in warehouse crates, with their current information.
  - Pack lists: the items packed in crates for a show, used to ship items out and back.
  - The Production Schedule: shows and their production tasks.
- **Layers** (`docs/js/`), each talking only to the one below it:
  1. `application/`: the Vue UI. Components keep their own reactive state and reach persistent data only through the API, usually through reactive stores (`utils/reactiveStores.js`).
  2. `data_management/`: the API (`api.js`, `Requests.*`) and its domain abstractions (`abstraction/`: `database.js`, `inventory-utils.js`, `packlist-utils.js`, `production-utils.js`, `application-utils.js`, …).
  3. `google_sheets_services/`: all direct Google Sheets and Drive access, and the company Dropbox (read only, through the sign-in service: `DropboxFiles.js`). Neither the UI nor application logic touches it.
  4. `auth/`: sign-in, beneath the services, which take their tokens from it. It imports no Google API, data layer or UI code (only `networkState.js`). `AuthSession.js` is the session and knows no provider. `SignInService.js` is the only client of the sign-in service (the Apps Script in `apps-script/auth-broker`; a server answering the same actions replaces it). `SignInWindow.js` is the only provider-specific (Google) part. `authStatus.js` holds the statuses and `classifyError`.

## Data layer: caching and invalidation

- **Caching is automatic.** `wrapMethods` caches API and abstraction methods. A cached method takes `deps` as its first parameter and calls other cached methods with `deps.call(...)`, which records the dependency chain.
- **Mutations invalidate from the bottom.** Database mutation methods invalidate the matching `getData` caches. The invalidation cascades up the recorded chains to the API, and reactive stores reload. Don't invalidate caches by hand.
- **Early cutoff stops unchanged values.** A method listed in `cutoffMethods` (`wrapMethods`) is recomputed when invalidated, and its cascade goes on only if its value changed. Quantity analysis reads the Production Schedule only through `ProductionUtils` cutoff methods: `getScheduleDateRows` (the date and identity columns), `getShowDates(id)`, `getOverlappingShowIds(filters)` and the chain dates. Don't pass full schedule rows (`getOverlappingShows`, `getShowDetails`) into analysis: an edit to any task column would rerun it. See [docs/notes/incremental-invalidation-plan.md](docs/notes/incremental-invalidation-plan.md).
- **Tab reads are batched.** Tab reads made at the same moment go out as one request per spreadsheet. Code that reads many tabs in a loop calls `Database.prefetch(tableId, tabNames)` before the loop.
- **Whole-tab writes refill their own cache.** A whole-tab write's response is the tab as a read returns it. Database caches that response (`fillCache`), so the reload reads nothing. Range writes re-read.
- **Sheet data never expires.** Each poll reads the spreadsheets' Drive `modifiedTime`, and the Caching tab stamps name the changed tab. Together they keep cached reads current. See "Spreadsheet watch" in [docs/notes/caching-tab-structure.md](docs/notes/caching-tab-structure.md). Don't add expiries to data reads. A source that isn't a spreadsheet joins the same poller with `watchSource` (`caching.js`), as Dropbox listings do through Dropbox's change list.
- **Mutation methods are never cached.** They take no `deps`, don't use `deps.call`, and are listed in the exclusion list passed to `wrapMethods` at the bottom of `api.js`. A new mutation method must be added to that list.
- **Today is a cached source.** Cached code that depends on today reads it with `deps.call(ApplicationUtils.getToday)`, never `new Date()`. The date rollover then invalidates the result. `helpers.js` (`currentDate`, `todayISOString`, `offsetToISO`) is the one source of "now", on the local calendar.
- **Persisted results are opt-in.** A slow API method can be listed in the `persistentMethods` argument of `wrapMethods` at the bottom of `api.js`. Its result is then saved to `CACHE/Analytics` and restored by later sessions while its sources are unchanged. See [docs/notes/caching-tab-structure.md](docs/notes/caching-tab-structure.md).
- **Helpers stay uncached.** Reusable analysis helpers live in `data_management/utils/helpers.js` (pure). They must never call cached functions, which would break the invalidation chains.
- **Sign-in lives in one session.** `AuthSession` (`auth/`) gets, keeps and renews every token. It needs the sign-in service (`APP_CONFIG.AUTH_BROKER_URL`); there is no sign-in without it. On localhost, `data_management/services.js` runs the same session over fakes of the service and the provider's window (`fakeSignIn` in `FakeGoogle.js`), so tests exercise the real session; don't fake the session itself. Requests take tokens only through `getToken()`, which never opens a window: background code can't prompt. Google requests get their token from `GoogleSheetsService.withExponentialBackoff`, which passes it to the request function; don't read `gapi`'s token. The data layer reads the signed-in email from `AuthSession.state.email`, never from `authState`. The only sign-in UI is the header button and `app.js`'s session banner, drawn from `authState` (`application/utils/auth.js`), and only a click opens a popup. Test failures with `isAuthError`/`classifyError` (`authStatus.js`), never status codes. See [docs/notes/auth-audit-findings.md](docs/notes/auth-audit-findings.md).
- **The connection is one state.** `networkState.js` (online, slow, unreachable, offline) is fed by every Google request in `withExponentialBackoff`. Background work checks `networkState.isOffline`, never `navigator.onLine`. A new request that may have landed and must not run twice (an append, a delete by row number, a copy) passes `{ once: true }`. Edits made during an outage wait for the connection; they are never reverted for it. See "Connection" in [docs/notes/caching-tab-structure.md](docs/notes/caching-tab-structure.md).
- **Out-of-date sessions never write shared data.** Once `version.json` names a newer deploy (`isAppOutdated`, `caching.js`), the app banner turns editing off, and every Database write method starts with `await assertAppCurrent()`, which throws `APP_OUTDATED`. A new Database write method must start with it too. Only a session's own bookkeeping (user data, short links) passes `bookkeeping: true` to `setData`/`createTab`; locks, cache timestamps and persisted results write below Database and are unaffected.

## Data or view?

Fields describe what the data is. Views describe how it looks and behaves. Read "Principle: data or view?" in the plan notes before you change a page, a field, a view or a renderer. `resolveView` ignores presentation set on fields and warns on localhost.

## Editing patterns

- **Deleting rows: mark, then save.** Never remove a row from a store on click.
  - Draggable tables (pack lists) have the table's own tools: select rows by their drag handle and press Delete to mark them; cut and paste move rows. Only turn on `draggable` where row order means something that saves.
  - Other tables (the history page's admin delete, the proposal page) draw a per-row button: toggle the mark with `store.toggleRowDeletion(row)` through `editWithLock` with an undo step (see "Edits take the lock behind them"), and draw `RowDeletionButton` (`cells.js`: a trash icon, then restore-from-trash while marked).
  - The row shows as marked. `save()` removes marked rows, and Database archives inventory rows it removes. Discard or undo cancels.
  - The save modal takes `deletionCount`: marked rows can't be scheduled or sent to a proposal.
  - Find a store's row with `store.indexOfRow(row)`. Item numbers can repeat or be blank.
- **Edits take the lock behind them.** On a page with `sheetLockMixin`, make every user edit with `await this.editWithLock(apply, revert, { action, undo })`. It captures an undo step of type `undo` when given, applies the change at once and takes the lock in the background. If someone else holds the lock, it runs `revert`, drops the undo step, and, when `action` is given ("delete"), tells the user who holds it. Don't wait on `acquireLockForEdit()` before an edit: that makes the first click on a page take a second.
- **Adding inventory items: `InventorySelectorModal`.** A table that adds rows from inventory sets `showNewRowButton` (a New Item button; `newRow` adds the row-level add buttons on draggable tables) and opens this modal from `@new-row`. It takes `onItemSelected`, an optional `onAddEmpty` (shows "+ Empty Row") and an optional `loadReferenceDate` (the date whose quantities to show; today when omitted). The pack list and proposal pages use it.
- **Page options in the URL: `ParamToggles`.** An on/off option a page reads goes in its container's URL parameters, so links and dashboard cards keep it.
  - Declare the toggles as `[{ param, label, default }]`, and render `ParamToggles` in the page's hamburger menu.
  - Read a toggle with `paramToggleValue(NavigationRegistry.getParametersForContainer(containerPath, currentPath), toggle)`.
  - Write container parameters only through `NavigationRegistry.updateContainerParams`, which also handles the dashboard.
- **Admin-only UI is temporary.** `isTemporaryAdmin()` (`auth.js`) checks a hand-kept username list. It only shows or hides buttons until a real admin system with permissions replaces it, so don't build on it.

## Styling (docs/css/styles.css)

Style through shared classes, and adapt them to a context with one scoped rule.

- **Shared structural classes, one job each:**
  - `.content`: a padded column with a gap. It is the modal body and the table's row-details panel.
  - `.button-bar`: a joined row of controls. Where a bar can get long, draw it as `ButtonBar` (`buttonBar.js`) instead of `<div class="button-bar">`: with three or more children it moves the later ones to a second line rather than overflow (never a third line), so templates stay as they are. The shared table header (`ContentHeaderComponent`) already uses it.
  - `.card`: a small labelled block or button.
  - `.details-grid` with `.detail-item`: labelled values.
  - `.cell-button-list`: stacked, full-width buttons in one cell.
- **A context adapts a shared class with one parent-scoped rule.** Examples: `.details-container > .content` (the panel look), `.calendar-chip .card`, `td .card, .detail-item > span .card`. Don't add a new class or a wrapper that repeats what a shared class already does.
- **No layout-only wrappers.** A component renders into its container's layout. A modal component's root nodes go straight into the modal's `.content`, which gives the column and gap. Several root nodes need `inheritAttrs: false`.
- **One size scale per context, defined once.** A context with its own sizes sets custom properties on its root, and every child reads them. For example, `.calendar-chip` sets `--chip-control-height` and `--chip-font`.
- **Fix the generic rule you're fighting, not the element.** Before adding an override, find the generic rule that causes the conflict, such as `.button-bar .button-symbol` (28px minimum) or `.button-bar button:not(.button-symbol)` (grows). Scope one context rule above it, instead of patching single elements.
- **Values in the same role look the same.** Cards beside a value share one compact card rule, whether the value is in a table cell or a detail item.

## Local development

- **Local server.** The VS Code Live Server extension serves the app at `http://127.0.0.1:5500/docs/#`. No Node or Python server runs.
- **Fake data on localhost.** The database layer switches to the fake Google services (`google_sheets_services/FakeGoogle.js`) automatically. Real Google Sheets data needs the deployed site.
- **Keep the fake in step.** Any change to the Google Sheets services, or to the sheets and preferences the app relies on, must also be made in `FakeGoogle.js`.

## Tests

- **Where they run.** On localhost, only on command: run `fakeGoogle.runTests()` in the browser console (`docs/js/tests/fakeGoogleDevTools.js`). A page load never runs them.
  - Results appear in the console, grouped, with ✓/✗ per test and a summary line. The command also returns `{ passed, failed }`.
  - Tests call `Requests.*` against the FakeGoogle data, with no mocks and no framework. They run against pristine fixtures, and local data is restored afterwards. They never run in production.
- **Run what you changed, then everything.** `fakeGoogle.runTests('find scopes')` or `fakeGoogle.runTests(['dashboard', 'user data'])` runs only the groups whose name contains the text.
  - Groups in one section can depend on the groups before them. For example, PERSISTED RESULTS needs SHORTAGE ALERTS, so run them together: `['shortage', 'persisted', 'rollover']`.
  - Run the whole suite before committing.
- **The suite owns the app while it runs.** It signs in, and its AUTH tests sign out, so sign in again afterwards. It holds the app's scheduled cache polls (`holdScheduledPolls`, `caching.js`); a test that needs a poll calls `triggerCachePoll()`.
- **When to add tests:**
  - Add a test group for every new cross-layer feature, such as a new analysis type or a new pack list operation.
  - Add a regression test for any bug whose cause spans more than one file.
- **What a test asserts.** Each test asserts a specific expected value derived from the FakeGoogle data, never just "returns something".
- **Fixture data.** When a feature needs data relationships FakeGoogle lacks, add the data to `FakeGoogle.js` alongside its tests. Document the expected values in a comment at the top of the test group.
- **Sheet health is test-only.** `docs/js/tests/sheetHealth.js` runs last in the suite and never loads on the live site.

## Working in this repo

- **Others edit the working tree while you work.** Never use `git stash`, `checkout` or `reset` on the tree. When committing, stage only your own changes. Use `git show <rev>:<path>` or a separate worktree to look at old versions.
