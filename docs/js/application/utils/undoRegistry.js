// Global undo/redo registry for table operations
// Route-scoped undo stacks that maintain separate histories per navigation path

// Store reference to tableRowSelectionState (will be set by tableComponent on load)
let tableRowSelectionState = null;

export function setTableRowSelectionState(selectionState) {
    tableRowSelectionState = selectionState;
}

export const undoRegistry = Vue.reactive({
    // Route-scoped undo/redo stacks
    undoStacksByRoute: new Map(), // routeKey -> { undoStack: [], redoStack: [], arrayRefs: Set }
    
    // Current active route
    currentRouteKey: null,
    
    // Configuration
    maxUndoSteps: 50, // Maximum undo steps per route
    maxRouteStacks: 10, // Maximum number of routes to track (LRU eviction)
    selectionCooldown: 1000, // 1 second cooldown for selection state changes
    
    // Track current edit capture to prevent duplicate captures
    _currentEditCapture: null, // { routeKey, tableId, rowIndex, colIndex }
    
    // Track current selection capture for cooldown
    _currentSelectionCapture: null, // { routeKey, timestamp, arrayRefs: Set }
    
    // Get or create route stacks with LRU eviction
    _getRouteStacks(routeKey) {
        if (!this.undoStacksByRoute.has(routeKey)) {
            this.undoStacksByRoute.set(routeKey, {
                undoStack: [],
                redoStack: [],
                arrayRefs: new Set() // Track which arrays this route uses
            });
            
            // LRU eviction if exceeding maxRouteStacks
            if (this.undoStacksByRoute.size > this.maxRouteStacks) {
                const firstKey = this.undoStacksByRoute.keys().next().value;
                const evictedStacks = this.undoStacksByRoute.get(firstKey);
                console.log(`[Undo] Evicting route '${firstKey}' - had ${evictedStacks.arrayRefs.size} arrays with ${evictedStacks.undoStack.length} undo states`);
                this.undoStacksByRoute.delete(firstKey);
                // Snapshots are automatically GC'd when route is deleted
            }
        }
        return this.undoStacksByRoute.get(routeKey);
    },
    
    // Set the active route for undo/redo operations
    setActiveRoute(routeKey) {
        this.currentRouteKey = routeKey;
        this._currentEditCapture = null; // Clear edit capture when route changes
        this._currentSelectionCapture = null; // Clear selection capture cooldown when route changes
        console.log(`[Undo] Active route set to: ${routeKey}`);
    },
    
    // Unified capture function for all operations
    // Can handle single array (cell edits) or multiple arrays (drags, deletions)
    capture(arrays, routeKey, options = {}) {
        const {
            type = 'operation',
            cellInfo = null,
            preventDuplicates = false,
            selectionState = null // Optional: pass tableRowSelectionState to capture selections
        } = options;
        
        // Normalize arrays to always be an array of data arrays
        // Check if arrays is a single data array or an array of data arrays
        let arrayList;
        if (Array.isArray(arrays)) {
            // Check if this is an array of data arrays or a single data array
            // A data array will have _tableId property on the array itself
            // If first element is also an array, it's an array of arrays
            const isArrayOfArrays = (arrays.length > 0 && Array.isArray(arrays[0]));
            arrayList = isArrayOfArrays ? arrays : [arrays];
        } else {
            arrayList = [arrays];
        }
        
        if (!routeKey || !arrayList || arrayList.length === 0) {
            console.warn('[Undo] Cannot capture - missing routeKey or arrays');
            return;
        }
        
        // Duplicate prevention for cell edits
        if (preventDuplicates && cellInfo) {
            const tableId = arrayList[0]._tableId || 'unknown';
            if (this._currentEditCapture &&
                this._currentEditCapture.routeKey === routeKey &&
                this._currentEditCapture.tableId === tableId &&
                this._currentEditCapture.rowIndex === cellInfo.rowIndex &&
                this._currentEditCapture.colIndex === cellInfo.colIndex) {
                console.log(`[Undo] Skipping duplicate capture for cell [${cellInfo.rowIndex}, ${cellInfo.colIndex}]`);
                return;
            }
        }
        
        // Selection cooldown handling for selection-toggle operations
        if (type === 'selection-toggle' && selectionState) {
            const now = Date.now();
            
            // Check if we're within cooldown period
            if (this._currentSelectionCapture &&
                this._currentSelectionCapture.routeKey === routeKey &&
                (now - this._currentSelectionCapture.timestamp) < this.selectionCooldown) {
                
                // Check if any of the arrays are new (not in current capture)
                const newArrays = arrayList.filter(arr => !this._currentSelectionCapture.arrayRefs.has(arr));
                
                if (newArrays.length === 0) {
                    // All arrays already captured, reset cooldown timer
                    this._currentSelectionCapture.timestamp = now;
                    console.log(`[Undo] Selection in tracked array - cooldown reset (${this.selectionCooldown}ms)`);
                    return;
                } else {
                    // New arrays detected - add them to the existing capture
                    console.log(`[Undo] Adding ${newArrays.length} new array(s) to existing selection capture`);
                    
                    const stacks = this._getRouteStacks(routeKey);
                    const existingSnapshot = stacks.undoStack[stacks.undoStack.length - 1];
                    
                    // Capture selection state for new arrays only
                    const newArraySelections = this._captureSelectionState(selectionState, newArrays);
                    
                    // Add new array snapshots to existing snapshot
                    newArrays.forEach(arr => {
                        existingSnapshot.arrays.push({
                            tableId: arr._tableId || 'unknown',
                            arrayRef: arr,
                            snapshot: this._createSnapshotWithoutAppData(arr)
                        });
                    });
                    
                    // Merge new selections into existing selections
                    if (newArraySelections && existingSnapshot.selections) {
                        existingSnapshot.selections.selections.push(...newArraySelections.selections);
                        existingSnapshot.selections.affectedArrays.push(...newArrays);
                    } else if (newArraySelections) {
                        existingSnapshot.selections = newArraySelections;
                    }
                    
                    // Add new arrays to current capture tracking and reset cooldown timer
                    newArrays.forEach(arr => {
                        this._currentSelectionCapture.arrayRefs.add(arr);
                        stacks.arrayRefs.add(arr);
                    });
                    this._currentSelectionCapture.timestamp = now;
                    
                    console.log(`[Undo] Updated selection capture - now tracking ${this._currentSelectionCapture.arrayRefs.size} array(s), cooldown reset`);
                    return;
                }
            }
        }
        
        const stacks = this._getRouteStacks(routeKey);
        
        // Capture selection state if provided
        let capturedSelections = null;
        if (selectionState) {
            capturedSelections = this._captureSelectionState(selectionState, arrayList);
        }
        
        // Create snapshots of all involved arrays (excluding AppData)
        const arraySnapshots = arrayList.map(arr => ({
            tableId: arr._tableId || 'unknown',
            arrayRef: arr,
            snapshot: this._createSnapshotWithoutAppData(arr)
        }));
        
        const snapshot = {
            type,
            timestamp: Date.now(),
            routeKey,
            cellInfo,
            arrays: arraySnapshots,
            selections: capturedSelections // Store selection state
        };
        
        // Add to undo stack
        stacks.undoStack.push(snapshot);
        
        // Clear redo stack (new action invalidates redo)
        stacks.redoStack = [];
        
        // Register array references
        arrayList.forEach(arr => stacks.arrayRefs.add(arr));
        
        // Limit stack size
        if (stacks.undoStack.length > this.maxUndoSteps) {
            stacks.undoStack.shift();
        }
        
        // Mark cell as captured if this was a cell edit with duplicate prevention
        if (preventDuplicates && cellInfo) {
            const tableId = arrayList[0]._tableId || 'unknown';
            this._currentEditCapture = { routeKey, tableId, rowIndex: cellInfo.rowIndex, colIndex: cellInfo.colIndex };
        }
        
        // Mark selection as captured if this was a selection-toggle operation
        if (type === 'selection-toggle' && selectionState) {
            this._currentSelectionCapture = {
                routeKey,
                timestamp: Date.now(),
                arrayRefs: new Set(arrayList)
            };
            console.log(`[Undo] Started selection cooldown (${this.selectionCooldown}ms) for ${arrayList.length} array(s)`);
        } else if (type !== 'selection-toggle') {
            // Clear selection cooldown for non-selection operations
            this._currentSelectionCapture = null;
        }
        
        const selectionDesc = capturedSelections ? ` with ${capturedSelections.selections.length} selection(s)` : '';
        const opDesc = cellInfo ? `cell edit [${cellInfo.rowIndex}, ${cellInfo.colIndex}]` : `${type} with ${arrayList.length} array(s)`;
        console.log(`[Undo] Captured ${opDesc}${selectionDesc} for route: ${routeKey} (stack: ${stacks.undoStack.length})`);
    },
    
    // Clear current edit capture (called on blur or route change)
    clearCurrentEditCapture() {
        this._currentEditCapture = null;
    },
    
    // Clear current selection capture cooldown
    clearCurrentSelectionCapture() {
        this._currentSelectionCapture = null;
    },
    
    // Capture current selection state
    _captureSelectionState(selectionState, arrayList) {
        if (!selectionState) {
            return null;
        }
        
        if (selectionState.selections.size === 0) {
            console.log('[Undo] Capturing empty selection state');
            // Return empty state (not null) so undo can restore to "no selections"
            return {
                selections: [],
                dragId: selectionState.dragId,
                affectedArrays: arrayList // Store which arrays this capture is for
            };
        }
        
        console.log(`[Undo] Capturing ${selectionState.selections.size} selection(s)`);
        
        // Store references to selected row objects and their source arrays
        // This allows us to find them after array mutations
        const capturedSelections = [];
        
        for (const [selectionKey, selection] of selectionState.selections) {
            const { rowIndex, sourceArray, dragId } = selection;
            const rowObject = sourceArray[rowIndex];
            console.log(`[Undo]   - Capturing row ${rowIndex} from array (length: ${sourceArray.length})`);
            
            // Only capture selections for arrays involved in this operation
            if (rowObject && arrayList.includes(sourceArray)) {
                // Store multiple ways to identify the row since object references break on snapshot restore
                const identifiers = {
                    Show: rowObject.Show,
                    Item: rowObject.Item,
                    Crate: rowObject.Crate,
                    Description: rowObject.Description,
                    Quantity: rowObject.Quantity
                };
                
                capturedSelections.push({
                    rowObject: rowObject, // Store row object reference (may break)
                    rowIndex: rowIndex, // Store original index as fallback
                    identifiers: identifiers, // Store key properties to match by content
                    sourceArray: sourceArray, // Store array reference
                    dragId: dragId
                });
            }
        }
        
        console.log(`[Undo] Captured ${capturedSelections.length} selection(s) total`);
        
        return {
            selections: capturedSelections,
            dragId: selectionState.dragId,
            affectedArrays: arrayList // Store which arrays this capture is for
        };
    },
    
    // Restore selection state
    _restoreSelectionState(capturedSelections, selectionState) {
        if (!capturedSelections || !selectionState) {
            console.log('[Undo] No selection state to restore (null or undefined)');
            return;
        }
        
        const selectionCount = capturedSelections.selections.length;
        if (selectionCount === 0) {
            console.log(`[Undo] Restoring empty selection state (clearing selections from affected arrays)`);
        } else {
            console.log(`[Undo] Restoring ${selectionCount} selection(s)`);
        }
        
        // Only clear selections from the arrays involved in this operation
        // This preserves selections from other tables
        const affectedArrays = capturedSelections.affectedArrays || [];
        let previousCount = 0;
        affectedArrays.forEach(array => {
            const countBefore = selectionState.getArraySelectionCount(array);
            previousCount += countBefore;
            selectionState.clearArray(array);
        });
        console.log(`[Undo]   - Cleared ${previousCount} previous selection(s) from ${affectedArrays.length} affected array(s)`);
        
        // Restore selections by finding where the rows are now
        let restoredCount = 0;
        capturedSelections.selections.forEach(({ rowObject, rowIndex, identifiers, sourceArray, dragId }) => {
            let currentIndex = -1;
            
            // Strategy 1: Try to find by object reference (works if references preserved)
            currentIndex = sourceArray.indexOf(rowObject);
            
            // Strategy 2: If object reference fails, try original index (works if array unchanged)
            if (currentIndex === -1 && rowIndex < sourceArray.length) {
                // Verify this is actually the same row by checking identifiers
                const rowAtIndex = sourceArray[rowIndex];
                let matches = true;
                for (const [key, value] of Object.entries(identifiers)) {
                    if (value !== undefined && rowAtIndex[key] !== value) {
                        matches = false;
                        break;
                    }
                }
                if (matches) {
                    currentIndex = rowIndex;
                    console.log(`[Undo]   - Found row at original index ${rowIndex} (verified by identifiers)`);
                }
            }
            
            // Strategy 3: If still not found, search by identifiers
            if (currentIndex === -1) {
                for (let i = 0; i < sourceArray.length; i++) {
                    const row = sourceArray[i];
                    let matches = true;
                    for (const [key, value] of Object.entries(identifiers)) {
                        if (value !== undefined && row[key] !== value) {
                            matches = false;
                            break;
                        }
                    }
                    if (matches) {
                        currentIndex = i;
                        console.log(`[Undo]   - Found row at index ${i} by matching identifiers`);
                        break;
                    }
                }
            }
            
            if (currentIndex !== -1) {
                selectionState.addRow(currentIndex, sourceArray, dragId);
                console.log(`[Undo]   - Restored selection at index ${currentIndex} in array (length: ${sourceArray.length})`);
                restoredCount++;
            } else {
                console.log(`[Undo]   - Could not find row in array (length: ${sourceArray.length}), identifiers:`, identifiers);
            }
        });
        
        // Restore dragId
        if (capturedSelections.dragId) {
            selectionState.dragId = capturedSelections.dragId;
        }
        
        console.log(`[Undo] Successfully restored ${restoredCount} of ${capturedSelections.selections.length} selection(s)`);
    },
    
    // Create a snapshot of an array without AppData (to avoid interfering with analytics)
    _createSnapshotWithoutAppData(array) {
        return array.map(row => {
            if (!row) return row;
            // Deep clone to avoid shared references for nested arrays/objects
            const rowCopy = this._deepCloneWithoutAppData(row);
            return rowCopy;
        });
    },
    
    // Deep clone a row, excluding AppData at all levels
    _deepCloneWithoutAppData(obj) {
        if (obj === null || typeof obj !== 'object') {
            return obj;
        }
        
        if (Array.isArray(obj)) {
            return obj.map(item => this._deepCloneWithoutAppData(item));
        }
        
        const cloned = {};
        for (const key in obj) {
            if (key === 'AppData') {
                continue; // Skip AppData at any level
            }
            cloned[key] = this._deepCloneWithoutAppData(obj[key]);
        }
        return cloned;
    },
    
    // Restore a snapshot while preserving current AppData
    _restoreSnapshotPreservingAppData(targetArray, snapshot) {
        const beforeLength = targetArray.length;
        
        // Save current AppData for each row
        const currentAppData = targetArray.map(row => row?.AppData);
        
        // Clear and restore from snapshot
        targetArray.splice(0, targetArray.length, ...snapshot);
        
        const afterLength = targetArray.length;
        console.log(`[Undo] Array restored: ${beforeLength} → ${afterLength} rows`);
        
        // Restore AppData for rows that existed before and still exist
        for (let i = 0; i < Math.min(currentAppData.length, targetArray.length); i++) {
            if (currentAppData[i] && targetArray[i]) {
                targetArray[i].AppData = currentAppData[i];
            }
        }
    },
    
    // Undo last operation for current route
    undo() {
        if (!this.currentRouteKey) {
            console.warn('[Undo] No active route set');
            return false;
        }
        
        const stacks = this._getRouteStacks(this.currentRouteKey);
        
        if (stacks.undoStack.length === 0) {
            console.log('[Undo] Nothing to undo');
            return false;
        }
        
        // Blur any focused contenteditable cell before undo
        if (document.activeElement && document.activeElement.contentEditable === 'true') {
            document.activeElement.blur();
        }
        
        // Pop state from undo stack
        const state = stacks.undoStack.pop();
        
        // Capture current selection state BEFORE restoring arrays (if we have tableRowSelectionState)
        let currentSelections = null;
        if (typeof tableRowSelectionState !== 'undefined') {
            const arrayList = state.arrays.map(a => a.arrayRef);
            currentSelections = this._captureSelectionState(tableRowSelectionState, arrayList);
        }
        
        // Save current state to redo stack before restoring (excluding AppData)
        const redoState = {
            type: state.type,
            timestamp: Date.now(),
            routeKey: state.routeKey,
            cellInfo: state.cellInfo,
            arrays: state.arrays.map(arrSnapshot => ({
                tableId: arrSnapshot.tableId,
                arrayRef: arrSnapshot.arrayRef,
                snapshot: this._createSnapshotWithoutAppData(arrSnapshot.arrayRef)
            })),
            selections: currentSelections // Use captured current selections
        };
        stacks.redoStack.push(redoState);
        
        // Restore state while preserving AppData
        state.arrays.forEach(arrSnapshot => {
            const targetArray = arrSnapshot.arrayRef;
            const snapshot = arrSnapshot.snapshot;
            
            // Restore snapshot while preserving current AppData
            this._restoreSnapshotPreservingAppData(targetArray, snapshot);
        });
        
        // Restore selection state (must happen after arrays are restored)
        console.log(`[Undo] About to restore selection state for undo operation`);
        if (state.selections && typeof tableRowSelectionState !== 'undefined') {
            this._restoreSelectionState(state.selections, tableRowSelectionState);
        } else {
            console.log(`[Undo] No selection state in undo snapshot`);
        }
        
        // Clear current edit capture so subsequent edits can create new snapshots
        this._currentEditCapture = null;
        this._currentSelectionCapture = null;
        
        console.log(`[Undo] Undid ${state.type} operation (undo: ${stacks.undoStack.length}, redo: ${stacks.redoStack.length})`);
        return true;
    },
    
    // Redo last undone operation for current route
    redo() {
        if (!this.currentRouteKey) {
            console.warn('[Undo] No active route set');
            return false;
        }
        
        const stacks = this._getRouteStacks(this.currentRouteKey);
        
        if (stacks.redoStack.length === 0) {
            console.log('[Undo] Nothing to redo');
            return false;
        }
        
        // Blur any focused contenteditable cell before redo
        if (document.activeElement && document.activeElement.contentEditable === 'true') {
            document.activeElement.blur();
        }
        
        // Pop state from redo stack
        const state = stacks.redoStack.pop();
        
        // Capture current selection state BEFORE restoring arrays (if we have tableRowSelectionState)
        let currentSelections = null;
        if (typeof tableRowSelectionState !== 'undefined') {
            const arrayList = state.arrays.map(a => a.arrayRef);
            currentSelections = this._captureSelectionState(tableRowSelectionState, arrayList);
        }
        
        // Save current state to undo stack before restoring (excluding AppData)
        const undoState = {
            type: state.type,
            timestamp: Date.now(),
            routeKey: state.routeKey,
            cellInfo: state.cellInfo,
            arrays: state.arrays.map(arrSnapshot => ({
                tableId: arrSnapshot.tableId,
                arrayRef: arrSnapshot.arrayRef,
                snapshot: this._createSnapshotWithoutAppData(arrSnapshot.arrayRef)
            })),
            selections: currentSelections // Use captured current selections
        };
        stacks.undoStack.push(undoState);
        
        // Restore state while preserving AppData
        state.arrays.forEach(arrSnapshot => {
            const targetArray = arrSnapshot.arrayRef;
            const snapshot = arrSnapshot.snapshot;
            
            // Restore snapshot while preserving current AppData
            this._restoreSnapshotPreservingAppData(targetArray, snapshot);
        });
        
        // Restore selection state (must happen after arrays are restored)
        console.log(`[Undo] About to restore selection state for redo operation`);
        if (state.selections && typeof tableRowSelectionState !== 'undefined') {
            this._restoreSelectionState(state.selections, tableRowSelectionState);
        } else {
            console.log(`[Undo] No selection state in redo snapshot`);
        }
        
        // Clear current edit capture so subsequent edits can create new snapshots
        this._currentEditCapture = null;
        this._currentSelectionCapture = null;
        
        console.log(`[Undo] Redid ${state.type} operation (undo: ${stacks.undoStack.length}, redo: ${stacks.redoStack.length})`);
        return true;
    },
    
    // Get memory usage statistics
    getMemoryStats() {
        const stats = {
            totalRoutes: this.undoStacksByRoute.size,
            currentRoute: this.currentRouteKey,
            routes: []
        };
        
        for (const [routeKey, stacks] of this.undoStacksByRoute) {
            const routeStats = {
                routeKey,
                undoCount: stacks.undoStack.length,
                redoCount: stacks.redoStack.length,
                arrayCount: stacks.arrayRefs.size,
                estimatedSize: 0
            };
            
            // Estimate size of snapshots
            stacks.undoStack.forEach(state => {
                state.arrays.forEach(arrSnapshot => {
                    const jsonStr = JSON.stringify(arrSnapshot.snapshot);
                    routeStats.estimatedSize += jsonStr.length;
                });
            });
            
            stacks.redoStack.forEach(state => {
                state.arrays.forEach(arrSnapshot => {
                    const jsonStr = JSON.stringify(arrSnapshot.snapshot);
                    routeStats.estimatedSize += jsonStr.length;
                });
            });
            
            stats.routes.push(routeStats);
        }
        
        return stats;
    },
    
    // Get arrays shared across multiple routes
    getSharedArrays() {
        const arrayToRoutes = new Map();
        
        for (const [routeKey, stacks] of this.undoStacksByRoute) {
            for (const arrayRef of stacks.arrayRefs) {
                if (!arrayToRoutes.has(arrayRef)) {
                    arrayToRoutes.set(arrayRef, new Set());
                }
                arrayToRoutes.get(arrayRef).add(routeKey);
            }
        }
        
        // Return only arrays used in multiple routes
        return Array.from(arrayToRoutes.entries())
            .filter(([arr, routes]) => routes.size > 1)
            .map(([arr, routes]) => ({
                tableId: arr._tableId,
                routes: Array.from(routes)
            }));
    },
    
    // Clear undo/redo history for a specific route
    // Used when data is refreshed from the server to prevent stale undo states
    clearRouteHistory(routeKey) {
        if (!routeKey) {
            console.warn('[Undo] Cannot clear history - no routeKey provided');
            return false;
        }
        
        const stacks = this.undoStacksByRoute.get(routeKey);
        if (!stacks) {
            console.log(`[Undo] No history to clear for route: ${routeKey}`);
            return false;
        }
        
        const undoCount = stacks.undoStack.length;
        const redoCount = stacks.redoStack.length;
        
        // Clear both stacks
        stacks.undoStack.splice(0);
        stacks.redoStack.splice(0);
        
        console.log(`[Undo] Cleared history for route '${routeKey}' (${undoCount} undo, ${redoCount} redo)`);
        return true;
    }
});
