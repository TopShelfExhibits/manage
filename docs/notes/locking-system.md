# Locking System

## Purpose

Prevent concurrent editing conflicts by locking spreadsheet tabs when users modify data.

## Data Storage

**Location**: `CACHE` spreadsheet → `Locks` tab

**Schema**:
| Column | Description |
|--------|-------------|
| Spreadsheet | Spreadsheet name (e.g., `PACK_LISTS`, `INVENTORY`) |
| Tab | Tab name (e.g., `ATSC 2025 NAB`, `ELECTRONICS`) |
| User | User email who owns the lock |
| Timestamp | ISO 8601 timestamp when lock was acquired |

## API Functions

### Core Lock Operations

- `Requests.lockSheet(spreadsheet, tab, user)` - Acquire lock (mutation, no cache)
- `Requests.unlockSheet(spreadsheet, tab, user)` - Release lock (mutation, no cache)
- `Requests.getSheetLock(spreadsheet, tab)` - Get lock details (query, no cache)

### Specialized Functions

- `Requests.getPacklistLock(tabName)` - Get pack list lock (calls `getSheetLock('PACK_LISTS', tabName)`)
- `Requests.getInventoryLock(tabName)` - Get inventory lock (calls `getSheetLock('INVENTORY', tabName)`)

**All lock methods excluded from caching to ensure real-time status.**

## Implementation Pattern

### Table Components (Edit Views)

**Data Properties**:

- `isLocked` - This component owns the lock
- `lockedByOther` - Locked by another user
- `lockOwner` - Email of lock owner
- `lockCheckComplete` - Initial check finished
- `lockingInProgress` - Prevent concurrent lock operations

**Helper Method** (eliminates code duplication):

```javascript
setLockState(isLocked, owner = null) {
    this.isLocked = isLocked;
    this.lockedByOther = owner && owner !== authState.user?.email;
    this.lockOwner = owner;
}
```

**Lifecycle**:

1. `mounted()` → `checkLockStatus()` - Two-step check:
   - **Step 1**: Check immediately for locks by other users (no wait for store)
   - **Step 2**: If locked by current user, wait for store load to check for stale locks
2. Watch `isDirty` → `handleLockState(isDirty)` - Auto lock/unlock
   - `isDirty=true` → Acquire lock
   - `isDirty=false` → Release lock
   - Only executes if `lockCheckComplete` and not `lockedByOther`
3. Watch `store.error` → Detect lock conflicts during save
4. If locked by another user, prevent edit mode entry

**Lock Check Optimization** (Jan 2026):

- **Immediate check**: Query lock status for other users without waiting for data load
  - Sets `lockedByOther` and `lockCheckComplete` immediately
  - Edit button disabled instantly if another user has lock
- **Deferred stale check**: Only wait for store load when checking current user's stale locks
  - Requires `isDirty` to be accurate (needs loaded data)
  - Removes stale locks automatically (lock held but data clean)

**UI Integration**:

- Disable "Edit" button until `lockCheckComplete` OR `lockedByOther`
- Show "Locked by <username>" when `lockedByOther`
- Extract username: `email.includes('@') ? email.split('@')[0] : email`

### Cards Grid (List Views)

**Analysis Configuration**:

```javascript
createAnalysisConfig(
  Requests.getPacklistLock, // or getInventoryLock
  "lockInfo",
  "Checking lock status...",
  ["title"],
  [],
  "lockInfo",
);
```

**Card Formatting**:

- Check `tab.lockInfo !== null` to determine lock status
- Card color priority: **locked (white) > unsaved (red) > normal (gray/purple)**
- Footer: `"Locked for edit by: <username>"` if locked

## Lock Behavior

### Acquisition

- **Success**: User edits → table becomes dirty → lock acquired automatically
- **Failure**: Another user has lock → show error, prevent editing
- Lock updates timestamp if same user re-locks

### Release

- **Auto**: Table saved → becomes clean → lock released automatically
- **Manual**: User clicks "Discard Changes" or navigates away while dirty
- Only lock owner can release their lock

### Conflict Resolution

- Lock checks are real-time (no caching)
- If edit mode entered while locked by another → auto-navigate to view mode
- Failed lock acquisition shows who owns the lock

## Example Usage

### Pack Lists

- **Cards**: Show lock status on all pack lists
- **Table**: Lock acquired when editing, released on save

### Inventory

- **Cards**: Show lock status on category cards
- **Table**: Lock acquired when editing category, released on save

## Key Standards

1. **Always call specialized lock functions** (`getPacklistLock`, `getInventoryLock`) in analysis configs
2. **Extract usernames** from emails for display (`email.split('@')[0]`)
3. **No caching** for any lock operations
4. **Auto-manage locks** via dirty state watchers, not manual calls
5. **White cards** indicate locked items in cards grids
6. **Use `setLockState` helper** to update lock properties (eliminates duplication)
7. **Minimal logging**: Keep only critical errors/warnings, avoid verbose state dumps
8. **Two-step lock checks**: Immediate check for other users, deferred check for stale locks

## Code Cleanup (Jan 2026)

### Optimizations Applied

1. **Extracted `setLockState` helper** - Eliminates 10+ duplicate lock state assignments
2. **Reduced logging by ~70%** - Removed verbose state dumps and redundant logs
3. **Simplified watchers** - Removed excessive conditional logging
4. **Used `console.warn`** for actual warnings instead of `console.log`
5. **Removed obvious comments** - Code is self-explanatory
6. **Removed `checkAndAcquireLock`** from InventoryTable - Logic inlined to `handleCellEdit`

### Results

- **~180 lines removed** across PacklistTable and InventoryTable
- **Console noise reduced 70%** (39 → 12 log statements)
- **Consistent patterns** across both components
- **Maintained all critical functionality** while improving maintainability
