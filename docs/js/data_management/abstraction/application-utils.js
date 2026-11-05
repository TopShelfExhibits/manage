import { Database, wrapMethods, invalidateCache, stampDataChange, normalizeHeaderName } from '../index.js';
import { setTimestampWriter, setPersistentStore, startCacheTimestampPoller, startCacheCleanup } from '../utils/caching.js';
import { networkState } from '../utils/networkState.js';

// Dynamically import GoogleSheetsAuth based on environment
import { isLocalhost, todayISOString, startOfTodayMs } from '../utils/helpers.js';
let GoogleSheetsAuth, GoogleSheetsService;
if (isLocalhost()) {
    ({ GoogleSheetsAuth, GoogleSheetsService } = await import('../../google_sheets_services/FakeGoogle.js'));
} else {
    ({ GoogleSheetsAuth } = await import('../../google_sheets_services/GoogleSheetsAuth.js'));
    ({ GoogleSheetsService } = await import('../../google_sheets_services/GoogleSheetsData.js'));
}

// User data writes per tab name: { entries: the batch still collecting calls (null once it is
// written), done: the latest batch's write } (storeUserData)
const _userDataQueues = new Map();

function isActiveLockTimestamp(timestamp) {
    const ts = timestamp?.split('|')[0];
    return !!(ts && ts !== '0');
}

function toLockTimestampMs(timestamp) {
    const ts = (timestamp || '').split('|')[0];
    const ms = new Date(ts).getTime();
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function getOldestActiveLock(locks, spreadsheet, tab) {
    const candidates = (locks || []).filter(lock =>
        lock.spreadsheet === spreadsheet &&
        lock.tab === tab &&
        isActiveLockTimestamp(lock.timestamp)
    );

    if (!candidates.length) return null;

    return candidates.reduce((oldest, current) => {
        return toLockTimestampMs(current.timestamp) < toLockTimestampMs(oldest.timestamp)
            ? current
            : oldest;
    });
}

/**
 * Utility functions for application-specific operations
 */
class applicationUtils_uncached {
    // Create default saved searches
    static DEFAULT_SEARCHES = [
        {
            name: 'Upcoming',
            dateFilters: [
                { column: 'Date', value: 0, type: 'after' }//,  // Today
                // { column: 'Date', value: 60, type: 'before' } // 60 days in the future
            ],
            textFilters: []
        }
    ];
    
    /**
     * Store user data in a user-specific tab within the CACHE sheet. Calls made at the same moment
     * (autosave backs up every dirty store at once) are written together: one read and one write
     * of the tab. Writes to one tab never overlap, so none undoes another.
     * @param {string} username - The username to create/find a tab for
     * @param {string} id - The ID to find/create a row for
     * @param {*} data - Data to store in the row (strings as they are, the rest as JSON); null deletes the row
     * @returns {Promise<boolean|undefined>} Success status of the tab's write
     */
    static storeUserData(username, id, data) {
        // Sanitize username and compose tab name consistently with getUserData
        const tabName = `UserData_${username.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        let queue = _userDataQueues.get(tabName);
        if (!queue) _userDataQueues.set(tabName, queue = { entries: null, done: Promise.resolve() });
        if (!queue.entries) {
            // A new batch: it collects calls until the tab's previous write is done, plus one turn
            const entries = queue.entries = [];
            queue.done = queue.done
                .catch(() => {})
                .then(() => new Promise(resolve => setTimeout(resolve, 0)))
                .then(() => {
                    queue.entries = null;
                    return applicationUtils_uncached._writeUserData(tabName, entries);
                });
        }
        queue.entries.push({ id, data });
        return queue.done;
    }

    /**
     * One read-modify-write of a user data tab, applying entries in call order.
     * @private
     * @param {string} tabName
     * @param {Array<{id: string, data: *}>} entries - data null deletes the row
     */
    static async _writeUserData(tabName, entries) {
        const isEmpty = (data) => data === null ||
            (Array.isArray(data) && data.length === 0) ||
            (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0);

        // Only create the tab for real data
        const allTabs = await Database.getTabs('CACHE');
        if (!allTabs.some(t => t.title === tabName)) {
            entries = entries.filter(entry => !isEmpty(entry.data));
            if (!entries.length) return;
            await Database.createTab('CACHE', '_UserDataTemplate', tabName, { bookkeeping: true });
        }

        // Copies: the cached rows stay as they are if the write fails
        const rows = (await Database.getData('CACHE', tabName, { ID: 'ID', Value: 'Value' })).map(row => ({ ...row }));
        for (const { id, data } of entries) {
            const rowIndex = rows.findIndex(row => row.ID === id);
            if (data === null) {
                if (rowIndex !== -1) rows.splice(rowIndex, 1);
                continue;
            }
            const value = typeof data === 'string' ? data : JSON.stringify(data);
            if (rowIndex !== -1) rows[rowIndex].Value = value;
            else rows.push({ ID: id, Value: value });
        }

        return await Database.setData('CACHE', tabName, rows, { ID: 'ID', Value: 'Value' }, {
            skipMetadata: true,
            bookkeeping: true
        });
    }
    
    /**
     * Check if a user data key or key prefix exists
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} username - The username to find the tab for
     * @param {string} keyOrPrefix - The exact key or prefix to check for
     * @param {boolean} prefixMatch - If true, checks for keys starting with keyOrPrefix; if false, checks for exact match
     * @returns {Promise<boolean>} True if key/prefix exists, false otherwise
     */
    static async hasUserDataKey(deps, username, keyOrPrefix, prefixMatch = false) {
        const sanitizedUsername = username.replace(/[^a-zA-Z0-9_-]/g, '_');
        const tabName = `UserData_${sanitizedUsername}`;
        
        // Check if tab exists
        const userTab = await deps.call(Database.findTabByName, 'CACHE', tabName);
        if (!userTab) {
            return false; // Tab doesn't exist
        }
        
        // Get tab data as JS objects
        const tabData = await deps.call(Database.getData, 'CACHE', tabName, { ID: 'ID', Value: 'Value' });
        if (!tabData || tabData.length === 0) {
            return false; // No data in tab
        }
        
        // Check for exact match or prefix match
        if (prefixMatch) {
            return tabData.some(obj => obj.ID && obj.ID.startsWith(keyOrPrefix));
        } else {
            return tabData.some(obj => obj.ID === keyOrPrefix);
        }
    }
    
    /**
     * Retrieve user data from a user-specific tab within the CACHE sheet
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} username - The username to find the tab for
     * @param {string} id - The ID to find the row for
     * @returns {Promise<Array|null>} Array of data from the row, or null if not found
     */
    static async getUserData(deps, username, id) {
        const sanitizedUsername = username.replace(/[^a-zA-Z0-9_-]/g, '_');
        const tabName = `UserData_${sanitizedUsername}`;
        // Check if tab exists
        const userTab = await deps.call(Database.findTabByName, 'CACHE', tabName);
        if (!userTab) {
            // Tab doesn't exist - if requesting saved_searches, initialize with defaults
            if (id === 'saved_searches') {
                await applicationUtils_uncached.storeUserData(username, 'saved_searches', applicationUtils_uncached.DEFAULT_SEARCHES);
                return applicationUtils_uncached.DEFAULT_SEARCHES;
            }
            return null; // Tab doesn't exist, no data stored yet
        }
        // Get tab data as JS objects
        const tabData = await deps.call(Database.getData, 'CACHE', tabName, { ID: 'ID', Value: 'Value' });
        if (!tabData || tabData.length === 0) {
            // No data in tab - if requesting saved_searches, initialize with defaults
            if (id === 'saved_searches') {
                await applicationUtils_uncached.storeUserData(username, 'saved_searches', applicationUtils_uncached.DEFAULT_SEARCHES);
                return applicationUtils_uncached.DEFAULT_SEARCHES;
            }
            return null; // No data in tab
        }
        // Find object with the ID
        const foundObj = tabData.find(obj => obj.ID === id);
        if (!foundObj) {
            // ID not found - if requesting saved_searches, initialize with defaults
            if (id === 'saved_searches') {
                await applicationUtils_uncached.storeUserData(username, 'saved_searches', applicationUtils_uncached.DEFAULT_SEARCHES);
                return applicationUtils_uncached.DEFAULT_SEARCHES;
            }
            return null; // ID not found
        }
        
        // Parse the stored value if it's a JSON string, otherwise return as-is
        let parsedValue;
        try {
            parsedValue = JSON.parse(foundObj.Value);
        } catch (error) {
            // If parsing fails, return the raw string value
            parsedValue = foundObj.Value;
        }
        
        // If requesting saved_searches and result is empty array, initialize with defaults
        if (id === 'saved_searches' && Array.isArray(parsedValue) && parsedValue.length === 0) {
            await applicationUtils_uncached.storeUserData(username, 'saved_searches', applicationUtils_uncached.DEFAULT_SEARCHES);
            return applicationUtils_uncached.DEFAULT_SEARCHES;
        }
        
        return parsedValue;
    }

    /**
     * Retrieve the most recent user data entry whose ID starts with a prefix.
     * Useful when store key signatures change but backups should still be recoverable.
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} username - The username to retrieve data for
     * @param {string} keyPrefix - Prefix to match against ID column
     * @returns {{id: string, value: *}|null} Matching entry metadata, or null
     */
    static async getUserDataByPrefix(deps, username, keyPrefix) {
        const sanitizedUsername = username.replace(/[^a-zA-Z0-9_-]/g, '_');
        const tabName = `UserData_${sanitizedUsername}`;

        const userTab = await deps.call(Database.findTabByName, 'CACHE', tabName);
        if (!userTab) return null;

        const tabData = await deps.call(Database.getData, 'CACHE', tabName, { ID: 'ID', Value: 'Value' });
        if (!tabData || tabData.length === 0) return null;

        const matches = tabData.filter(obj => obj.ID && obj.ID.startsWith(keyPrefix));
        if (matches.length === 0) return null;

        // Choose newest by embedded timestamp when present, otherwise keep first.
        let newestMatch = null;
        let newestTimestamp = -Infinity;

        for (const match of matches) {
            let parsedValue;
            try {
                parsedValue = JSON.parse(match.Value);
            } catch (error) {
                parsedValue = match.Value;
            }

            const ts = parsedValue && parsedValue.timestamp
                ? new Date(parsedValue.timestamp).getTime()
                : Number.NaN;
            const comparableTs = Number.isFinite(ts) ? ts : -Infinity;

            if (newestMatch === null || comparableTs > newestTimestamp) {
                newestMatch = {
                    id: match.ID,
                    value: parsedValue
                };
                newestTimestamp = comparableTs;
            }
        }

        return newestMatch;
    }
    
    /**
     * Lock a spreadsheet tab for a user (single cell write)
     * @param {string} spreadsheet - The spreadsheet name (e.g., 'INVENTORY', 'PACK_LISTS')
     * @param {string} tab - The tab name
     * @param {string} user - The user email claiming the lock
     * @returns {Promise<boolean>} Success status
     */
    static async lockSheet(spreadsheet, tab, user, deviceId = null) {
        try {
            //console.log(`[lockSheet] START: ${spreadsheet}/${tab} for ${user}`);
            const timestamp = new Date().toISOString();
            const lockKey = `${spreadsheet}:${tab}`;
            
            // Get current locks data
            //console.log(`[lockSheet] Getting locks data...`);
            const locksGrid = await ApplicationUtils.getLocksData();
            //console.log(`[lockSheet] Got locks data:`, locksGrid);
            
            // Resolve the effective lock: oldest active timestamp wins.
            const existingLock = getOldestActiveLock(locksGrid.locks, spreadsheet, tab);
            
            if (existingLock && existingLock.user !== user) {
                console.warn(`Sheet ${spreadsheet}/${tab} is locked by ${existingLock.user}`);
                return false;
            }
            
            // Find or create lock key row
            let lockRowIndex = locksGrid.lockKeys.indexOf(lockKey);
            //console.log(`[lockSheet] lockRowIndex = ${lockRowIndex}, lockKeys =`, locksGrid.lockKeys);
            if (lockRowIndex === -1) {
                // Add new lock key to the grid
                lockRowIndex = locksGrid.lockKeys.length;
                locksGrid.lockKeys.push(lockKey);
                //console.log(`[lockSheet] Adding new lock key at row ${lockRowIndex + 2}`);
                await this._writeLockKeyRow(lockKey, lockRowIndex + 2); // +2 for header row
                //console.log(`[lockSheet] Lock key row written successfully`);
            }
            
            // Find or create user column
            let userColIndex = locksGrid.users.indexOf(user);
            //console.log(`[lockSheet] userColIndex = ${userColIndex}, users =`, locksGrid.users);
            if (userColIndex === -1) {
                // Add new user column
                userColIndex = locksGrid.users.length;
                locksGrid.users.push(user);
                //console.log(`[lockSheet] Adding new user at col ${userColIndex + 2}`);
                await this._writeUserColumn(user, userColIndex + 2); // +2 for "Lock Key" column (B=2)
                //console.log(`[lockSheet] User column written successfully`);
            }
            
            // Write timestamp (with optional deviceId) to the specific cell (single cell write)
            const cellRow = lockRowIndex + 2; // +2 for header row (1-indexed)
            const cellCol = userColIndex + 2; // +2 for Lock Key column (1-indexed)
            const cellValue = deviceId ? `${timestamp}|${deviceId}` : timestamp;
            //console.log(`[lockSheet] Writing timestamp to R${cellRow}C${cellCol}`);
            await this._writeLockCell(cellRow, cellCol, cellValue);
            //console.log(`[lockSheet] Timestamp written successfully`);
            
            // Invalidate getSheetLock cache so UI components see the new lock
            stampDataChange('app_utils:getLocksData');
            invalidateCache([
                { namespace: 'app_utils', methodName: 'getLocksData', args: [] }
            ]);
            //console.log(`[lockSheet] Locked ${lockKey} for ${user} at cell R${cellRow}C${cellCol}`);
            return true;
            
        } catch (error) {
            console.error('[lockSheet] Error:', error);
            throw error;
        }
    }
    
    /**
     * Unlock a spreadsheet tab (single cell write)
     * @param {string} spreadsheet - The spreadsheet name
     * @param {string} tab - The tab name
     * @param {string} user - The user email releasing the lock
     * @returns {Promise<boolean>} Success status
     */
    static async unlockSheet(spreadsheet, tab, user) {
        try {
            //console.log(`[unlockSheet] START: ${spreadsheet}/${tab} for ${user}`);
            const lockKey = `${spreadsheet}:${tab}`;
            
            // Get current locks data
            //console.log(`[unlockSheet] Getting locks data...`);
            const locksGrid = await ApplicationUtils.getLocksData();
            //console.log(`[unlockSheet] Got locks data:`, locksGrid);
            
            // Find lock key row
            const lockRowIndex = locksGrid.lockKeys.indexOf(lockKey);
            //console.log(`[unlockSheet] lockRowIndex = ${lockRowIndex}`);
            if (lockRowIndex === -1) {
                // Lock key not in grid, no lock to remove
                //console.log(`[unlockSheet] Lock key not in grid, returning true`);
                return true;
            }
            
            // Find user column
            const userColIndex = locksGrid.users.indexOf(user);
            //console.log(`[unlockSheet] userColIndex = ${userColIndex}`);
            if (userColIndex === -1) {
                // User not in grid, no lock to remove
                //console.log(`[unlockSheet] User not in grid, returning true`);
                return true;
            }
            
            // Check if this user owns the lock
            const lock = locksGrid.locks.find(lock => 
                lock.spreadsheet === spreadsheet && lock.tab === tab && lock.user === user
            );
            //console.log(`[unlockSheet] Found lock:`, lock);
            
            if (!lock || !lock.timestamp) {
                // No lock exists for this user
                //console.log(`[unlockSheet] No lock exists for this user, returning true`);
                return true;
            }
            
            // Write "0" to the specific cell to unlock (single cell write)
            const cellRow = lockRowIndex + 2; // +2 for header row
            const cellCol = userColIndex + 2; // +2 for Lock Key column
            //console.log(`[unlockSheet] Writing "0" to R${cellRow}C${cellCol}`);
            await this._writeLockCell(cellRow, cellCol, '0');
            //console.log(`[unlockSheet] Unlock written successfully`);
            
            // Invalidate getSheetLock cache so UI components see the lock is gone
            // Must invalidate all possible argument combinations since cache includes optional currentUser
            stampDataChange('app_utils:getLocksData');
            invalidateCache([
                { namespace: 'app_utils', methodName: 'getLocksData', args: [] }
            ]);
            //console.log(`[unlockSheet] Unlocked ${lockKey} for ${user} at cell R${cellRow}C${cellCol}`);
            return true;
            
        } catch (error) {
            console.error('[unlockSheet] Error:', error);
            throw error;
        }
    }
    
    /**
     * Get lock details for a spreadsheet tab
     * @param {Object} deps - Dependency decorator for tracking calls (injected by wrapMethods)
     * @param {string} spreadsheet - The spreadsheet name
     * @param {string} tab - The tab name
     * @param {string} [currentUser] - Optional current user email to filter out their own locks
     * @returns {Promise<Object|null>} Lock details or null if not locked
     */
    static async getSheetLock(deps, spreadsheet, tab, currentUser = null) {
        const locksGrid = await deps.call(ApplicationUtils.getLocksData);
        //console.log(`[ApplicationUtils.getSheetLock] Found ${locksGrid.locks.length} total locks`);

        // When multiple active locks exist, only the oldest timestamp is authoritative.
        const matchedLock = getOldestActiveLock(locksGrid.locks, spreadsheet, tab);
        
        // Filter out if locked by current user
        if (matchedLock && currentUser && matchedLock.user === currentUser) {
            //console.log(`[ApplicationUtils.getSheetLock] Lock owned by current user (${currentUser}), returning null`);
            return null;
        }
        
        // Return lock details if found
        if (matchedLock) {
            //console.log(`[ApplicationUtils.getSheetLock] Lock found for ${spreadsheet}/${tab}:`, matchedLock);
            return matchedLock;
        }
        
        //console.log(`[ApplicationUtils.getSheetLock] No lock found for ${spreadsheet}/${tab}`);
        return null;
    }
    /**
     * Force unlock a spreadsheet tab (admin override)
     * This bypasses user validation and backs up any autosaved data before removing it
     * 
     * @param {string} spreadsheet - The spreadsheet name (e.g., 'INVENTORY', 'PACK_LISTS')
     * @param {string} tab - The tab name (e.g., 'FURNITURE', 'ATSC 2025 NAB')
     * @param {string} reason - Optional reason for force unlock (for logging/audit)
     * @returns {Promise<Object>} Result object { success, backupCount, deletedCount, lockOwner, message }
     */
    static async forceUnlockSheet(spreadsheet, tab, reason = '') {
        //console.log(`[ApplicationUtils.forceUnlockSheet] Force unlocking ${spreadsheet}/${tab}. Reason: ${reason}`);
        
        try {
            const lockKey = `${spreadsheet}:${tab}`;
            
            // Get lock info first to identify the owner
            const locksGrid = await ApplicationUtils.getLocksData();
            
            const lockInfo = getOldestActiveLock(locksGrid.locks, spreadsheet, tab);
            
            if (!lockInfo) {
                return {
                    success: false,
                    backupCount: 0,
                    deletedCount: 0,
                    lockOwner: null,
                    message: 'No lock found to remove'
                };
            }
            
            const lockOwner = lockInfo.user;
            //console.log(`[ApplicationUtils.forceUnlockSheet] Found lock owned by: ${lockOwner}`);
            
            // Get the owner's username from email
            const username = lockOwner.includes('@') ? lockOwner.split('@')[0] : lockOwner;
            const sanitizedUsername = username.replace(/[^a-zA-Z0-9_-]/g, '_');
            const tabName = `UserData_${sanitizedUsername}`;
            
            let backupCount = 0;
            let deletedCount = 0;
            
            // Check if user data tab exists
            const allTabs = await Database.getTabs('CACHE');
            const userTab = allTabs.find(t => t.title === tabName);
            
            if (userTab) {
                // Get all autosave entries for this user
                const allUserData = await Database.getData('CACHE', tabName, {
                    Store: 'Store',
                    Data: 'Data',
                    Timestamp: 'Timestamp'
                });
                
                //console.log(`[ApplicationUtils.forceUnlockSheet] Found ${allUserData.length} total autosave entries for user ${username}`);
                
                // Find matching autosave entries for this tab
                // Store keys are generated like: '["getInventoryTabData",["FURNITURE",null,null]]'
                // We need to match the tab name in the store key
                const tabStoreKey = JSON.stringify(tab);
                const matchingEntries = allUserData.filter(entry => {
                    return entry.Store && entry.Store.includes(tabStoreKey);
                });
                
                //console.log(`[ApplicationUtils.forceUnlockSheet] Found ${matchingEntries.length} autosave entries for tab ${tab}`);
                
                if (matchingEntries.length > 0) {
                    // Create backup entries and mark originals for deletion
                    const timestamp = Date.now();
                    const modifiedUserData = [...allUserData];
                    
                    for (const entry of matchingEntries) {
                        // Create backup entry with OVERRIDDEN prefix
                        const backupEntry = {
                            Store: `OVERRIDDEN_${timestamp}?${entry.Store}`,
                            Data: entry.Data,
                            Timestamp: entry.Timestamp
                        };
                        modifiedUserData.push(backupEntry);
                        backupCount++;
                        
                        // Remove original entry
                        const originalIndex = modifiedUserData.findIndex(e => 
                            e.Store === entry.Store && e.Timestamp === entry.Timestamp
                        );
                        if (originalIndex !== -1) {
                            modifiedUserData.splice(originalIndex, 1);
                            deletedCount++;
                        }
                    }
                    
                    // Save modified user data
                    await Database.setData('CACHE', tabName, modifiedUserData, {
                        Store: 'Store',
                        Data: 'Data',
                        Timestamp: 'Timestamp'
                    }, { skipMetadata: true, bookkeeping: true });
                    
                    //console.log(`[ApplicationUtils.forceUnlockSheet] Backed up ${backupCount} entries, deleted ${deletedCount} entries`);
                }
            } else {
                //console.log(`[ApplicationUtils.forceUnlockSheet] No user data tab found for ${username} - no autosave entries to backup`);
            }
            
            // Remove the lock (without user validation) - single cell write
            const lockRowIndex = locksGrid.lockKeys.indexOf(lockKey);
            const userColIndex = locksGrid.users.indexOf(lockOwner);
            //console.log(`[forceUnlockSheet] lockRowIndex = ${lockRowIndex}, userColIndex = ${userColIndex}`);
            
            if (lockRowIndex !== -1 && userColIndex !== -1) {
                const cellRow = lockRowIndex + 2; // +2 for header row
                const cellCol = userColIndex + 2; // +2 for Lock Key column
                //console.log(`[forceUnlockSheet] Writing "0" to R${cellRow}C${cellCol}`);
                await this._writeLockCell(cellRow, cellCol, '0');
                //console.log(`[forceUnlockSheet] Cleared lock at R${cellRow}C${cellCol}`);
            } else {
                //console.log(`[forceUnlockSheet] Could not find lock key or user in grid, skipping cell write`);
            }
            
            // Invalidate getSheetLock cache so UI components see the lock is gone
            stampDataChange('app_utils:getLocksData');
            invalidateCache([
                { namespace: 'app_utils', methodName: 'getLocksData', args: [] }
            ]);
            
            // Invalidate database cache for this tab to refresh application data
            invalidateCache([
                { namespace: 'database', methodName: 'getData', args: [spreadsheet, tab] }
            ], true);
            
            //console.log(`[ApplicationUtils.forceUnlockSheet] Lock removed successfully`);
            
            return {
                success: true,
                backupCount,
                deletedCount,
                lockOwner,
                message: `Successfully force unlocked ${spreadsheet}/${tab}`
            };
            
        } catch (error) {
            console.error('[ApplicationUtils.forceUnlockSheet] Error during force unlock:', error);
            throw error;
        }
    }
    
    /**
     * Release all locks for a user (clears entire row)
     * @param {string} user - The user email
     * @returns {Promise<boolean>} Success status
     */
    static async releaseAllUserLocks(user) {
        try {
            const locksGrid = await ApplicationUtils.getLocksData();
            
            // Find user column
            const userColIndex = locksGrid.users.indexOf(user);
            if (userColIndex === -1) {
                // User not in grid, no locks to remove
                return true;
            }
            
            // Clear all locks for this user (write "0" to all cells in their column)
            const cellCol = userColIndex + 2; // +2 for Lock Key column
            const locksForUser = locksGrid.locks.filter(lock => lock.user === user && lock.timestamp && lock.timestamp !== '0');
            
            for (const lock of locksForUser) {
                const lockKey = `${lock.spreadsheet}:${lock.tab}`;
                const lockRowIndex = locksGrid.lockKeys.indexOf(lockKey);
                if (lockRowIndex !== -1) {
                    const cellRow = lockRowIndex + 2; // +2 for header row
                    await this._writeLockCell(cellRow, cellCol, '0');
                }
            }
            
            // Invalidate cache
            stampDataChange('app_utils:getLocksData');
            invalidateCache([
                { namespace: 'app_utils', methodName: 'getLocksData', args: [] }
            ]);
            
            //console.log(`[releaseAllUserLocks] Released all locks for ${user}`);
            return true;
            
        } catch (error) {
            console.error('[releaseAllUserLocks] Error:', error);
            throw error;
        }
    }
    
    
    /**
     * Write a single user to the column header
     * @private
     * @param {string} user - User email
     * @param {number} col - Column number (1-indexed, B=2, C=3, etc.)
     * @returns {Promise<void>}
     */
    static async _writeUserColumn(user, col) {
        const colLetter = this._numberToColumnLetter(col);
        const range = `Locks!${colLetter}1:${colLetter}1`;
        await GoogleSheetsService.setSheetData('CACHE', range, [[user]], null);
        //console.log(`[_writeUserColumn] Added user ${user} at ${range}`);
    }
    
    /**
     * Write a single lock key to the row (column A)
     * @private
     * @param {string} lockKey - Lock key (e.g., "PACK_LISTS:LOCKHEED MARTIN 2026 SNA")
     * @param {number} row - Row number (1-indexed)
     * @returns {Promise<void>}
     */
    static async _writeLockKeyRow(lockKey, row) {
        const range = `Locks!A${row}:A${row}`;
        await GoogleSheetsService.setSheetData('CACHE', range, [[lockKey]], null);
        //console.log(`[_writeLockKeyRow] Added lock key ${lockKey} at ${range}`);
    }
    
    /**
     * Write a single lock cell value (timestamp or "0")
     * @private
     * @param {number} row - Row number (1-indexed)
     * @param {number} col - Column number (1-indexed)
     * @param {string} value - Timestamp or "0"
     * @returns {Promise<void>}
     */
    static async _writeLockCell(row, col, value) {
        const colLetter = this._numberToColumnLetter(col);
        const range = `Locks!${colLetter}${row}:${colLetter}${row}`;
        await GoogleSheetsService.setSheetData('CACHE', range, [[value]], null);
        //console.log(`[_writeLockCell] Set ${range} to ${value}`);
    }
    
    /**
     * Convert column number to letter (1=A, 2=B, 26=Z, 27=AA, etc.)
     * @private
     * @param {number} num - Column number (1-indexed)
     * @returns {string} Column letter(s)
     */
    static _numberToColumnLetter(num) {
        let letter = '';
        while (num > 0) {
            const remainder = (num - 1) % 26;
            letter = String.fromCharCode(65 + remainder) + letter;
            num = Math.floor((num - 1) / 26);
        }
        return letter;
    }
    
    /**
     * Initialize the Locks sheet with proper 2D grid structure
     * @private
     * @returns {Promise<void>}
     */
    static async _initializeLocksSheet() {
        try {
            //console.log('[_initializeLocksSheet] Initializing Locks sheet structure');
            const sheetData = [
                ['Lock Key'] // A1: "Lock Key" header, columns B+ will be added dynamically
            ];
            await GoogleSheetsService.setSheetData('CACHE', 'Locks', sheetData, null);
            //console.log('[_initializeLocksSheet] Locks sheet initialized successfully');
        } catch (error) {
            console.error('[_initializeLocksSheet] Failed to initialize Locks sheet:', error);
            throw error;
        }
    }

    /**
     * Get locks data in 2D grid format with 20-second cache
     * @param {Object} deps - Dependency decorator for tracking calls (injected by wrapMethods)
     * @returns {Promise<Object>} Object with { users: [], lockKeys: [], locks: [] }
     */
    static async getLocksData(deps) {
        try {
            // Read entire Locks sheet
            const rawData = await GoogleSheetsService.getSheetData('CACHE', 'Locks');
            
            //console.log('[getLocksData] Raw data from Locks sheet:', rawData);
            
            if (!rawData || rawData.length === 0) {
                //console.log('[getLocksData] No data found, returning empty grid');
                return { users: [], lockKeys: [], locks: [] };
            }
            
            // First row contains headers: ["Database", "user1@example.com", "user2@example.com", ...]
            // Normalize headers to handle embedded carriage returns
            const headers = Array.isArray(rawData[0])
                ? rawData[0].map(h => normalizeHeaderName(h))
                : [];
            const lockKeys = [];
            const users = headers.slice(1); // Skip "Database" column
            const locks = [];
            
            // Process lock key rows (starting from row 2, index 1)
            for (let i = 1; i < rawData.length; i++) {
                const row = rawData[i];
                if (!row || row.length === 0) continue;
                
                const lockKey = row[0];
                if (!lockKey || lockKey.trim() === '') continue;
                
                lockKeys.push(lockKey);
                
                // Parse lockKey format: "SPREADSHEET:TAB"
                const [spreadsheet, ...tabParts] = lockKey.split(':');
                const tab = tabParts.join(':'); // Handle tabs with colons in name
                
                // Process each user column for this lock key
                for (let j = 1; j < row.length; j++) {
                    const cellValue = row[j] || '';
                    const [timestamp, deviceId] = cellValue.split('|');
                    const userEmail = users[j - 1]; // -1 because users is sliced
                    
                    if (!userEmail) continue;
                    
                    // Store lock info (even if timestamp is "0" or empty)
                    locks.push({
                        user: userEmail,
                        spreadsheet: spreadsheet,
                        tab: tab,
                        timestamp: timestamp || null,
                        deviceId: deviceId || null
                    });
                }
            }
            
            //console.log(`[getLocksData] Found ${users.length} users, ${lockKeys.length} lock keys, ${locks.length} lock entries`);
            return { users, lockKeys, locks };
            
        } catch (error) {
            console.error('[getLocksData] Error reading locks:', error);
            
            // If this is a 400 error (Bad Request), the sheet likely doesn't exist
            if (error.status === 400 || error.message?.includes('Unable to parse range')) {
                console.warn('[getLocksData] Locks sheet appears to be missing or corrupted, initializing...');
                try {
                    await this._initializeLocksSheet();
                    return { users: [], lockKeys: [], locks: [] };
                } catch (initError) {
                    console.error('[getLocksData] Failed to initialize Locks sheet:', initError);
                }
            }
            
            return { users: [], lockKeys: [], locks: [] };
        }
    }

    /**
     * Today's date (YYYY-MM-DD, local calendar). Cached functions whose results depend on today
     * read it through deps.call, so the date rollover (checkDateRollover) invalidates them and
     * their reactive stores reload.
     * @param {Object} deps - Dependency decorator for tracking calls
     * @returns {Promise<string>}
     */
    static async getToday(deps) {
        _servedToday = todayISOString();
        return _servedToday;
    }

    /**
     * Write change stamps to the CACHE/Caching tab, for other sessions' pollers (caching.js
     * stampDataChange queues them and retries a failed write). One read of the tab, then one
     * write for the keys it already has and one atomic append for new keys, so two sessions
     * adding new keys at once never write the same row. A failed read writes nothing.
     * @param {Array<{prefix: string, timestamp: string}>} stamps - prefix: a cache key prefix such as
     *   'database:getData:"INVENTORY","FURNITURE"'
     * @returns {Promise<Object<string, string>>} prefix → the timestamp its row held before this
     *   write, for the stamps that updated an existing row
     */
    static async writeCacheTimestamps(stamps) {
        const rawData = await GoogleSheetsService.getSheetData('CACHE', 'Caching');
        const empty = !Array.isArray(rawData) || !rawData.length || !(rawData[0] || []).length;
        if (empty) {
            // A tab that really is empty: its header first (a range write, so nothing is truncated)
            await GoogleSheetsService.setSheetData('CACHE', 'Caching!A1:B1', [['Key', 'Timestamp']], null);
        }
        const rows = empty ? [] : rawData.slice(1);
        const updates = [];
        const appends = [];
        const replaced = {};
        for (const { prefix, timestamp } of stamps) {
            const rowIndex = rows.findIndex(row => Array.isArray(row) && row[0] === prefix);
            if (rowIndex !== -1) {
                updates.push({ range: `Caching!B${rowIndex + 2}:B${rowIndex + 2}`, values: [[timestamp]] });
                replaced[prefix] = rows[rowIndex][1] || '';
            } else {
                appends.push([prefix, timestamp]);
            }
        }
        await GoogleSheetsService.batchSetValues('CACHE', updates, { raw: true });
        await GoogleSheetsService.appendSheetValues('CACHE', 'Caching!A:B', appends);
        return replaced;
    }

    /**
     * Write one change stamp now, dated a second ahead (as stampDataChange dates them). For tests
     * and the console helper, which simulate another session's write.
     * @param {string} prefix - Cache key prefix
     */
    static async writeCacheTimestamp(prefix) {
        await ApplicationUtils.writeCacheTimestamps([{ prefix, timestamp: new Date(Date.now() + 1000).toISOString() }]);
    }

    /**
     * Read all cache timestamps from CACHE/Caching tab.
     * Format: [['Key', 'Timestamp'], [key1, timestamp1], [key2, timestamp2], ...]
     * CRITICAL: Both columns must be present for poller to process. Rows with missing
     * key or timestamp are filtered out and won't trigger invalidation.
     * 
     * @returns {Promise<Array<{key: string, timestamp: string}>|null>} Null if auth unavailable, empty array if no entries
     */
    static async readCacheTimestamps() {
        // Return null when auth is unavailable — signals the poller to pause itself
        if (!GoogleSheetsAuth || !(await GoogleSheetsAuth.checkAuth())) return null;
        try {
            const rawData = await GoogleSheetsService.getSheetData('CACHE', 'Caching');
            if (!rawData || rawData.length < 2) return [];
            return rawData.slice(1)
                .filter(row => Array.isArray(row) && row[0] && row[1])
                .map(row => ({ key: row[0], timestamp: row[1] }));
        } catch (err) {
            // Re-throw authentication errors so they can trigger re-authentication
            const isAuthError = err && (
                err.status === 401 ||
                err.status === 403 ||
                err.result?.error?.code === 401 ||
                err.result?.error?.code === 403 ||
                err.result?.error?.status === 'UNAUTHENTICATED' ||
                err.result?.error?.status === 'PERMISSION_DENIED'
            );
            if (isAuthError) throw err;
            
            console.warn('[readCacheTimestamps] Failed to read cache timestamps:', err);
            return [];
        }
    }

    /**
     * Get or create a short link for a given path
     * Checks if the path already has a short code, otherwise creates one
     * @param {string} path - The full path to shorten
     * @returns {Promise<string>} The short code (e.g., "1gx")
     */
    static async getShortLink(path) {
        // Ensure Links tab exists
        const allTabs = await Database.getTabs('CACHE');
        const linksTab = allTabs.find(t => t.title === 'Links');
        
        if (!linksTab) {
            // Create Links tab with headers
            await Database.createTab('CACHE', null, 'Links', { bookkeeping: true });
            await Database.setData(
                'CACHE',
                'Links',
                [['Path', 'ShortCode', 'Created']],
                null,
                { skipMetadata: true, bookkeeping: true }
            );
        }
        
        // Get existing links
        const links = await Database.getData('CACHE', 'Links', {
            Path: 'Path',
            ShortCode: 'ShortCode',
            Created: 'Created'
        });
        
        // Check if path already exists
        const existing = links.find(link => link.Path === path);
        if (existing && existing.ShortCode) {
            return existing.ShortCode;
        }
        
        // Generate new short code (base-36)
        const maxCode = links.reduce((max, link) => {
            if (!link.ShortCode) return max;
            try {
                const num = parseInt(link.ShortCode, 36);
                return Math.max(max, num);
            } catch {
                return max;
            }
        }, 0);
        
        const newShortCode = (maxCode + 1).toString(36);
        
        // Add new link
        links.push({
            Path: path,
            ShortCode: newShortCode,
            Created: new Date().toISOString()
        });
        
        // Save back to sheet
        await Database.setData('CACHE', 'Links', links, {
            Path: 'Path',
            ShortCode: 'ShortCode',
            Created: 'Created'
        }, { skipMetadata: true, bookkeeping: true });
        
        return newShortCode;
    }

    /**
     * Expand a short code back to its full path
     * @param {string} shortCode - The short code to expand (e.g., "1gx")
     * @returns {Promise<string|null>} The full path, or null if not found
     */
    static async expandShortLink(shortCode) {
        try {
            const linksTab = await Database.findTabByName('CACHE', 'Links');
            if (!linksTab) return null;
            
            const links = await Database.getData('CACHE', 'Links', {
                Path: 'Path',
                ShortCode: 'ShortCode',
                Created: 'Created'
            });
            
            const link = links.find(l => l.ShortCode === shortCode);
            return link ? link.Path : null;
        } catch (error) {
            console.error('[ApplicationUtils] Error expanding short link:', error);
            return null;
        }
    }
}

export const ApplicationUtils = wrapMethods(
    applicationUtils_uncached, 
    'app_utils', 
    ['storeUserData', '_writeUserData', 'initializeDefaultSavedSearches', 'lockSheet', 'unlockSheet', 'forceUnlockSheet', 'releaseAllUserLocks', '_writeUserColumn', '_writeLockKeyRow', '_writeLockCell', '_numberToColumnLetter', '_initializeLocksSheet', 'writeCacheTimestamps', 'writeCacheTimestamp', 'readCacheTimestamps', 'getShortLink', 'expandShortLink'], // Mutation methods
    ['expandShortLink', 'getToday'], // Infinite cache methods
    { 'getSheetLock': 10000, 'getLocksData': 10000 } // Custom cache durations (10 seconds for getSheetLock and getLocksData)
);

// ─── Date rollover ───────────────────────────────────────────────────────────
// The date getToday last returned; null when nothing has read it since the last rollover.
let _servedToday = null;
const TODAY_CACHE_KEY = 'app_utils:getToday:';

/**
 * Invalidate getToday, and everything computed from it, once the local date differs from the one
 * it served. Checked every minute: a timer set for midnight fires late after the computer sleeps.
 * While offline, invalidation is skipped and retried on a later check.
 */
export function checkDateRollover() {
    if (!_servedToday || todayISOString() === _servedToday || networkState.isOffline) return;
    _servedToday = null;
    invalidateCache([{ namespace: 'app_utils', methodName: 'getToday', args: [] }]);
}
setInterval(checkDateRollover, 60 * 1000);

// ─── Persisted analytics (CACHE/Analytics) ──────────────────────────────────
// One row per persisted result (caching.js, wrapMethods persistentMethods):
//   Key | SavedAt | Sources | Value
// Read and written directly, like the Caching tab, so saving a result never invalidates cached
// reads. Validity is checked against the Caching tab timestamps, plus local midnight for getToday.
const ANALYTICS_TAB = 'Analytics';
const ANALYTICS_HEADERS = ['Key', 'SavedAt', 'Sources', 'Value'];
const SHEETS_CELL_LIMIT = 50000;
const TAB_READ_PREFIX = 'database:getData:';

async function readAnalyticsRows() {
    const raw = await GoogleSheetsService.getSheetData('CACHE', ANALYTICS_TAB);
    return Array.isArray(raw) ? raw : [];
}

setPersistentStore({
    // Data reads (stamped by Database writes), and this class's own sources: the clock and the
    // locks. Pure cached leaves such as findBestProjectIdentifierMatch carry long argument lists
    // and can never mark a row stale
    sourcePrefixes: ['database:', 'app_utils:'],
    async read(key) {
        const row = (await readAnalyticsRows()).slice(1).find(r => Array.isArray(r) && r[0] === key);
        if (!row || !row[1] || !row[3]) return null;
        return { savedAt: row[1], sources: JSON.parse(row[2] || '[]'), value: JSON.parse(row[3]) };
    },
    async write({ key, value, savedAt, sources }) {
        const line = [key, savedAt, JSON.stringify(sources), JSON.stringify(value)];
        const oversize = line.findIndex(cell => cell.length > SHEETS_CELL_LIMIT);
        if (oversize !== -1) {
            console.warn(`[Analytics] Not saved: ${key} ${ANALYTICS_HEADERS[oversize]} is ${line[oversize].length} characters; a sheet cell holds ${SHEETS_CELL_LIMIT}`);
            return;
        }
        const raw = await readAnalyticsRows();
        if (!raw.length || !raw[0]?.length) {
            await GoogleSheetsService.setSheetData('CACHE', ANALYTICS_TAB, [ANALYTICS_HEADERS, line], null);
            return;
        }
        const rowIndex = raw.slice(1).findIndex(r => Array.isArray(r) && r[0] === key);
        const sheetRow = rowIndex === -1 ? raw.length + 1 : rowIndex + 2;
        await GoogleSheetsService.setSheetData('CACHE', `${ANALYTICS_TAB}!A${sheetRow}:D${sheetRow}`, [line], null);
    },
    async readSourceTimestamps() {
        const stamps = await ApplicationUtils.readCacheTimestamps();
        if (!stamps) return null;
        return [...stamps, { key: TODAY_CACHE_KEY, timestamp: new Date(startOfTodayMs()).toISOString() }];
    },
    // A stale row's tab reads, grouped by spreadsheet: one batched request each (Database.prefetch)
    prefetch(sources) {
        const tabsByTable = {};
        for (const source of sources) {
            if (!source.startsWith(TAB_READ_PREFIX)) continue;
            try {
                const [tableId, tabName] = JSON.parse(`[${source.slice(TAB_READ_PREFIX.length)}]`);
                if (typeof tableId === 'string' && typeof tabName === 'string') {
                    (tabsByTable[tableId] ||= []).push(tabName);
                }
            } catch {
                // Not a tab read
            }
        }
        for (const [tableId, tabNames] of Object.entries(tabsByTable)) Database.prefetch(tableId, tabNames);
    }
});

setTimestampWriter((stamps) => ApplicationUtils.writeCacheTimestamps(stamps));
startCacheTimestampPoller(() => ApplicationUtils.readCacheTimestamps(), isLocalhost() ? 10_000 : 30_000);
startCacheCleanup(2 * 60 * 1000); // Clean up expired cache entries every 2 minutes

// ─── Development test helper ────────────────────────────────────────────────
// Exposes a console command to simulate an external change to the Caching tab
// and immediately run the poll cycle so the effect is visible without waiting
// for the 10–30 s interval.
//
// Usage (browser console):
//   window.__tsliTestExternalChange('database:getData:"INVENTORY","FURNITURE"')
//   window.__tsliTestExternalChange('database:getData:"PACK_LISTS","ATSC 2025 NAB"')
//
// The key must match the prefix format used by stampDataChange:
//   database:getData:"<TABLE_ID>","<TAB_NAME>"
//
if (isLocalhost() && typeof window !== 'undefined') {
    import('../utils/caching.js').then(({ triggerCachePoll }) => {
        window.__tsliTestExternalChange = async function(cacheKeyPrefix) {
            console.log(`[TSLI Test] Writing Caching tab timestamp for: ${cacheKeyPrefix}`);
            try {
                await applicationUtils_uncached.writeCacheTimestamp(cacheKeyPrefix);
                console.log('[TSLI Test] Timestamp written. Triggering poll...');
                await triggerCachePoll();
                console.log('[TSLI Test] Done.');
            } catch (err) {
                console.error('[TSLI Test] Failed:', err);
            }
        };
        console.log(
            '[TSLI Dev] Cache test helper ready.\n' +
            '  Simulate an external change:\n' +
            '    window.__tsliTestExternalChange(\'database:getData:"INVENTORY","FURNITURE"\')\n' +
            '  Run just the poll cycle:\n' +
            '    import("/docs/js/data_management/utils/caching.js").then(m => m.triggerCachePoll())'
        );
    });
}