# EditHistory System Implementation Documentation

**Date:** November 6, 2025  
**Implementation Phase:** Phase 1 - Core Infrastructure (Complete)

## Overview

The EditHistory system has been implemented to track row changes, store modification history, and archive deleted rows across all spreadsheet tables. This system operates transparently at the Database layer, requiring no changes to UI components.

---

## Architecture

### Implementation Level: Database Layer (Recommended Option 1)

The implementation follows the recommended Database Layer approach, providing:

- **Single point of control** - All saves flow through Database.setData()
- **Automatic tracking** - Works for all tables without code changes
- **Transparent operation** - Upper layers unaware of edithistory tracking
- **Consistent format** - Uniform edithistory structure across all data types

---

## Components Implemented

### 1. EditHistory Utilities (`data_management/utils/edithistory-utils.js`)

Core utility class providing edithistory operations:

**Key Methods:**

- `createEditHistoryEntry(username, changes)` - Creates new edithistory entry
- `appendToEditHistory(existingEditHistory, newEntry, maxHistory)` - Appends to history
- `calculateRowDiff(oldRow, newRow, ignoredColumns)` - Detects changes
- `calculateBatchDiff(originalRows, updatedRows)` - Batch change detection
- `detectDeletedRows(originalRows, updatedRows, identifierKey)` - Finds deleted rows
- `createArchiveEntry(...)` - Prepares row for archival
- `parseEditHistory(edithistory)` - Parses edithistory from various formats
- `setCachedAnalytic(edithistory, key, value)` - Stores cached analytics
- `setUserSetting(edithistory, key, value)` - Stores user settings

### 2. Enhanced Database Layer (`abstraction/database.js`)

**Database.setData() Enhancements:**

- Accepts `options` parameter with:
  - `username` - User making the change
  - `skipMetadata` - Skip edithistory generation (for special tables)
  - `identifierKey` - Key for row identification (e.g., 'itemNumber')
- Automatically fetches original data for comparison
- Calculates diffs and appends to edithistory column
- Detects and archives deleted rows to EditHistory table
- Graceful fallback if edithistory operations fail

**Database.updateRow() Enhancements:**

- Accepts `options` parameter with username
- Calculates single-row diff
- Appends edithistory for changed fields

**Private Helper Methods:**

- `_addMetadataToRows(originalRows, updatedRows, username, mapping)` - Adds edithistory to changed rows
- `_archiveDeletedRows(sourceTable, sourceTab, deletedRows, username)` - Archives to EditHistory table

### 3. Updated Abstraction Layer

**InventoryUtils.saveInventoryTabData():**

- Accepts `username` parameter
- Passes username to Database.setData() with `identifierKey: 'itemNumber'`
- Passes username to Database.updateRow() for filtered saves

**PackListUtils.savePackList():**

- Accepts `username` parameter
- Currently skips edithistory (pack lists use special 2D array format)
- Tagged with comment for future enhancement

**ApplicationUtils.storeUserData():**

- Passes `skipMetadata: true` option (user data doesn't need tracking)

### 4. Updated API Layer (`data_management/api.js`)

**Changes:**

- Imports `authState` from auth utility
- Extracts username: `authState.user?.email || null`
- Passes username to abstraction layer methods:
  - `saveInventoryTabData()` - Passes username to InventoryUtils
  - `savePackList()` - Passes username to PackListUtils

---

## Data Structures

### EditHistory Column Format

Stored as JSON string in the `EditHistory` column of each table (minimized format):

```json
{
  "h": [
    {
      "u": "dan",
      "t": "2025-11-06T15:30:00Z",
      "c": [
        { "n": "quantity", "o": "5" },
        { "n": "notes", "o": "" }
      ]
    },
    {
      "u": "jane",
      "t": 17309064000,
      "c": [{ "n": "quantity", "o": "3" }]
    }
  ],
  "a": {
    "lastInventoryCheck": "2025-11-06T15:30:00Z",
    "alertsAcknowledged": ["low-quantity-2025-11-05"]
  },
  "s": {
    "starred": true,
    "color": "yellow"
  }
}
```

**Key Mapping (Single Letters for Minimal Size):**

- `h` = history (array of change entries)
- `u` = user (username before @ symbol, e.g., "dan" not "dan@example.com")
- `t` = timestamp (decisecond integer - divide by 10 for seconds, multiply by 100 for milliseconds)
- `c` = changes (array of changed fields)
- `n` = column name
- `o` = old value (new value not stored - can be inferred from current data)
- `a` = cachedAnalytics (optional)
- `s` = userSettings (optional)

**Timestamp Format:**
Decisecond integers (1/10th second precision) reduce size by 54% vs ISO strings:

- ISO string: `"2025-11-05T10:15:00Z"` (24 chars)
- Deciseconds: `17309064000` (11 chars)
- Convert to Date: `new Date(timestamp * 100)` or `EditHistoryUtils.decisecondToDate(timestamp)`
- Convert to ISO: `EditHistoryUtils.formatTimestamp(timestamp)`
- Human readable: `EditHistoryUtils.formatTimestampHuman(timestamp)`

**Design Rationale:**

- **Single-letter keys**: Reduces JSON size by ~40%
- **Username truncation**: Stores only "dan" instead of "dan@example.com"
- **Decisecond timestamps**: 54% smaller than ISO strings, sufficient precision
- **Old values only**: New values are the current values, so no need to store twice
- **Most recent first**: Index 0 is always the latest change

**Backwards Compatibility:**
The system automatically migrates old format keys (`history`, `user`, etc.) to new format when reading.

### EditHistory Table Structure

Dedicated tab in each spreadsheet storing deleted rows:

| Column        | Description                   | Example                                     |
| ------------- | ----------------------------- | ------------------------------------------- |
| SourceTable   | Table identifier              | "INVENTORY"                                 |
| SourceTab     | Tab name                      | "FURNITURE"                                 |
| RowIdentifier | Row ID                        | "F-123"                                     |
| Username      | User who deleted (full email) | "dan@example.com"                           |
| Timestamp     | Deletion time (deciseconds)   | 17309064000                                 |
| Operation     | Action type                   | "delete"                                    |
| RowData       | Full row as JSON              | {"itemNumber":"F-123", "quantity":"5", ...} |

**Note:** EditHistory table uses decisecond integers for Timestamp. Convert with `EditHistoryUtils.decisecondToDate(timestamp)`.

---

## How It Works

### Save Flow with EditHistory

1. **User Initiates Save** (e.g., clicks Save in InventoryTable)
2. **ReactiveStore.save()** strips AppData and target columns
3. **API.saveInventoryTabData()** gets username from authState
4. **InventoryUtils.saveInventoryTabData()** passes username with options
5. **Database.setData()** receives username and identifierKey
6. **Database Fetches Original Data** from Google Sheets for comparison
7. **Calculate Diffs** using EditHistoryUtils.calculateRowDiff()
8. **Append Metadata** to changed rows using EditHistoryUtils.appendToEditHistory()
9. **Detect Deletions** using EditHistoryUtils.detectDeletedRows()
10. **Archive Deleted Rows** to EditHistory table
11. **Save Updated Data** to Google Sheets (includes edithistory column)
12. **Invalidate Cache** triggers reactive store reload

### Example: Inventory Item Update

**Original Data:**

```javascript
{
  itemNumber: "F-123",
  quantity: "5",
  description: "Blue table",
  notes: "In good condition",
  edithistory: ""
}
```

**User Changes quantity to "10" and notes to "Ready for show"**

**Saved Data:**

```javascript
{
  itemNumber: "F-123",
  quantity: "10",
  description: "Blue table",
  notes: "Ready for show",
  edithistory: '{"h":[{"u":"dan","t":17309064000,"c":[{"n":"quantity","o":"5"},{"n":"notes","o":"In good condition"}]}]}'
}
```

**Note:** Only old values are stored. Current values are already in the data columns. Username is shortened to just "dan" instead of "dan@example.com". Timestamp is decisecond integer (17309064000 = ~Nov 6, 2025).

### Example: Row Deletion

**Before (3 rows):**

```javascript
[
  { itemNumber: "F-123", quantity: "5", ... },
  { itemNumber: "F-124", quantity: "3", ... },
  { itemNumber: "F-125", quantity: "8", ... }
]
```

**After (2 rows - F-124 deleted):**

```javascript
[
  { itemNumber: "F-123", quantity: "5", ... },
  { itemNumber: "F-125", quantity: "8", ... }
]
```

**EditHistory Table Entry Created:**

```javascript
{
  SourceTable: "INVENTORY",
  SourceTab: "FURNITURE",
  RowIdentifier: "F-124",
  Username: "dan@example.com",
  Timestamp: 17309064000,
  Operation: "delete",
  RowData: '{"itemNumber":"F-124","quantity":"3",...}'
}
```

**Note:** EditHistory table stores full username (not truncated) and uses decisecond integer timestamps.

---

## Configuration

### Inventory Tables

- ✅ **Enabled** - Full edithistory tracking
- Mapping includes: `edithistory: 'EditHistory'`
- Identifier key: `'itemNumber'`

### Pack Lists

- ⚠️ **Partially Disabled** - Uses special 2D array format
- Currently skips edithistory with `skipMetadata: true`
- Future enhancement: Convert to mapped format

### Production Schedule

- 🔄 **Future** - Not yet implemented
- Will follow inventory pattern

### Cache/User Data

- ❌ **Disabled** - User preferences don't need change tracking
- Passes `skipMetadata: true`

---

## Usage Examples

### Basic Save (Automatic)

```javascript
// No changes needed - edithistory is automatic!
await Requests.saveInventoryTabData(updatedData, "FURNITURE");
// Metadata is automatically added based on authState.user.email
```

### Retrieve Metadata History

```javascript
import { EditHistoryUtils } from "./data_management/index.js";

// Get item data
const items = await Requests.getInventoryTabData("FURNITURE");
const item = items[0];

// Parse edithistory
const edithistory = EditHistoryUtils.parseEditHistory(item.edithistory);
console.log("Change history:", edithistory.h); // Note: 'h' not 'history'

// Get most recent change
const lastChange = EditHistoryUtils.getMostRecentChange(item.edithistory);
console.log("Last modified by:", lastChange.u); // Short username
console.log("Last modified at:", lastChange.t);
console.log("Fields changed:", lastChange.c); // Array of {n: name, o: oldValue}
```

### Store Cached Analytics

```javascript
import { EditHistoryUtils } from "./data_management/index.js";

// Update cached analytic
item.edithistory = EditHistoryUtils.setCachedAnalytic(
  item.edithistory,
  "lastInventoryCheck",
  new Date().toISOString()
);

// Retrieve cached value
const lastCheck = EditHistoryUtils.getCachedAnalytic(
  item.edithistory,
  "lastInventoryCheck"
);
```

### Store User Settings

```javascript
import { EditHistoryUtils } from "./data_management/index.js";

// Mark item as starred
item.edithistory = EditHistoryUtils.setUserSetting(
  item.edithistory,
  "starred",
  true
);

// Get starred status
const isStarred = EditHistoryUtils.getUserSetting(item.edithistory, "starred");
```

---

## Testing Locally

The system works with FakeGoogle.js for local development:

1. **Start LiveServer** - Runs at `http://127.0.0.1:5500/docs/`
2. **FakeGoogle automatically selected** - Based on localhost detection
3. **Test username** - `'test@example.com'` from FakeGoogleSheetsAuth
4. **Metadata operations work** - All utilities function the same

---

## Future Enhancements (Not Yet Implemented)

### Phase 2: UI Integration

- [ ] History viewer component
- [ ] Restore deleted row functionality
- [ ] Change indicators in tables
- [ ] User badges showing who last modified

### Phase 3: Pack List Metadata

- [ ] Convert pack lists to mapped format
- [ ] Enable edithistory for crate info
- [ ] Track item-level changes within crates

### Phase 4: Production Schedule

- [ ] Add edithistory tracking to schedule
- [ ] Track show date changes
- [ ] Track assignment changes

### Phase 5: Advanced Features

- [ ] Rollback/undo functionality
- [ ] Conflict resolution for concurrent edits
- [ ] Metadata search/filter
- [ ] Export change reports
- [ ] Retention policies (archive old edithistory)

---

## Known Limitations

1. **Pack Lists** - Currently skip edithistory due to special 2D array format
2. **Nested Arrays** - Items within crates not individually tracked (yet)
3. **Performance** - Each save fetches original data for comparison (could optimize with caching)
4. **Storage** - No automatic cleanup of old edithistory (manual maintenance needed)
5. **Sheet Limits** - Google Sheets has 10M cell limit; monitor EditHistory table growth

---

## Error Handling

The system is designed to **never block saves** even if edithistory fails:

```javascript
try {
    // Add edithistory tracking
    updatesWithMetadata = await this._addMetadataToRows(...);
} catch (error) {
    console.warn('Failed to add edithistory, continuing with save:', error);
    // Continue with save even if edithistory fails
}
```

**Graceful Degradation:**

- Metadata parsing errors → Returns empty edithistory
- Archive failures → Logs error but doesn't throw
- Missing username → Records as 'unknown'
- Missing identifier → Uses positional tracking

---

## Maintenance

### Viewing EditHistory Table

Each spreadsheet now has (or will have) a **EditHistory** tab:

1. Open spreadsheet (INVENTORY, PACK_LISTS, PROD_SCHED)
2. Look for "EditHistory" tab
3. View deleted rows with full history

### Manually Creating EditHistory Tab

If the tab doesn't exist, it will be created automatically on first deletion. To create manually:

1. Add new tab named "EditHistory"
2. Add headers: `SourceTable`, `SourceTab`, `RowIdentifier`, `Username`, `Timestamp`, `Operation`, `RowData`

### Cleaning Up Old Metadata

To prevent edithistory from growing indefinitely:

**Option 1: Reduce maxHistory**

```javascript
// In edithistory-utils.js, change default
static appendToEditHistory(existingEditHistory, newEntry, maxHistory = 5) {
```

**Option 2: Manual Cleanup Script**

```javascript
// Clear edithistory older than 90 days
const cutoffDate = new Date();
cutoffDate.setDate(cutoffDate.getDate() - 90);

items.forEach((item) => {
  const edithistory = EditHistoryUtils.parseEditHistory(item.edithistory);
  if (edithistory && edithistory.history) {
    edithistory.history = edithistory.history.filter(
      (entry) => new Date(entry.timestamp) > cutoffDate
    );
    item.edithistory = JSON.stringify(edithistory);
  }
});
```

---

## Summary

✅ **Phase 1 Complete** - Core edithistory infrastructure implemented

- EditHistory column tracking change history
- EditHistory table archiving deleted rows
- Username attribution from authState
- Transparent operation at Database layer
- Extensible format for future features

**Next Steps:**

- Monitor system in production
- Gather feedback from users
- Plan Phase 2 UI features
- Extend to Pack Lists and Production Schedule

---

## Questions & Support

For questions about the edithistory system:

1. Review this documentation
2. Check `edithistory-utils.js` for utility methods
3. Examine `database.js` for implementation details
4. Test locally with FakeGoogle.js
5. Refer to copilot-instructions.md for architecture patterns
