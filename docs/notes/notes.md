## NOTES

?
whenever possible, rely on the caching system instead of data from live tables.
Google oAuth2 for client-only apps requires a token refresh every hour, no exceptions
Google drive rate-limits queries, making it difficult to realtime-check tons of stuff -> this impacts the ability to open multiple tabs at once
We can potentially save Dropbox service account keys in google drive and use them to access our dropbox files without user auth. This risks key exposure.

Inventory Handling:
Standard: FURNITURE, CABINETS, HANGING SIGNS, COUNTERTOPS, SHELVES, LIGHTBOXES, LIGHTING
Special logic to support finding items: HARDWARE
In standard descriptions: Power strips? Cables? Keyboards and mice? Remotes? Antennas?
Consolidated tracked: BEAMATRIX PANELS & HARDWARE
Extra tracking: ELECTRONICS, MONITORS
Will come in uninventoried: Client or new items shown in booth, Decorative Items
Rules: Typical Client Items, Tools and Supplies, Tech Accessories
?: Monitor arms? Remotes and power strips?

Need features:

- add new rows at end of packlist (client items, tools, etc)
- add a row following an item for typical inclusions (carpet + pad, monitor + cabling, etc)
- consolidate, but still track items (beMatrix panels and hardware)
- track unique items (electronics with serial numbers, passwords, locations)

For design and project queue:

- checklists for each item? Define checklists for items somehow? Checklists with username requirements? User table? Checklists with linked data entry fields?
- show what pdfs are exported for each project
- nebulus project stages, base on current system: projects are requested, updated, communicated via email. Put all information in one place, but allow tags and filters? Or force update notes to be connected to a category or checklist?
- if certain documents exist, they are assumed correct - force approvals? Assume approvals for certain types of projects? Allow document approvals to be revoked? Approvals are just checklists?
- checklists need to have the ability to link to styles in schedule views. We have advanced search, maybe add "Advanced Views" that allows custom columns, column styling based on rules, etc? Should this be hardcoded?
- allow calendar view of shows. Allow drag and drop scheduling for show dates and ship/ret date thresholds? Maybe the interface should allow "card view", "table view", and "calendar view" for things? Hard code, or option for user?
- Notifications system? Integrate emails? Allow checkbox or defaults for recipients? Default text? Allow templates? Should the system allow changes via email replies?

## Primary Use Cases

- [50%] We can have pack lists generated from Inventor
- [95%] We can know if there are item shortages as pack lists are generated
- [80%] If we add bematrix stuff to pack lists, we can also check inventory qty of them
- [ 0%] If we auto generate packlists from concept models, we can get an early alert of possible inventory issues as those shows are approved
- [ 0%] We can get an inventory report of item quantities throughout the year
- [ 0%] We can migrate all our checklists and schedule management to this system
- [10%] All of our data is available and easy to update on the go

## TO DO

**chores**

      make the calls to user data automatically cancel and show a screen alert if the user hasnt given permissions.

- [x] Inject the sheet ids and the api-key via github soas not to expose them
- [x] remove hamburger buttons that do nothing
- [x] packlist print titleblock??
- [x] add context variables to live site github
- [x] refresh buttons should clear caches
- [x] fix packlist table header alignment
- [x] simplify and impliment more url filling and parameter saving in nav and back buttons (for instance breadcrumb nav should cache some url params)
- [x] tableComponent finder needs: a clear all button
- [ ] make table headers accessible when scrolling
- [ ] reports column headers percentage based and dynamically abbreviate
- [ ] basic schedule table needs to have return and show date columns visible
- [ ] basic schedule table needs to allow wide table
- [ ] packlist interface somehow show "was previously" during edits

**problems**

- [ ] autosave backup is currently broken, probably because of failure to identify user tab or backup entries correctly
- [ ] some group dragging breaks the group
- [ ] packlist print from dashboard will not print correctly if not on packlist page first
- [ ] redundancy and overcomplexity in navigation still must be reduced
- [x] canceled due to newer identical call shouldn't cancel but should pass the promise around to avoid failed analysis
- [ ] fix duplication of bematrix VELCRO PANELS
- [ ] fix 45 degree curved panels
- [x] navigation is not clearing prompt variable when the user selects logout or clicks out of the modal
- [x] make navigation auth modal logout on cancel
- [ ] fix thumbnails again: make the analysis step invalidation ignore repeat invalidations: analysis invalidation reruns need to have a delay timer built in that gets pushed out, and cancelled if main data invalidates, and don't listen for analysis invalidation during main data load
- [?] error causing unsyncing of packlist saves, especially when data or rows are deleted
- [x] clicking primary nav in desktop view should always nav to base page instead of doing so only every other click
- [x] buttons dont work on reports
- [x] changing url doesnt immidiately update saved search
- [x] container path update in packlistTable accidentally redirects the dashboard to the path as well. Fix this by making the edit endpoint not be a path location, but be a table mode instead.
- [x] error causing early dashboard changes to be overwritten by an empty dashboard
- [x] error causing card component to lose analytics details on reload after cache clear???
- [x] ensure log out/in does not break things: the pin button currently breaks on reauth (was test data missing email on reauth...)
- [x] error causing logout to not clean up all data and cause errors on reauth (username set to "User" instead of actual username)
- [x] New or empty packlists have the wrong headers: fix hardcoded templating and row showing errors
- [x] scrolling issue when navigating
- [t] error causing imperfect or corrupted analytics information on data refresh after auth
- [x] github deployment needs to be rerun every time due to config.js build issues? (need to set up deployment via actions in github settings)
- [x] waiting too long before reauthentication breaks requests and components get locked up in loading state with incorrect or empty reactiveStore data

**Application tasks**

dropbox or workzone integrations

- [ ] dropbox service account and auth sync
- [ ] identify and show versions/dates of output files
- [ ] allow opening link to dropbox pdfs
- [ ] migrate thumbnails to dropbox and allow uploading new thumbnails to dropbox???

inventory updates

- [x] include all current categories
- [x] Improve inventory item finding: match actual bematrix hardware to inventory bematrix item numbers
- [x] allow editing of item quantities
- [x] allow editing of item descriptions
- [x] allow adding new items
- [x] add existing item thumbnails
- [ ] track crate information to further streamline pack list generation
- [x] make thumbnails be a cached analytics step
- [ ] add all FURNITURE
- [ ] update LIGHTBOXES
- [ ] add all LIGHTING
      optimize thumbnail finding: cached call that gets thumbnail folder contents once
      allow uploading new item thumbnails
      allow assigning and tracking items with unique ids. ex: cradlepoint routers with individual serial numbers, passwords, and location info attached in inventory and tracked separately
      item status interface to locate items and update item status

Architecture Improvements

- [x] dashboard configuration
- [x] user preferences storage
- [x] ReactiveStore periodically save data to spreadsheet, and check + load data from spreadsheet to prevent data loss on accidental tab close or crash. Notify user "recovered unsaved changes..."
- [x] extra spreadsheet EditHistory column
- [x] save history: dateTime, userName, fields edited & old values
- [x] reactiveStore efficiency: stack, prioritize, and batch api calls from reactiveStores to ensure application data is available first without hitting rate limits
- [x] log out needs to skip database operations if the token is already expired
- [ ] improve error handling and user notifications for failed auth and failed permissions
- [x] locking and edit rules to prevent simultaneous edits: 'is editing' flag for packlists and inventories that locks other users out.
- [?] impliment edithistory for packlists (complete for inventory, not complete for multilayer packlist data)
- [ ] save deleted information in a special table for recovery if necessary
- [ ] Provide tools to revert changes from history
- [ ] allow autocaching of analytics data
      consider always checking the edithistory last-edited date before saving to prevent overwriting simultaneous changes?
      allow unused reactiveStores to self-clean to save memory after a period of inactivity
      remove cache timeout for database access and allow these caches to work as offline functionality, saving in longterm storage and pushing if necessary when reconnected

HIGH PRIORITY: Export Basic Pack List from Inventor

- [x] Create new pack list in Google Sheets
- [x] Input items into Google Sheets
- [x] Open existing pack list and cross-reference before adding new parts, only adding parts that are not already present
- [x] make sure panel and hardware part numbers come in correctly
- [x] when consolidating HARDWARE if the vendor literally is "HARDWARE" don't set the part number to that
- [ ] !!! fix system that checks for diff and allows updates to existing packlist instead of full overwrite
- [ ] allow pack list export from project manager
- [ ] change the packlist export to export all items correctly
- [ ] fix CABINET item numbers in inventor
- [ ] fix FURNITURE item numbers in inventor
- [ ] fix HANGING SIGN item numbers in inventor
- [ ] verify panel and hardware and other possible edge-cases
- [ ] Improve and test this system
      Categorize all booth parts according to Pack List Rules (preferences)

Pack Lists in Web

- [x] Get pack list data from web and display
- [x] Allow addition of new crates
- [x] Allow crate contents edit
- [x] Allow addition of new items
- [x] Allow deletion of items
- [x] Allow moving items
- [x] Allow editing item contents
- [x] allow saving edits to google sheet
- [x] allow packlist main page to be refreshed (cards-grid refresh button)
- [x] new items from inventory with easy navigation
- [x] allow packlist text search and filtering
- [x] Allow packlist item categorization and hiding, ex: select a whole set of hardware and categorize as "BeMatrix Hardware", then move that set to hidden row as a list.
- [x] Allow categorized item finding, viewing (in row details), checking (integrate into analysis steps), and check/update (via inventor).
- [x] Allow new packlists from template
- [x] Allow duplicate packlists from existing packlists (add to main packlist page, and as an action on a packlist)
- [x] add category filtering to packlist-details table
- [ ] !!! cut and paste between packlist functionality
- [ ] !!! automations interface, packlist rules
- [ ] allow user to configure automations
- [ ] automatic packlist rule suggestion jobs run in the background?
- [ ] description change recommendations for common or similar items that checks or aggregates history potentially?
- [ ] automations automatically allow for quick addition of typical client or show items
      create a more advanced filtering component for tables that includes multi-select, ranges, and text search and integrates with urlparams similar to the advanced search select
      allow adding items to inventory through packlist via simple interface (use item as description, extract quantity if exists, user choose category, auto add and save)

show management system

- [ ] we may need a workzone integration
- [x] link shows to pack lists
- [x] advanced search and preset system
- [x] default schedule ship date as analytics step
- [ ] advanced search needs to filter columns available to search types by data type. Data types need to be more strictly defined in the show data system
- [ ] advanced search should allow user to filter based on type: by date, text-match, show overlap (special type), and boolean flags (future)
- [ ] text-match needs to have a dropdown to determine type of match (includes, excludes, etc.)
- [ ] date search needs to have a dropdown to determine type of match (before, after, before inclusive, after inclusive, etc.)
- [ ] allow text field omission in advanced search (ex: return results that do not have a certain client name, or location, etc)
- [ ] !!! add "views" system to show different columns and layouts for different purposes
- [ ] allow sorting, categorization (viewable/hidden in certain domains), and organization of saved searches
      create and edit shows
      express checklist columns as checkboxes
      allow user to access show searches as pages and pin to dashboard
      analyze and show the rough number and complexity of shows throughout the year
      calendar view of shows

notifications system

- [ ] allow notifications throughout application to be picked up by components
- [ ] basic notification center on dashboard
      Provide a feedback mechanism for users to suggest improvements or report issues

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

analysis of pack list against current inventory

- [x] quantities
- [x] overlapping shows
- [x] low stock warnings
- [x] description updates
- [x] using inventory/reports endpoint, and loading the saved searches into the table, build a report table
- [x] make url param updates correctly propegate into components, and fix report url generation
- [x] allow report text filtering
      increase the filtering options in reports
      link to quick reports from other locations (ex: advanced-search, or from inventory for upcoming shows, or from packlist details, etc)

**maybe**
change style system so that color variables are set via classes on components, and those variables set the "--color-\*" variables per component instead of globally.
quick action buttons on cards?
allow analysis to intelligently slow or pause itself and notify user for slow connection states.
implement notes and checklists
workspace system with multiple dashboards?
allow modals to receive the arrow keys and enter button
create backup of packlists before saving packlist to ensure no data loss
find missing show or client index info and allow user to add it
user preferences (allow delay save)
