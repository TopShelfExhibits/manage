Dig into the logic that sets editHistory and that sets pending changes for inventory items. We need a table feature that allows editHistory to be shown alongside pending changes in the same way. This should be togglable with a new 'history' toggle button next to the view switcher. Show these rows as

Does this correctly distinguish between the google popup showing at odd times during silent refresh, and the application modal that is shown to alert the user that auth is expiring?
Intended functionality: The google popup (automatic when attempting silent refresh) should not show when the app is hidden. The user prompt should show whenever auth is going to expire even when the document is inactive so that the user can log back in if silent refresh failed in the background or was suppressed. If it is helpful, maybe we should keep the document activate listener so that if the document was truly fully inactive and not running any code when auth expired, the auth check runs and shows the user prompt if auth is expired.

I am having some trouble with authentication. The current code is messy and mixed, and the authentication system needs to be

## TopShelf Live Inventory Notes

Deployment Notes

- Allow and request email feedback from users
- Bundle changes into updates, carefully log changes made, and send out a release email before making the updates
- Make sure any changes to user data or database structure are backwards compatible or allow users to migrate on first use

System Notes

- whenever possible, rely on the caching system instead of data from live tables.
- Google drive rate-limits queries, making it difficult to realtime-check tons of stuff -> this impacts the ability to open multiple tabs at once
- We must always query the inventory by date for analytics, but we must never pass the date into a reactiveStore save or load call. This causes auto-save mismatch, etc.

## Usage

Intended Use Cases:

- We can have pack lists generated from Inventor
- We can know if there are item shortages as pack lists are generated
- If we add bematrix stuff to pack lists, we can also check inventory qty of them
  x If we auto generate packlists from concept models, we can get an early alert of possible inventory issues as those shows are approved (needs approval system)
- We can get an inventory report of item quantities throughout the year
- All of our data is available and easy to update on the go
- We can migrate all our checklists and schedule management to this system

Current Usage:

- software being used for inventory... slowly. Ben is updating the inventory a bit at a time.
- being used to identify shortages when doublechecking packlist info.
- being used to verify packlists by going to the packlist tab and cross-referencing data with his manual packlist

Ongoing User Conversations:

- there is a lot of data that does not get on our packlist, mostly consumables and client stuff.
  Example of lightbox additions:
  lightbox
  backliner for
  base plates
  lb graphic
  tv supports
  box buildout for tv
- Nomenclature (!!!TALK ABOUT THIS SOON!!!)
  TTOP/TBASE/TV/AV numbering
  SHLF vs SHELF, CNTR vs COUNTER, CAB vs CABINET, etc
- automation rules (MAYBE NOT RIGHT NOW... per conversation w ben)
  Rules: Typical Client Items, Tools and Supplies, Tech Accessories
  auto add new rows at end of packlist (client items, tools, etc)
  add a row following an item for typical inclusions (carpet + pad, monitor + cabling, etc)
- Crating from Ben:
  add and configure default crate types??? but ben often goes back and changes multiple times! (Maybe not now)
  coffin crate 10' pile in, (sometimes furniture?)
  some things have designated crates, some more than one config of crate and are split out on occasion, or split out when less than crate is sent
  often if sending one, we will send on a skid
- doubles, As and Bs, and variant tracking
  should we keep them as separate items knowing they won't inventory check? Or should we consolidate them and just track overall quantity?
  A variant tracking system would allow for better tracking (NOT NOW per conversation w ben)
  (electronics with serial numbers, passwords, locations)
- Inventory Handling:
  Standard: FURNITURE, CABINETS, HANGING SIGNS, COUNTERTOPS, SHELVES, LIGHTBOXES, LIGHTING
  Special logic to support finding items: HARDWARE
  !!! In standard descriptions: Power strips? Cables? Keyboards and mice? Remotes? Antennas?
  Consolidated tracked: BEAMATRIX PANELS & HARDWARE
  (?) Extra tracking: ELECTRONICS, MONITORS
  (?) Monitor arms? Remotes and power strips?
  Will come in uninventoried: Client or new items shown in booth, Decorative Items

## TO DO

**chores**

- [ ] fix cards-grid sort by in small views: small headers cause the text to be truncated because the label is too long to view in this context. Either icons, or narrow text without "sort by" prefix"
- [ ] we need to unify api functions to reduce the number of thin wrappers, create generic passthrough functions and use in reactiveStores
- [ ] move complex api logic into the most relevant abstraction area, leaving the api as clean as possible so it can be turned into a real api eventually.
- [ ] **design better display tools** for details areas
- [ ] build user customization interface for views that allows easy moving, stacking, showing, widening, etc.
- [x] basic schedule table needs to have return and show date columns visible
- [ ] test no internet mode
- [ ] I have not tested what happens if two users simultaniously trigger inventory upcoming change resolution
      reports column headers percentage based and dynamically abbreviate
      unify the styling of cards and buttons
      change style system so that color variables are set via classes on components, and those variables set the "--color-\*" variables per component instead of globally.
      clickable and highlightable (can copy contents) table cells instead of cell buttons
      allow modals to receive the arrow keys and enter button

**problems**

- [x] inventory tabs still lose dirty state during the process of making modifications which is disorienting.
- [ ] **Search needs to stay in a logical way**, not on every navigation. Maybe give search boxes "findId"s that allow syncing/clearing of search across nav
- [ ] AUTH def still automatically auths and needs to be revamped. We need to remove the auto auth and ensure the "expired" modal always shows
- [x] some odd thumbnail behavior...... mostly not loading in right away
- [ ] dashboard slows down css animations, implying too many listeners
- [ ] ! in mobile view some things don't show well because it's narrow (arrows, button sizes for transshipments) ideally we would have icon substitutions or narrow text when necessary on a case by case basis, or automaticaly based on a hierarchy if a button bar overflows.
- [ ] some sticky headers too high on mobile after page switch, dashboard nav issue
- [ ] thumbnails are still slow on chromium. Sometimes takes a second to start loading, and a full inventory page can take a while to load thumbs for.
- [ ] autosave backup is currently broken, probably because of failure to identify user tab or backup entries correctly
- [ ] packlist print from dashboard will not print correctly if not on packlist page first because navigation doesn't complete before the print command locks the interface
- [ ] it's possible for multiple api requests to be reporting progress simultaniously and do odd things to api progress tracking. We need some way to tie the bar to one message channel.
- [ ] some clicks doubleclick (opening sched details for the first time, some other things that I can't remember) this might be a latency issue, or a click handling issue, or a click action swap timing issue
- [ ] opening details pane and other clicks can reset scrolltop?
- [ ] refreshing packlists leaves undo history in odd state.
- [ ] things like CNTR-008l and CNTR-008r don't get inventoried correctly, because only the unified "CNTR-008" exists in inventory. Do we need a "sub-parts" system?

**Application tasks**

inventory updates

- [ ] add "substitutions" system to allow automatically recommended substitutions during shortage calculation (useful for multiple types of L-plates or cabinetry)
- [x] **run configured upcoming inventory shortage report automatically** on main inventory page and show warnings in items and categories (InventoryShortageAlertDays preference; see caching-tab-structure.md)
- [ ] We should add dimension columns where appropriate to inventory tables, and allow concatenation of columns for description pulls.
- [ ] do we need an inventory filter version of the advanced filter? Augmentation of the category filter?
- [?] ensure inventory table generation is unified so changes propegate throughout components and reports correctly
- [ ] add all FURNITURE, LIGHTING, Puck hardware
      allow attaching a change dates to a project??? for instance, if we are selling a chair to a client, or if a chair broke at a show, or we are aquiring a chair for a show
      item status interface to locate items and update item status
      We could integrate a repair schedule and other things into this system for a complete inventory management system
      allow assigning and tracking items with unique ids. ex: cradlepoint routers with individual serial numbers, passwords, and location info attached in inventory and tracked separately
      track crate information to further streamline pack list generation (Crate UI similar to packlists? Allow Ben to manage crates, and analysis search/suggest typical crates when editing a packlist?)

Architecture Improvements

- [x] !!! better "Find..." tools for nonfiltered searching with up/down navigation and a "selected" found item index, probably just a numberbox attached to the find box and some javascript to autoset this by nearest match or something, and url searchterm updating perhaps
- [x] save deleted information in a special table for recovery if necessary
- [ ] **make dashboard more usable**: single screen page layout, allow sub-scrolling, configurable button areas, mobile dashboard auto-swap with buttons instead
- [ ] dashboard option to add special container that allows navigation and starts with a global nav menu
- [ ] hide/show alerts area (show alerts in nav when hidden?) instead of default banner, and move floating alert button into navigation bar next to dot menu OR next to hamburger menu on mobile?
- [x] !!! history and last edit viewing tools: Provide tools to revert changes from history (steal from inventory upcoming changes ui), and tools to revert based on source,history modification utility for viewing changes over time and changing their values if necessary?
- [ ] !!! history tools for packlist tables
- [ ] Do we need an inventory specific future changes update utility?
- [ ] ShowNotes edithistory seems unused, and showNotes are deleted when cleared. What should we be doing here? Is this an ephemeral field? Should we have a table entirely for ephemeral checklist fields?
- [ ] ! test and validate offline mode
- [ ] charts?
- [x] **allow auto-caching of analytics data.** Mark some caches to be dumped to tables with their expiry data. Allow table checks when loading app and load from table if it exists to skip recompute. (wrapMethods persistentMethods → CACHE/Analytics)
- [ ] Create some metric to track how often a certain cache is used and how often it refreshes, and if it is used often and refreshes less than once per hour, dump to a table with expiry data.
      allow analysis to intelligently slow or pause itself and notify user for slow connection states.
      improve dashboard endpoints to allow multiple cards with different view parameters?

show management system

- [ ] !!!!! **run configured upcoming inventory shortage report automatically** on schedule page and show warnings in items and categories: This needs to not explode computers. May need analysis caching first.
- [x] !!!! add "views" system to show different columns and layouts for different purposes
- [x] !!! design queue and updating logic <- views system to support this as a schedule view
- [ ] !! alert me about projects that don't yet have files attached to them
- [x] advanced search add and configure boolean flag columns (shown as checkboxes) and filter option
- [ ] calendar view improvements: allow views showing ship/return, maybe allow schedule overlays on other pages for context
- [ ] alerts for new construction?
      add workzone info to table???
      allow sorting, categorization (viewable/hidden in certain domains), and organization of saved searches
      allow user to access show searches as pages and pin to dashboard
      analyze and show the rough number and complexity of shows throughout the year and provide work estimate reporting

Pack Lists in Web

- [ ] !!! packlist item approval checklist and packlist edit vs. item-approval mode (Add item to existing or new crate, remove, group, etc)
- [ ] !!! Item Action Bubble Improvements: add "add to new crate", "move to existing crate", "move rows"
- [ ] !!! improve viewing and editing and alert configuration based on current use-case
- [ ] ! enable actions bubbles for crates selections
- [ ] ! automations interface, packlist rules: allow user to configure automations, automatic packlist rule suggestion jobs run in the background (Ex: description change recommendations for common or similar items that checks or aggregates history, allow for quick addition of typical client or show items)
- [ ] store and display source and viewing data, allow clearing (approve incoming changes) for cad additions/changes?
- [ ] support for "concept packlist" that has a partial packlist with some things already filled in, but clearly labeled as concept model export
- [ ] consider extracting nested tables into a nestedTable component to simplify the tablecomponent, and make it packlist specific?
      show icons for all items in the packlist
      create a more advanced filtering component for tables that includes multi-select, ranges, and text search and integrates with urlparams similar to the advanced search select
      allow adding items to inventory through packlist via simple interface (use item as description, extract quantity if exists, user choose category, auto add and save)

dropbox / workzone / sql integrations

      allow opening link to dropbox or workzone pdfs
      identify and show versions/dates of output files
      microsoft server or google workspace integration?
      dropbox service account and auth sync

checklist, reports, and notes system

      create and edit checklists
      template checklists
      complete checklists
      link checklists to products
      allow template checklist linking to product areas: packlists, inventories, shows
      allow template checklists to be applied based on triggers
      allow logical checklist creation from data (ex: packlist items checklist)
      integrate with notifications
      integrate with automations
