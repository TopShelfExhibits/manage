import { Database, wrapMethods, invalidateCache } from '../index.js';

// Dynamically import GoogleSheetsAuth based on environment
import { isLocalhost } from '../../google_sheets_services/FakeGoogle.js';
let GoogleSheetsAuth, GoogleSheetsService;
if (isLocalhost()) {
    ({ GoogleSheetsAuth, GoogleSheetsService } = await import('../../google_sheets_services/FakeGoogle.js'));
} else {
    ({ GoogleSheetsAuth } = await import('../../google_sheets_services/GoogleSheetsAuth.js'));
    ({ GoogleSheetsService } = await import('../../google_sheets_services/GoogleSheetsData.js'));
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
                { column: 'Show Date', value: 0, type: 'after' },  // Today
                { column: 'Show Date', value: 30, type: 'before' } // 30 days in the future
            ],
            textFilters: []
        }
    ];
    
    /**
     * Store user data in a user-specific tab within the CACHE sheet
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} username - The username to create/find a tab for
     * @param {string} id - The ID to find/create a row for
     * @param {Array} data - Array of data to store in the row
     * @returns {Promise<boolean>} Success status
     */
    static async storeUserData(username, id, data) {
        // Sanitize username and compose tab name consistently with getUserData
        const sanitizedUsername = username.replace(/[^a-zA-Z0-9_-]/g, '_');
        const tabName = `UserData_${sanitizedUsername}`;
        
        // Convert data to JSON string if it's not already a string
        let serializedData;
        if (typeof data === 'string') {
            serializedData = data;
        } else {
            serializedData = JSON.stringify(data);
        }

        // Ensure tab exists (create with proper structure if not)
        const allTabs = await Database.getTabs('CACHE');
        let tab = allTabs.find(t => t.title === tabName);
        if (!tab) {
            // Don't create tab if data is null or empty (empty array/object)
            if (data === null || 
                (Array.isArray(data) && data.length === 0) || 
                (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0)) {
                console.log('Skipping tab creation for empty data, ID:', id);
                return;
            }
            
            await Database.createTab('CACHE', null, tabName); // create blank tab, no template
            // Initialize the tab with headers and a single data row as a 2D array
            return await Database.setData(
                'CACHE',
                tabName,
                [
                    ['ID', 'Value'],
                    [id, serializedData]
                ],
                null,
                { skipMetadata: true } // User data doesn't need change tracking
            );
        } else {   
            // Tab exists - need to read all existing data, update/add the row, then write back
            const existingData = await Database.getData('CACHE', tabName, { ID: 'ID', Value: 'Value' });
            
            // Find the row with matching ID
            const rowIndex = existingData.findIndex(row => row.ID === id);
            
            // If data is null, delete the entry
            if (data === null) {
                if (rowIndex !== -1) {
                    // Remove the row from existingData
                    existingData.splice(rowIndex, 1);
                    console.log('Deleting user data entry for ID:', id);
                } else {
                    // Entry doesn't exist, nothing to delete
                    console.log('User data entry not found for deletion, ID:', id);
                    return;
                }
            } else {
                // Normal update/insert logic
                if (rowIndex !== -1) {
                    // Update existing row
                    existingData[rowIndex].Value = serializedData;
                } else {
                    // Add new row
                    existingData.push({ ID: id, Value: serializedData });
                }
            }
            
            console.log('Storing user data - writing all rows:', existingData);
            
            // Write back ALL rows to the sheet
            return await Database.setData('CACHE', tabName, existingData, { ID: 'ID', Value: 'Value' }, {
                skipMetadata: true // User data doesn't need change tracking
            });
        }
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
     * Lock a spreadsheet tab for a user (single cell write)
     * @param {string} spreadsheet - The spreadsheet name (e.g., 'INVENTORY', 'PACK_LISTS')
     * @param {string} tab - The tab name
     * @param {string} user - The user email claiming the lock
     * @returns {Promise<boolean>} Success status
     */
    static async lockSheet(spreadsheet, tab, user) {
        try {
            //console.log(`[lockSheet] START: ${spreadsheet}/${tab} for ${user}`);
            const timestamp = new Date().toISOString();
            const lockKey = `${spreadsheet}:${tab}`;
            
            // Get current locks data
            //console.log(`[lockSheet] Getting locks data...`);
            const locksGrid = await ApplicationUtils.getLocksData();
            //console.log(`[lockSheet] Got locks data:`, locksGrid);
            
            // Check if already locked by another user
            // Must filter out "0" timestamps (released locks) and empty strings
            const existingLock = locksGrid.locks.find(lock => 
                lock.spreadsheet === spreadsheet && 
                lock.tab === tab && 
                lock.user !== user && 
                lock.timestamp && 
                lock.timestamp !== '0'
            );
            
            if (existingLock) {
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
            
            // Write timestamp to the specific cell (single cell write)
            const cellRow = lockRowIndex + 2; // +2 for header row (1-indexed)
            const cellCol = userColIndex + 2; // +2 for Lock Key column (1-indexed)
            //console.log(`[lockSheet] Writing timestamp to R${cellRow}C${cellCol}`);
            await this._writeLockCell(cellRow, cellCol, timestamp);
            //console.log(`[lockSheet] Timestamp written successfully`);
            
            // Invalidate getSheetLock cache so UI components see the new lock
            invalidateCache([
                { namespace: 'app_utils', methodName: 'getSheetLock', args: [spreadsheet, tab] },
                { namespace: 'app_utils', methodName: 'getSheetLock', args: [spreadsheet, tab, null] },
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
            invalidateCache([
                { namespace: 'app_utils', methodName: 'getSheetLock', args: [spreadsheet, tab], prefixMatch: true },
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
        
        // Find locks for this spreadsheet/tab with valid timestamps (not "0" or empty)
        const matchedLock = locksGrid.locks.find(lock => 
            lock.spreadsheet === spreadsheet && 
            lock.tab === tab && 
            lock.timestamp && 
            lock.timestamp !== '0'
        ) || null;
        
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
            
            const lockInfo = locksGrid.locks.find(lock => 
                lock.spreadsheet === spreadsheet && 
                lock.tab === tab && 
                lock.timestamp && 
                lock.timestamp !== '0'
            );
            
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
                    }, { skipMetadata: true });
                    
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
            // Must invalidate all possible argument combinations since cache includes optional currentUser
            invalidateCache([
                { namespace: 'app_utils', methodName: 'getSheetLock', args: [spreadsheet, tab] },
                { namespace: 'app_utils', methodName: 'getSheetLock', args: [spreadsheet, tab, null] },
                // Can't know all possible currentUser values, but the most common case is null
                // Components will re-fetch with their specific user after refresh
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
        console.log(`[_writeUserColumn] Added user ${user} at ${range}`);
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
                console.log('[getLocksData] No data found, returning empty grid');
                return { users: [], lockKeys: [], locks: [] };
            }
            
            // First row contains headers: ["Database", "user1@example.com", "user2@example.com", ...]
            const headers = rawData[0] || [];
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
                    const timestamp = row[j];
                    const userEmail = users[j - 1]; // -1 because users is sliced
                    
                    if (!userEmail) continue;
                    
                    // Store lock info (even if timestamp is "0" or empty)
                    locks.push({
                        user: userEmail,
                        spreadsheet: spreadsheet,
                        tab: tab,
                        timestamp: timestamp || null
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
}

export const ApplicationUtils = wrapMethods(
    applicationUtils_uncached, 
    'app_utils', 
    ['storeUserData', 'initializeDefaultSavedSearches', 'lockSheet', 'unlockSheet', 'forceUnlockSheet', 'releaseAllUserLocks', '_writeUserColumn', '_writeLockKeyRow', '_writeLockCell', '_numberToColumnLetter', '_initializeLocksSheet'], // Mutation methods
    [], // Infinite cache methods
    { 'getSheetLock': 20000, 'getLocksData': 10000 } // Custom cache durations (20 seconds for getSheetLock, 10 seconds for getLocksData)
);