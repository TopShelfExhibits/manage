import { html, parseDate, LoadingBarComponent, NavigationRegistry, undoRegistry, setTableRowSelectionState } from '../../index.js';
import { useSearch } from '../../utils/useSearch.js';

// Global table row selection state - single source of truth for all selections
export const tableRowSelectionState = Vue.reactive({
    // Selection map with unique keys to handle multiple tables
    selections: new Map(), // Map of selectionKey -> { rowIndex: number, sourceArray: arrayRef, dragId: dragId }
    
    // Version counter to trigger reactivity when selections change
    _version: 0,
    
    // Configuration options
    allowMultiSourceDrag: true, // Allow dragging selections from different data sources
    
    // Drag state
    findingDropTargets: false,
    dragSourceArray: null,
    dragTargetArray: null,
    dragId: null, // The dragId of the table group participating in drag operations
    currentDropTarget: null, // Current registered drop target from tables
    
    // Undo/redo support - track current route for undo captures
    currentRouteKey: null,
    
    // Multiselect timing - track when multiselect last finished to prevent immediate deselection
    lastMultiSelectEndTime: null,
    
    // Drag timing - track when drag last finished to prevent immediate deselection
    lastDragEndTime: null,
    
    // Set active route for undo tracking
    setActiveRoute(routeKey) {
        this.currentRouteKey = routeKey;
    },
    
    // Generate unique selection key for a row in a specific table
    _getSelectionKey(rowIndex, sourceArray) {
        // Use the array reference memory address as a unique identifier combined with row index
        // This approach ensures different table instances get different keys even if they have similar content
        if (!sourceArray._tableId) {
            // Generate a unique ID for this table if it doesn't have one
            sourceArray._tableId = 'table_' + Math.random().toString(36).substr(2, 9);
        }
        return `${sourceArray._tableId}_${rowIndex}`;
    },
    
    // Helper to get all children indices of a group master
    _getGroupChildren(rowIndex, sourceArray) {
        const row = sourceArray[rowIndex];
        if (!row || !row.MetaData) return [];
        
        let metadata;
        try {
            metadata = JSON.parse(row.MetaData);
        } catch (e) {
            return [];
        }
        
        const grouping = metadata?.grouping;
        
        // Only proceed if this row is a group master
        if (!grouping || !grouping.isGroupMaster) return [];
        
        const groupId = grouping.groupId;
        const children = [];
        
        // Find all rows with matching groupId that are NOT masters
        for (let i = 0; i < sourceArray.length; i++) {
            if (i === rowIndex) continue; // Skip the master itself
            
            const childRow = sourceArray[i];
            if (!childRow || !childRow.MetaData) continue;
            
            let childMetadata;
            try {
                childMetadata = JSON.parse(childRow.MetaData);
            } catch (e) {
                continue;
            }
            
            const childGrouping = childMetadata?.grouping;
            
            if (childGrouping && childGrouping.groupId === groupId && !childGrouping.isGroupMaster) {
                children.push(i);
            }
        }
        
        return children;
    },
    
    // Shared helper to get grouping edithistory from a row
    _getRowGrouping(rowIndex, sourceArray) {
        const row = sourceArray[rowIndex];
        if (!row || !row.MetaData) return null;
        
        try {
            const metadata = JSON.parse(row.MetaData);
            return metadata?.grouping || null;
        } catch (e) {
            return null;
        }
    },

    // Add a row to global selection
    addRow(rowIndex, sourceArray, dragId = null) {
        // Only clear if switching between different drag groups (both must have values and be different)
        if (dragId && this.dragId && dragId !== this.dragId) {
            this.clearAll();
        }

        const selectionKey = this._getSelectionKey(rowIndex, sourceArray);
        this.selections.set(selectionKey, {
            rowIndex: rowIndex,
            sourceArray: sourceArray,
            dragId: dragId
        });
        // Update global dragId if one is provided
        if (dragId) {
            this.dragId = dragId;
        }
        
        // Auto-select all children if this is a group master
        const children = this._getGroupChildren(rowIndex, sourceArray);
        children.forEach(childIndex => {
            const childKey = this._getSelectionKey(childIndex, sourceArray);
            this.selections.set(childKey, {
                rowIndex: childIndex,
                sourceArray: sourceArray,
                dragId: dragId
            });
        });
        
        // Increment version to trigger reactivity
        this._version++;
    },
    
    // Remove a row from global selection
    removeRow(rowIndex, sourceArray) {
        // Check if this row is a group child
        const grouping = this._getRowGrouping(rowIndex, sourceArray);
        if (grouping && !grouping.isGroupMaster) {
            // This is a group child - check if its master is selected
            const masterIndex = grouping.masterItemIndex;
            if (this.hasRow(sourceArray, masterIndex)) {
                // Master is selected, don't allow child to be unselected independently
                //console.log(`Cannot unselect row ${rowIndex} - its group master is selected`);
                return;
            }
        }
        
        const selectionKey = this._getSelectionKey(rowIndex, sourceArray);
        this.selections.delete(selectionKey);
        
        // Auto-deselect all children if this is a group master
        const children = this._getGroupChildren(rowIndex, sourceArray);
        children.forEach(childIndex => {
            const childKey = this._getSelectionKey(childIndex, sourceArray);
            this.selections.delete(childKey);
        });
        
        // Increment version to trigger reactivity
        this._version++;
    },
    
    // Toggle row selection
    toggleRow(rowIndex, sourceArray, dragId = null) {
        if (this.hasRow(sourceArray, rowIndex)) {
            this.removeRow(rowIndex, sourceArray); // removeRow handles children
        } else {
            this.addRow(rowIndex, sourceArray, dragId); // addRow handles children
        }
    },
    
    // Check if a row is selected (by checking if any selection has this index in its source array)
    hasRow(sourceArray, rowIndex) {
        const selectionKey = this._getSelectionKey(rowIndex, sourceArray);
        return this.selections.has(selectionKey);
    },
    
    // Clear all selections
    clearAll() {
        this.selections.clear();
        this._version++;
    },
    
    // Clear selections from a specific array
    clearArray(sourceArray) {
        for (const [selectionKey, selection] of this.selections) {
            if (selection.sourceArray === sourceArray) {
                this.selections.delete(selectionKey);
            }
        }
        this._version++;
    },
    
    // Get selection count for a specific array
    getArraySelectionCount(sourceArray) {
        let count = 0;
        for (const selection of this.selections.values()) {
            if (selection.sourceArray === sourceArray) {
                count++;
            }
        }
        return count;
    },
    
    // Get total selection count
    getTotalSelectionCount() {
        return this.selections.size;
    },
    
    // Get all selected row indices for a specific array
    getSelectedRowIndices(sourceArray) {
        const indices = [];
        for (const [selectionKey, selection] of this.selections) {
            if (selection.sourceArray === sourceArray) {
                indices.push(selection.rowIndex);
            }
        }
        return indices;
    },
    
    // Get all selected row data for a specific array
    getSelectedRowData(sourceArray) {
        const data = [];
        for (const [selectionKey, selection] of this.selections) {
            if (selection.sourceArray === sourceArray) {
                data.push(sourceArray[selection.rowIndex]);
            }
        }
        return data;
    },
    
    // Get all selected rows (index + data) for a specific array
    getSelectedRows(sourceArray) {
        const rows = [];
        for (const [selectionKey, selection] of this.selections) {
            if (selection.sourceArray === sourceArray) {
                rows.push({
                    index: selection.rowIndex,
                    data: sourceArray[selection.rowIndex]
                });
            }
        }
        return rows;
    },
    
    // Get all selected rows across all tables
    getAllSelectedRows() {
        const rows = [];
        for (const [selectionKey, selection] of this.selections) {
            rows.push({
                index: selection.rowIndex,
                row: selection.sourceArray[selection.rowIndex],
                sourceArray: selection.sourceArray
            });
        }
        return rows;
    },
    
    // Check if any selected row is a group master
    hasAnyGroupMaster() {
        for (const selection of this.selections.values()) {
            const grouping = this._getRowGrouping(selection.rowIndex, selection.sourceArray);
            if (grouping && grouping.isGroupMaster === true) {
                return true;
            }
        }
        return false;
    },
    
    // Check if a specific row is in a group (is a child, not a master)
    isRowInGroup(rowIndex, sourceArray) {
        const grouping = this._getRowGrouping(rowIndex, sourceArray);
        return grouping && !grouping.isGroupMaster;
    },
    
    // Check if a specific row is a group master
    isRowGroupMaster(rowIndex, sourceArray) {
        const grouping = this._getRowGrouping(rowIndex, sourceArray);
        return grouping && grouping.isGroupMaster === true;
    },
    
    // Check if inserting at a position would split a group
    wouldSplitGroup(insertIndex, sourceArray) {
        if (!sourceArray || sourceArray.length === 0) return false;
        
        // Get the rows immediately before and after the insertion point
        const rowBefore = insertIndex > 0 ? sourceArray[insertIndex - 1] : null;
        const rowAfter = insertIndex < sourceArray.length ? sourceArray[insertIndex] : null;
        
        if (!rowBefore && !rowAfter) return false;
        
        // Get grouping edithistory for both rows
        const beforeGrouping = rowBefore ? this._getRowGrouping(insertIndex - 1, sourceArray) : null;
        const afterGrouping = rowAfter ? this._getRowGrouping(insertIndex, sourceArray) : null;
        
        // If neither row is in a group, no split possible
        if (!beforeGrouping && !afterGrouping) return false;
        
        // Check if both rows belong to the same group
        if (beforeGrouping && afterGrouping && beforeGrouping.groupId === afterGrouping.groupId) {
            return true; // Would split the group
        }
        
        return false;
    },
    
    // Clean up group masters that have no children
    _cleanupOrphanedGroupMasters(sourceArray) {
        if (!sourceArray || sourceArray.length === 0) return;
        
        for (let i = 0; i < sourceArray.length; i++) {
            const grouping = this._getRowGrouping(i, sourceArray);
            
            // Only check rows that are group masters
            if (grouping && grouping.isGroupMaster) {
                const children = this._getGroupChildren(i, sourceArray);
                
                // If master has no children, remove its grouping data
                if (children.length === 0) {
                    const item = sourceArray[i];
                    if (item) {
                        // Parse existing metadata and remove only grouping
                        let metadata = {};
                        try {
                            metadata = JSON.parse(item.MetaData || '{}');
                        } catch (e) {
                            metadata = {};
                        }
                        delete metadata.grouping;
                        item.MetaData = Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : '';
                        //console.log(`Removed orphaned group master at index ${i} (no children found)`);
                    }
                }
            }
        }
    },
    
    // Group selected items under a target row (similar to markSelectedForDeletion)
    groupSelectedItemsUnder(targetIndex, targetArray) {
        if (this.selections.size === 0) {
            //console.log('No selections to group');
            return null;
        }
        
        const targetItem = targetArray[targetIndex];
        if (!targetItem) {
            console.warn('Invalid target item for grouping');
            return null;
        }
        
        // Get ALL selected items regardless of source array (for cross-table grouping)
        const allSelectedRows = [];
        const sourceArraysToProcess = new Map(); // Track which arrays we need to remove from
        
        for (const [selectionKey, selection] of this.selections) {
            const { rowIndex, sourceArray } = selection;
            const item = sourceArray[rowIndex];
            if (item) {
                allSelectedRows.push({ index: rowIndex, data: item, sourceArray });
                
                // Track items to remove from each source array
                if (!sourceArraysToProcess.has(sourceArray)) {
                    sourceArraysToProcess.set(sourceArray, []);
                }
                sourceArraysToProcess.get(sourceArray).push(rowIndex);
            }
        }
        
        const droppedItems = allSelectedRows.map(r => r.data);
        
        if (droppedItems.length === 0) {
            //console.log('No selected items found');
            return null;
        }
        
        // Check if target is already a group master
        const targetGrouping = this._getRowGrouping(targetIndex, targetArray);
        
        // Use existing groupId or generate new one
        const groupId = targetGrouping?.groupId || `G${Date.now()}`;
        
        // Update target item to be group master (if not already)
        if (!targetGrouping?.isGroupMaster) {
            // Parse existing metadata and add/update grouping
            let metadata = {};
            try {
                metadata = JSON.parse(targetItem.MetaData || '{}');
            } catch (e) {
                metadata = {};
            }
            metadata.grouping = {
                groupId: groupId,
                isGroupMaster: true,
                masterItemIndex: targetIndex
            };
            targetItem.MetaData = JSON.stringify(metadata);
            //console.log('Set target as group master:', groupId, 'index:', targetIndex);
        }
        
        // Remove dropped items from their source arrays (in reverse order to maintain indices)
        for (const [sourceArray, indices] of sourceArraysToProcess) {
            const sortedIndices = indices.sort((a, b) => b - a); // Descending order
            sortedIndices.forEach(idx => {
                if (idx < sourceArray.length) {
                    sourceArray.splice(idx, 1);
                }
            });
        }
        
        // Find new target index after removals (may have shifted if items were removed from same array)
        const newTargetIndex = targetArray.indexOf(targetItem);
        
        // Insert dropped items right after the target
        const insertPosition = newTargetIndex + 1;
        targetArray.splice(insertPosition, 0, ...droppedItems);
        
        // Update dropped items MetaData with correct masterItemIndex
        droppedItems.forEach(droppedItem => {
            // Parse existing metadata and add/update grouping
            let metadata = {};
            try {
                metadata = JSON.parse(droppedItem.MetaData || '{}');
            } catch (e) {
                metadata = {};
            }
            metadata.grouping = {
                groupId: groupId,
                isGroupMaster: false,
                masterItemIndex: newTargetIndex // Use the new index after reordering
            };
            droppedItem.MetaData = JSON.stringify(metadata);
            //console.log('Grouped item with master:', groupId);
        });
        
        //console.log(`Grouped ${droppedItems.length} items under target with groupId: ${groupId}`);
        
        // Return grouping info for potential UI feedback
        return {
            groupId,
            targetItem,
            droppedItems,
            targetIndex: newTargetIndex
        };
    },
    
    // Get all unique source arrays that have selections
    getSelectedDataSources() {
        const sources = new Set();
        for (const selection of this.selections.values()) {
            sources.add(selection.sourceArray);
        }
        return Array.from(sources);
    },
    
    // Get selection summary grouped by data source
    getSelectionSummary() {
        const summary = new Map();
        for (const [selectionKey, selection] of this.selections) {
            if (!summary.has(selection.sourceArray)) {
                summary.set(selection.sourceArray, {
                    sourceArray: selection.sourceArray,
                    dragId: selection.dragId,
                    rowIndices: [],
                    count: 0
                });
            }
            const sourceSummary = summary.get(selection.sourceArray);
            sourceSummary.rowIndices.push(selection.rowIndex);
            sourceSummary.count++;
        }
        return summary;
    },
    
    // Check if selections are all from the same data source
    areSelectionsFromSameSource() {
        if (this.selections.size <= 1) return true;
        
        let firstSource = null;
        for (const selection of this.selections.values()) {
            if (firstSource === null) {
                firstSource = selection.sourceArray;
            } else if (firstSource !== selection.sourceArray) {
                return false;
            }
        }
        return true;
    },
    
    // Validate if the current selection can be dragged
    canStartDrag() {
        if (this.selections.size === 0) return false;
        
        // If multi-source drag is disabled, only allow same-source selections
        if (!this.allowMultiSourceDrag && !this.areSelectionsFromSameSource()) {
            return false;
        }
        
        return true;
    },
    
    // Mark all selected rows for deletion (used by Delete key)
    markSelectedForDeletion(Value = true) {
        // Mark all selected rows for deletion (used by Delete key)
        if (this.selections.size === 0) {
            //console.log('No selections to mark for deletion');
            return;
        }
        
        // Capture state for undo before marking for deletion
        if (Value && this.currentRouteKey) {
            const arraysToCapture = new Set();
            for (const selection of this.selections.values()) {
                arraysToCapture.add(selection.sourceArray);
            }
            undoRegistry.capture(Array.from(arraysToCapture), this.currentRouteKey, { type: 'deletion' });
        }
        
        let deletedCount = 0;
        for (const [selectionKey, selection] of this.selections) {
            const { rowIndex, sourceArray } = selection;
            if (sourceArray[rowIndex]) {
                const row = sourceArray[rowIndex];
                
                // Parse existing MetaData
                let metadata = {};
                if (row.MetaData) {
                    try {
                        metadata = typeof row.MetaData === 'string' ? JSON.parse(row.MetaData) : row.MetaData;
                    } catch (e) {
                        console.warn('Failed to parse MetaData:', e);
                    }
                }
                
                // Set or remove deletion flag
                if (Value) {
                    metadata.deletion = { marked: true };
                } else {
                    delete metadata.deletion;
                }
                
                // Save back to MetaData
                row.MetaData = Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
                
                deletedCount++;
            }
        }
        
        //console.log(`Marked ${deletedCount} selected rows for deletion = ${Value}`);
    },
    
    // Drag management methods
    startDrag(dataSourceArray, dragId) {
        // Validate if drag can be started
        if (!this.canStartDrag()) return false;
        
        // Check if we can drag with multiple data sources
        const selectionSummary = this.getSelectionSummary();
        const dataSources = this.getSelectedDataSources();
        this.findingDropTargets = true;
        
        // For compatibility, we'll use the first selection's info for dragSourceArray and dragId
        // but the actual drag logic will handle all sources
        this.dragSourceArray = dataSourceArray;
        this.dragId = dragId;
        this.currentDropTarget = null;
        
        // Increment version to trigger reactivity for drag state change
        this._version++;
        
        // Set up global mouse up and touch end listeners with proper binding
        this.handleGlobalMouseUp = this.handleGlobalMouseUp.bind(this);
        this.handleGlobalTouchEnd = this.handleGlobalTouchEnd.bind(this);
        document.addEventListener('mouseup', this.handleGlobalMouseUp);
        document.addEventListener('touchend', this.handleGlobalTouchEnd);
        document.addEventListener('touchcancel', this.handleGlobalTouchEnd);
        return true;
    },
    
    // Register drop target from a table
    registerDropTarget(tableData, dropTarget) {
        if (this.findingDropTargets) {
            this.currentDropTarget = dropTarget;
            this.dragTargetArray = tableData;
        }
    },
    
    // Clear drop target registration
    clearDropTargetRegistration(tableData) {
        if (this.dragTargetArray === tableData) {
            this.currentDropTarget = null;
        }
    },
    
    
    // Global mouse up handler for drag operations
    handleGlobalMouseUp(event) {
        if (!this.findingDropTargets) return;
        
        
        // Check if we have a valid drop target
        if (this.dragTargetArray && this.currentDropTarget && this.currentDropTarget.type) {
            const result = this.completeDrag(this.currentDropTarget);
        } else {
            // No valid drop target, cancel the drag
            this.stopDrag();
        }
    },
    
    // Global touch end handler for drag operations
    handleGlobalTouchEnd(event) {
        if (!this.findingDropTargets) return;
        
        // Check if we have a valid drop target
        if (this.dragTargetArray && this.currentDropTarget && this.currentDropTarget.type) {
            const result = this.completeDrag(this.currentDropTarget);
        } else {
            // No valid drop target, cancel the drag
            this.stopDrag();
        }
    },
    
    completeDrag(dropTarget) {
        //console.log('completeDrag called with:', dropTarget, 'findingDropTargets:', this.findingDropTargets, 'selections:', this.selections.size, 'dragTargetArray:', this.dragTargetArray);
        if (!this.findingDropTargets || this.selections.size === 0 || !this.dragTargetArray) {
            //console.log('completeDrag early exit - conditions not met');
            this.stopDrag();
            return false;
        }
        
        // Capture state before drag mutation for undo
        // Need to capture ALL arrays involved: both source arrays and target array
        if (this.currentRouteKey) {
            const arraysToCapture = new Set();
            
            // Add target array
            arraysToCapture.add(this.dragTargetArray);
            
            // Add all source arrays from selections
            for (const selection of this.selections.values()) {
                arraysToCapture.add(selection.sourceArray);
            }
            
            undoRegistry.capture(Array.from(arraysToCapture), this.currentRouteKey, { 
                type: 'drag',
                selectionState: tableRowSelectionState // Capture selection state with drag
            });
        }
        
        // Handle "onto" drop type - call groupSelectedItemsUnder directly
        if (dropTarget.type === 'onto') {
            //console.log('DROP ONTO detected! Calling groupSelectedItemsUnder...');
            const result = this.groupSelectedItemsUnder(
                dropTarget.targetIndex,
                this.dragTargetArray
            );
            
            if (result) {
                //console.log(`Grouped ${result.droppedItems.length} items under target with groupId: ${result.groupId}`);
                
                // Re-select the grouped items at their new positions
                this.clearAll(); // Clear old selections first
                
                // Grouped items are inserted right after the master (targetIndex + 1)
                const startIndex = result.targetIndex + 1;
                result.droppedItems.forEach((item, offset) => {
                    const newIndex = this.dragTargetArray.indexOf(item);
                    if (newIndex !== -1) {
                        this.addRow(newIndex, this.dragTargetArray, this.dragId);
                    }
                });
                
                //console.log(`Re-selected ${result.droppedItems.length} grouped items`);
            } else {
                console.warn('Grouping failed or no items to group');
                this.clearAll();
            }
            
            // Set timestamp to prevent outside click from clearing selection
            this.lastDragEndTime = Date.now();
            
            this.stopDrag();
            return true;
        }
        
        // Check if "between" drop would split a group - if so, treat as "onto" drop on group master
        if (dropTarget.type === 'between' && this.wouldSplitGroup(dropTarget.targetIndex, this.dragTargetArray)) {
            //console.log('DROP BETWEEN would split group! Converting to DROP ONTO group master...');
            
            // Find the group master for the group that would be split
            const rowBefore = dropTarget.targetIndex > 0 ? this.dragTargetArray[dropTarget.targetIndex - 1] : null;
            const rowAfter = dropTarget.targetIndex < this.dragTargetArray.length ? this.dragTargetArray[dropTarget.targetIndex] : null;
            
            // Get grouping info from adjacent rows
            const beforeGrouping = rowBefore ? this._getRowGrouping(dropTarget.targetIndex - 1, this.dragTargetArray) : null;
            const afterGrouping = rowAfter ? this._getRowGrouping(dropTarget.targetIndex, this.dragTargetArray) : null;
            
            // Use the groupId from either adjacent row (they should match if wouldSplitGroup returned true)
            const groupId = beforeGrouping?.groupId || afterGrouping?.groupId;
            
            if (groupId) {
                // Find the group master with this groupId
                let masterIndex = -1;
                for (let i = 0; i < this.dragTargetArray.length; i++) {
                    const grouping = this._getRowGrouping(i, this.dragTargetArray);
                    if (grouping && grouping.groupId === groupId && grouping.isGroupMaster) {
                        masterIndex = i;
                        break;
                    }
                }
                
                if (masterIndex !== -1) {
                    //console.log(`Found group master at index ${masterIndex} for groupId ${groupId}`);
                    const result = this.groupSelectedItemsUnder(masterIndex, this.dragTargetArray);
                    
                    if (result) {
                        //console.log(`Grouped ${result.droppedItems.length} items under group master with groupId: ${result.groupId}`);
                        
                        // Re-select the grouped items at their new positions
                        this.clearAll(); // Clear old selections first
                        
                        result.droppedItems.forEach((item) => {
                            const newIndex = this.dragTargetArray.indexOf(item);
                            if (newIndex !== -1) {
                                this.addRow(newIndex, this.dragTargetArray, this.dragId);
                            }
                        });
                        
                        //console.log(`Re-selected ${result.droppedItems.length} grouped items`);
                    } else {
                        console.warn('Grouping failed');
                        this.clearAll();
                    }
                    
                    // Set timestamp to prevent outside click from clearing selection
                    this.lastDragEndTime = Date.now();
                    
                    this.stopDrag();
                    return true;
                } else {
                    console.warn('Could not find group master for groupId:', groupId);
                    // Fall through to normal between logic
                }
            }
        }
        
        // Check if "between" drop does NOT split a group - remove grouping from non-master rows
        if (dropTarget.type === 'between' && !this.wouldSplitGroup(dropTarget.targetIndex, this.dragTargetArray)) {
            //console.log('DROP BETWEEN does not split group - removing grouping from non-master rows...');
            
            // Remove grouping from all dragged rows that are NOT group masters
            for (const selection of this.selections.values()) {
                const { rowIndex, sourceArray } = selection;
                const grouping = this._getRowGrouping(rowIndex, sourceArray);
                
                // Only remove grouping if row is in a group but NOT a master
                if (grouping && !grouping.isGroupMaster) {
                    // Check if the master of this child is also in the selection
                    const masterIndex = grouping.masterItemIndex;
                    const masterIsSelected = this.hasRow(sourceArray, masterIndex);
                    
                    // Only ungroup if the master is NOT being dragged with the child
                    if (!masterIsSelected) {
                        const item = sourceArray[rowIndex];
                        if (item) {
                            // Parse existing metadata and remove only grouping
                            let metadata = {};
                            try {
                                metadata = JSON.parse(item.MetaData || '{}');
                            } catch (e) {
                                metadata = {};
                            }
                            delete metadata.grouping;
                            item.MetaData = Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : '';
                            //console.log(`Removed grouping from row ${rowIndex} (between drop, master not selected)`);
                        }
                    }
                }
            }
        }
        
        // Group selections by source array
        const selectionsBySource = this.getSelectionSummary();
        
        if (selectionsBySource.size === 0) {
            //console.log('No selections found');
            this.stopDrag();
            return false;
        }
        
        // Calculate insertion position
        let insertPosition;
        //console.log('dropTarget.type:', dropTarget.type);
        if (dropTarget.type === 'header') {
            insertPosition = 0;
        } else if (dropTarget.type === 'footer') {
            // For footer drops, insert after the last element (at the end of the array)
            insertPosition = this.dragTargetArray.length;
            // Mark selected rows for deletion after footer drop completes
            this.markSelectedForDeletion(true);
        } else if (dropTarget.type === 'between') {
            insertPosition = dropTarget.targetIndex;
        } else {
            //console.log('Invalid dropTarget.type:', dropTarget.type);
            this.stopDrag();
            return false;
        }
        
        // Perform atomic move operation to prevent reactivity issues
        try {
            let totalRowsInserted = 0;
            const movedRows = []; // Track all moved row objects to re-select them after move
            
            // Process each source array
            for (const [sourceArray, sourceInfo] of selectionsBySource) {
                //console.log(`Processing source with ${sourceInfo.count} rows from ${sourceInfo.dragId || 'unknown'}`);
                
                // Sort row indices in ascending order to preserve original order
                const sortedIndicesAsc = sourceInfo.rowIndices.sort((a, b) => a - b);
                // Sort row indices in reverse order (highest first) for safe removal
                const sortedIndicesDesc = [...sortedIndicesAsc].reverse();
                
                // Extract row data BEFORE removal using ascending order to preserve original sequence
                const rowsData = sortedIndicesAsc.map(index => sourceArray[index]).filter(row => row !== undefined);
                
                // Track these rows for re-selection after move
                movedRows.push(...rowsData);
                
                // Clear AppData from all moved rows (drag operations reset analytics state)
                rowsData.forEach(row => {
                    if (row) {
                        delete row.AppData;
                    }
                });
                
                if (sourceArray === this.dragTargetArray) {
                    // Same array: reorder rows
                    //console.log('Same array reorder - insertPosition:', insertPosition + totalRowsInserted);
                    
                    let adjustedInsertPosition = insertPosition + totalRowsInserted;
                    
                    // Remove rows (in reverse order to maintain indices)
                    sortedIndicesDesc.forEach(index => {
                        if (index < sourceArray.length) {
                            sourceArray.splice(index, 1);
                            // Adjust insertion position if we removed rows before it
                            if (index < adjustedInsertPosition) {
                                adjustedInsertPosition--;
                            }
                        }
                    });
                    
                    // Insert at new position
                    if (adjustedInsertPosition >= 0 && adjustedInsertPosition <= sourceArray.length) {
                        sourceArray.splice(adjustedInsertPosition, 0, ...rowsData);
                    }
                    
                    //totalRowsInserted += rowsData.length;
                } else {
                    // Different arrays: move rows to target
                    //console.log('Different arrays move - from:', sourceArray.length, 'to:', this.dragTargetArray.length, 'insertPosition:', insertPosition + totalRowsInserted);
                    
                    // Remove from source array (in reverse order to maintain indices)
                    sortedIndicesDesc.forEach(index => {
                        if (index < sourceArray.length) {
                            sourceArray.splice(index, 1);
                        }
                    });
                    
                    // Insert into target array at adjusted position
                    const adjustedInsertPosition = insertPosition + totalRowsInserted;
                    if (adjustedInsertPosition >= 0 && adjustedInsertPosition <= this.dragTargetArray.length) {
                        this.dragTargetArray.splice(adjustedInsertPosition, 0, ...rowsData);
                    }
                    
                    totalRowsInserted += rowsData.length;
                    //console.log('After move - from:', sourceArray.length, 'to:', this.dragTargetArray.length);
                }
            }
            
            //console.log(`Total rows moved: ${totalRowsInserted}`);
            
            // Update selections to reflect new positions after move
            this.clearAll(); // Clear old selections first
            
            // Re-select moved rows at their new positions in the target array
            movedRows.forEach(movedRow => {
                const newIndex = this.dragTargetArray.indexOf(movedRow);
                if (newIndex !== -1) {
                    this.addRow(newIndex, this.dragTargetArray, this.dragId);
                }
            });
            
            //console.log(`Re-selected ${movedRows.length} moved rows at their new positions`);
        } catch (error) {
            console.error('Error during drag operation:', error);
            this.stopDrag();
            return false;
        }
        
        // Clean up any group masters that no longer have children
        this._cleanupOrphanedGroupMasters(this.dragTargetArray);
        
        // Set timestamp to prevent outside click from clearing selection
        this.lastDragEndTime = Date.now();
        
        // Clear drag state (but keep selections intact now)
        this.stopDrag(true);
        return true;
    },
    
    stopDrag(preserveDeletionMarkings = false) {
        this.findingDropTargets = false;
        this.dragSourceArray = null;
        this.dragTargetArray = null;
        this.dragId = null;
        this.currentDropTarget = null;
        // Keep onDropOntoCallback registered between drags (managed by component lifecycle)
        
        // Increment version to trigger reactivity for drag state change
        this._version++;
        
        // Remove global mouse up and touch end listeners
        document.removeEventListener('mouseup', this.handleGlobalMouseUp);
        document.removeEventListener('touchend', this.handleGlobalTouchEnd);
        document.removeEventListener('touchcancel', this.handleGlobalTouchEnd);
    }
});

// Register selection state with undo system
setTableRowSelectionState(tableRowSelectionState);

export const TableComponent = {
    name: 'TableComponent',
    components: { LoadingBarComponent },
    inject: ['appContext', '$modal'],
    props: {
        key: {
            type: String,
            default: 'defaultkey'
        },
        theme: {
            type: String,
            default: ''
        },
        data: {
            type: Array,
            default: () => []
        },
        columns: {
            type: Array,
            required: true
        },
        isLoading: {
            type: Boolean,
            default: false
        },
        isAnalyzing: {
            type: Boolean,
            default: false
        },
        loadingProgress: {
            type: Number,
            default: -1
        },
        error: {
            type: String,
            default: null
        },
        title: {
            type: String,
            default: 'Data Table'
        },
        showRefresh: {
            type: Boolean,
            default: true
        },
        showSearch: {
            type: Boolean,
            default: false
        },
        emptyMessage: {
            type: String,
            default: 'No data available'
        },
        draggable: {
            type: Boolean,
            default: false
        },
        newRow: {
            type: Boolean,
            default: false
        },
        showNewRowButton: {
            type: Boolean,
            default: false
        },
        showFooter: {
            type: Boolean,
            default: true
        },
        showHeader: {
            type: Boolean,
            default: true
        },
        dragId: {
            type: String,
            default: null
        },
        loadingMessage: {
            type: String,
            default: 'Loading data...'
        },
        originalData: {
            type: Array,
            required: true
        },
        hamburgerMenuComponent: {
            type: Object,
            default: null
        },
        hideColumns: {
            type: Array,
            default: () => []
        },
        // Global sortable prop - can be overridden per-column using column.sortable
        // Example column configuration:
        // { key: 'name', label: 'Name', sortable: true }   - Always sortable
        // { key: 'id', label: 'ID', sortable: false }      - Never sortable  
        // { key: 'date', label: 'Date' }                   - Uses table's sortable prop
        sortable: {
            type: Boolean,
            default: false
        },
        hideGroupMembers: {
            type: Boolean,
            default: false
        },
        syncSearchWithUrl: {
            type: Boolean,
            default: false
        },
        containerPath: {
            type: String,
            default: ''
        },
        navigateToPath: {
            type: Function,
            default: null
        },
        hideRowsOnSearch: {
            type: Boolean,
            default: true
        },
        allowDetails: {
            type: Boolean,
            default: false
        },
        parentSearchValue: {
            type: String,
            default: ''
        },
        allowDropOnto: {
            type: Boolean,
            default: false
        },
        enableGrouping: {
            type: Boolean,
            default: false
        },
        showSelectionBubble: {
            type: Boolean,
            default: false
        }
    },
    emits: ['refresh', 'cell-edit', 'new-row', 'inner-table-dirty', 'show-hamburger-menu', 'search', 'drop-onto'],
    setup(props, { emit }) {
        // Initialize search composable
        const search = useSearch({
            formatValue: null, // Will be provided via this.formatCellValue in methods
            syncWithUrl: props.syncSearchWithUrl,
            navigationRegistry: NavigationRegistry,
            containerPath: props.containerPath,
            appContext: Vue.inject('appContext')
        });

        // Return search properties and methods to be available in component
        return {
            search
        };
    },
    data() {
        return {
            dirtyCells: {},
            allowSaveEvent: false,
            nestedTableDirtyCells: {}, // Track dirty state for nested tables by [row][col]
            sortColumn: null, // Current sort column key
            sortDirection: 'asc', // Current sort direction: 'asc' or 'desc'
            expandedRows: new Set(), // Track which rows are expanded for details
            collapsedGroups: new Set(), // Track which group IDs are collapsed
            hasUndoCaptured: false, // Track if first edit has been captured for undo
            lastEditTimestamp: null, // Track last edit time for 5-second idle detection
            clickState: {
                isMouseDown: false,
                startRowIndex: null,
                startTime: null,
                startX: null,
                startY: null,
                longClickTimer: null,
                hasMoved: false,
                // Multi-selection state
                isMultiSelecting: false,
                lastHoveredRowIndex: null,
                // Touch-specific state for table tracking
                lastTouchTable: null // Track which table element finger was last over
            },
            dropTarget: {
                type: null, // 'between-rows', 'header', 'footer'
                position: null, // row index for between-rows, null for header/footer
                isAbove: false // for between-rows, whether drop is above the row
            },
            isMouseInTable: false,
            lastKnownMouseX: null,
            lastKnownMouseY: null,
            mouseMoveCounter: 0,
            hiddenColumns: [], // Reactive property for dynamically hiding columns (internal use only)
            showStickyHeader: false, // Controls visibility of sticky header
            stickyColumnWidths: [] // Store actual column widths from original table
        };
    },
    watch: {

        // Watch for changes to originalData prop and recompare dirty state
        originalData: {
            handler() {
                this.$nextTick(() => {
                    this.compareAllCellsDirty();
                });
            },
            deep: true
        },
        allowSaveEvent(val) {
            // Emit to parent if dirty state changes
            this.$emit('inner-table-dirty', val);
        },
        data: {
            handler() {
                this.$nextTick(() => {
                    this.updateAllEditableCells();
                    this.compareAllCellsDirty();
                });
            },
            deep: true,
            flush: 'post' // Ensure DOM updates happen after data changes
        },
        isLoading(val) {
            // When loading state changes, update cells and compare dirty
            this.$nextTick(() => {
                this.updateAllEditableCells();
                this.compareAllCellsDirty();
            });
        },
        visibleRows() {
            this.$nextTick(() => {
                this.updateAllEditableCells();
            });
        },
        draggable() {
            this.$nextTick(() => {
                this.updateAllEditableCells();
                this.compareAllCellsDirty();
            });
        },
        columns: {
            handler() {
                this.$nextTick(() => {
                    this.updateAllEditableCells();
                });
            },
            deep: true
        },
        // Clear drop targets when drag ends (handles touch where mouseleave doesn't fire)
        isDraggingGlobally(isActive, wasActive) {
            if (wasActive && !isActive) {
                // Drag just ended, clear any lingering drop target highlights
                this.clearDropTarget();
            }
        }
    },
    computed: {
        // Watch for global drag state to clear drop targets when drag ends
        // Access this computed property in template or via watcher to trigger reactivity
        isDraggingGlobally() {
            // Access _version to ensure reactivity
            tableRowSelectionState._version;
            return tableRowSelectionState.findingDropTargets;
        },
        selectedRowCount() {
            // Access _version to create reactive dependency
            tableRowSelectionState._version;
            return tableRowSelectionState.getTotalSelectionCount();
        },
        shouldShowSelectionBubble() {
            // Only show bubble if:
            // 1. showSelectionBubble prop is enabled
            // 2. There are selections globally
            // 3. This table contains the first selected row
            // 4. A drag is not currently happening
            // 5. The table has editable columns (edit mode is enabled)
            if (!this.showSelectionBubble || this.selectedRowCount === 0 || !this.hasEditableColumns) {
                return false;
            }
            
            // Find the first selection globally
            const firstSelection = tableRowSelectionState.selections.values().next().value;
            if (!firstSelection) return false;
            
            // Check if a drag is currently happening
            if (tableRowSelectionState.findingDropTargets) {
                return false;
            }

            // Check if this table's data array matches the first selection's source array
            return firstSelection.sourceArray === this.data;
        },
        hasConsecutiveSelection() {
            // Check if selected rows in this table form a consecutive sequence
            const selectedRows = this.getSelectedRows();
            if (selectedRows.length === 0) return false;
            
            // Check if ALL selections globally are from this table's data array
            // If any selection is from a different array, return false
            for (const selection of tableRowSelectionState.selections.values()) {
                if (selection.sourceArray !== this.data) {
                    return false; // Selection exists in a different array
                }
            }
            
            // If only one row selected in this table, it's consecutive
            if (selectedRows.length === 1) return true;
            
            // Sort indices
            const indices = selectedRows.map(r => r.index).sort((a, b) => a - b);
            
            // Check for gaps in the sequence
            for (let i = 1; i < indices.length; i++) {
                if (indices[i] !== indices[i - 1] + 1) {
                    return false; // Gap found
                }
            }
            return true; // All consecutive
        },
        areAllSelectedMarkedForDeletion() {
            // Check if all selected rows across all tables are marked for deletion
            const allSelectedRows = tableRowSelectionState.getAllSelectedRows();
            if (allSelectedRows.length === 0) return false;
            
            return allSelectedRows.every(({ row }) => {
                if (!row || !row.MetaData) return false;
                try {
                    const metadata = typeof row.MetaData === 'string' ? JSON.parse(row.MetaData) : row.MetaData;
                    return metadata?.deletion?.marked === true;
                } catch (e) {
                    return false;
                }
            });
        },
        firstSelectedVisibleRowIndex() {
            // Find the chronologically first selected row (from global selection state)
            // that exists in this table's visible rows
            if (tableRowSelectionState.selections.size === 0) {
                return -1;
            }
            
            // Get the chronologically first selection (Map maintains insertion order)
            const firstSelection = tableRowSelectionState.selections.values().next().value;
            if (!firstSelection || firstSelection.sourceArray !== this.data) {
                return -1; // First selection is not in this table
            }
            
            // Find this row in visibleRows
            for (let i = 0; i < this.visibleRows.length; i++) {
                const { idx } = this.visibleRows[i];
                if (idx === firstSelection.rowIndex) {
                    return i;
                }
            }
            return -1;
        },
        selectionBubbleStyle() {
            // Calculate position for the selection bubble based on the first selected row
            if (this.selectedRowCount === 0 || this.firstSelectedVisibleRowIndex === -1) {
                return { display: 'none' };
            }
            
            // Find the actual row element in the DOM using data attribute
            const table = this.$el?.querySelector('table');
            if (!table) return { display: 'none' };
            
            const targetRow = table.querySelector(`tbody tr[data-visible-idx="${this.firstSelectedVisibleRowIndex}"]`);
            
            if (!targetRow) return { display: 'none' };
            
            // Get the row's position relative to the table container
            const tableRect = table.getBoundingClientRect();
            const rowRect = targetRow.getBoundingClientRect();
            
            return {
                display: 'flex',
                top: (rowRect.top - tableRect.top + rowRect.height / 2) + 'px'
            };
        },
        activeSearchValue() {
            // Use parentSearchValue if provided, otherwise use composable searchValue
            return this.parentSearchValue || this.search.searchValue.value;
        },
        showSaveButton() {
            // True if any editable cell or add row button is present
            const hasEditable = this.columns.some(col => col.editable);
            const hasAddRow = !!this.newRow;
            return hasEditable || hasAddRow;
        },
        hasEditableColumns() {
            // True if any column is editable
            return this.columns.some(col => col.editable);
        },
        hideSet() {
            // Hide columns from hideColumns prop, hiddenColumns reactive data, and always hide 'AppData', 'EditHistory', and 'MetaData'
            return new Set([...(this.hideColumns || []), 'AppData', 'EditHistory', 'MetaData', ...(this.hiddenColumns || [])]);
        },
        mainTableColumns() {
            // find columns marked with a colspan property and eliminate the extra columns following them
            // e.g. if column 2 has colspan: 3, then columns 3 and 4 are removed
            // This allows for dynamic column spanning in the main table view
            const columnsClipped = [];
            let i = 0;
            while (i < this.columns.length) {
                const col = this.columns[i];
                columnsClipped.push(col);
                if (col.colspan) {
                    i += col.colspan;
                } else {
                    i++;
                }
            }

            // Filter out columns marked as details-only
            return columnsClipped.filter(column => !column.details);
        },
        visibleColumns() {
            // Get only columns not in hideSet
            return this.columns.filter(column => !this.hideSet.has(column.key) && !this.detailsColumns.includes(column));
        },
        detailsColumns() {
            // Get only columns marked for details display
            return this.columns.filter(column => column.details);
        },
        visibleRows() {
            // Filter rows based on search value but keep all rows including marked for deletion
            if (!Array.isArray(this.data)) return [];
            
            let filteredData = this.data
                .map((row, idx) => ({ row, idx }))
                .filter(({ row }) => row); // Only filter out null/undefined rows

            // Hide group members if flag is set
            if (this.hideGroupMembers) {
                filteredData = filteredData.filter(({ row, idx }) => {
                    if (!row.MetaData) return true;
                    try {
                        const metadata = JSON.parse(row.MetaData);
                        const grouping = metadata?.grouping;
                        // Show if not in a group OR if it's a group master
                        if (!grouping || grouping.isGroupMaster) return true;
                        
                        // This is a group child - check if its group is collapsed
                        // If group is NOT collapsed, show the child
                        return !this.collapsedGroups.has(grouping.groupId);
                    } catch (e) {
                        return true;
                    }
                });
            }

            // Apply search filter if activeSearchValue is provided and hideRowsOnSearch is enabled
            if (this.activeSearchValue && this.activeSearchValue.trim() && this.hideRowsOnSearch) {
                const searchTerm = this.activeSearchValue.toLowerCase().trim();
                // Split search term into multiple words for partial matching
                const searchWords = searchTerm.split(/\s+/).filter(word => word.length > 0);
                
                filteredData = filteredData.filter(({ row }) => {
                    if (!row) return false;
                    // Only search visible columns (exclude hidden columns)
                    const visibleColumns = this.columns.filter(column => !this.hideSet.has(column.key));
                    
                    // All search words must match somewhere in the row (AND logic)
                    return searchWords.every(word => 
                        visibleColumns.some(column => {
                            const value = row[column.key];
                            // Skip null/undefined values to prevent matching "undefined" or "null" strings
                            return value != null && String(value).toLowerCase().includes(word);
                        })
                    );
                });
            }

            // Apply sorting if sortColumn is set and the column is sortable
            if (this.sortColumn) {
                const sortColumn = this.columns.find(col => col.key === this.sortColumn);
                if (sortColumn && this.isColumnSortable(sortColumn)) {
                    filteredData.sort((a, b) => {
                    const aValue = a.row[this.sortColumn];
                    const bValue = b.row[this.sortColumn];
                    
                    // Handle null/undefined values
                    if (aValue === null || aValue === undefined) return 1;
                    if (bValue === null || bValue === undefined) return -1;
                    
                    // Try to parse as dates first
                    const aDate = parseDate(aValue);
                    const bDate = parseDate(bValue);
                    
                    if (aDate && bDate) {
                        // Both are valid dates - compare chronologically
                        const comparison = aDate.getTime() - bDate.getTime();
                        return this.sortDirection === 'desc' ? -comparison : comparison;
                    }
                    
                    // Determine if values are numbers
                    const aNum = parseFloat(aValue);
                    const bNum = parseFloat(bValue);
                    const isANum = !isNaN(aNum);
                    const isBNum = !isNaN(bNum);
                    
                    let comparison = 0;
                    
                    if (isANum && isBNum) {
                        // Both are numbers
                        comparison = aNum - bNum;
                    } else {
                        // String comparison
                        comparison = String(aValue).localeCompare(String(bValue));
                    }
                    
                    return this.sortDirection === 'desc' ? -comparison : comparison;
                    });
                }
            }

            return filteredData;
        },
        
        canUndo() {
            if (!undoRegistry.currentRouteKey) return false;
            const stacks = undoRegistry.undoStacksByRoute.get(undoRegistry.currentRouteKey);
            return stacks && stacks.undoStack.length > 0;
        },
        
        canRedo() {
            if (!undoRegistry.currentRouteKey) return false;
            const stacks = undoRegistry.undoStacksByRoute.get(undoRegistry.currentRouteKey);
            return stacks && stacks.redoStack.length > 0;
        }
    },
    mounted() {
        // Register route with undo system and tableRowSelectionState
        if (this.appContext?.currentPath) {
            const routeKey = this.appContext.currentPath.split('?')[0]; // Remove query params
            undoRegistry.setActiveRoute(routeKey);
            tableRowSelectionState.setActiveRoute(routeKey);
        }
        
        // Initialize search from URL and setup watcher if syncSearchWithUrl is enabled
        this.search.initializeFromUrl();
        this.search.setupUrlWatcher();
        
        this.$nextTick(() => {
            this.updateAllEditableCells();
            this.compareAllCellsDirty();
        });
        
        // Listen for clicks outside details area to close expanded details
        document.addEventListener('click', this.handleOutsideClick);
        // Listen for keyboard shortcuts (Escape, Delete)
        document.addEventListener('keydown', this.handleEscapeKey);
        
        // Set up sticky header positioning
        const appContent = document.querySelector('#app-content');
        if (appContent) {
            this.handleStickyHeaders = () => {
                const thead = this.$el.querySelector('thead');
                if (!thead) return;

                const table = this.$el.querySelector('table');
                if (!table) return;

                // Get navbar bottom position for sticky offset
                const navbar = document.querySelector('#navbar');
                const stickyOffset = navbar ? navbar.getBoundingClientRect().bottom : 0;

                // Get positions
                const tableRect = table.getBoundingClientRect();
                const theadRect = thead.getBoundingClientRect();

                // Capture actual column widths from the original table header
                const headerCells = thead.querySelectorAll('th');
                this.stickyColumnWidths = Array.from(headerCells).map(th => {
                    const rect = th.getBoundingClientRect();
                    return rect.width;
                });

                // Find the closest .container ancestor
                let containerEl = table.closest('.container');
                if (!containerEl) {
                    // Fallback: try parentNode chain for .container
                    let parent = table.parentNode;
                    while (parent && parent !== document.body) {
                        if (parent.classList && parent.classList.contains('container')) {
                            containerEl = parent;
                            break;
                        }
                        parent = parent.parentNode;
                    }
                }

                // Calculate if header should stick
                let shouldStick = tableRect.top <= stickyOffset && 
                                   tableRect.bottom > stickyOffset + theadRect.height;

                // Additional check: hide sticky header if closer than twice its height from bottom of container
                if (shouldStick && containerEl) {
                    const containerRect = containerEl.getBoundingClientRect();
                    const distanceFromBottom = containerRect.bottom - (stickyOffset + theadRect.height);
                    if (distanceFromBottom < 2 * theadRect.height) {
                        shouldStick = false;
                    }
                }

                // Check if table is horizontally overflowing (disable sticky header if scrollable)
                if (shouldStick) {
                    const tableWrapper = table.closest('.table-wrapper');
                    if (tableWrapper) {
                        const isHorizontallyScrollable = tableWrapper.scrollWidth > tableWrapper.clientWidth;
                        if (isHorizontallyScrollable) {
                            shouldStick = false;
                        }
                    }
                }

                // Update sticky header visibility and CSS variables for positioning
                if (shouldStick) {
                    this.showStickyHeader = true;
                    // Set CSS custom properties for dynamic positioning
                    this.$el.style.setProperty('--sticky-top', stickyOffset + 'px');
                    this.$el.style.setProperty('--sticky-left', tableRect.left + 'px');
                    this.$el.style.setProperty('--sticky-width', tableRect.width + 'px');
                } else {
                    this.showStickyHeader = false;
                }
            };
            
            appContent.addEventListener('scroll', this.handleStickyHeaders, { passive: true });
            window.addEventListener('resize', this.handleStickyHeaders, { passive: true });
            this.handleStickyHeaders(); // Initial position
        }
    },
    beforeUnmount() {
        document.removeEventListener('click', this.handleOutsideClick);
        document.removeEventListener('keydown', this.handleEscapeKey);
        // Clean up any active click state
        this.resetClickState();
        
        // Clean up sticky header scroll listener
        const appContent = document.querySelector('#app-content');
        if (appContent && this.handleStickyHeaders) {
            appContent.removeEventListener('scroll', this.handleStickyHeaders);
        }
        // Clean up resize listener
        if (this.handleStickyHeaders) {
            window.removeEventListener('resize', this.handleStickyHeaders);
        }
    },
    methods: {
        handleRefresh() {
            // Capture state before discarding changes (when allowSaveEvent is true)
            if (this.allowSaveEvent && undoRegistry.currentRouteKey) {
                undoRegistry.capture(this.data, undoRegistry.currentRouteKey, { type: 'discard' });
            }
            
            this.$emit('refresh');
            // Clear hidden columns on refresh
            this.hiddenColumns = [];
            // Also clear dirty state for nested tables on refresh
            this.nestedTableDirtyCells = {};
        },

        // Selection helper methods
        isRowSelected(rowIndex) {
            // Access _version to create reactive dependency
            tableRowSelectionState._version;
            return tableRowSelectionState.hasRow(this.data, rowIndex);
        },

        isRowDragging(rowIndex) {
            // Check if this row is currently being dragged
            return tableRowSelectionState.findingDropTargets && 
                   tableRowSelectionState.dragSourceArray === this.data &&
                   tableRowSelectionState.hasRow(this.data, rowIndex);
        },

        isRowAnalyzing(rowIndex) {
            // Check if this row is currently being analyzed
            const row = this.data[rowIndex];
            return row && row.AppData && row.AppData._analyzing === true;
        },

        isRowInGroup(rowIndex) {
            return tableRowSelectionState.isRowInGroup(rowIndex, this.data);
        },

        isRowGroupMaster(rowIndex) {
            return tableRowSelectionState.isRowGroupMaster(rowIndex, this.data);
        },

        isRowMarkedForDeletion(row) {
            if (!row || !row.MetaData) return false;
            try {
                const metadata = typeof row.MetaData === 'string' ? JSON.parse(row.MetaData) : row.MetaData;
                return metadata?.deletion?.marked === true;
            } catch (e) {
                return false;
            }
        },

        getRowMetadataClass(row) {
            if (!row || !row.MetaData) return '';
            try {
                const metadata = typeof row.MetaData === 'string' ? JSON.parse(row.MetaData) : row.MetaData;
                return metadata?.highlight?.class || '';
            } catch (e) {
                return '';
            }
        },

        wouldSplitGroup(insertIndex) {
            return tableRowSelectionState.wouldSplitGroup(insertIndex, this.data);
        },

        getSelectedRows() {
            return tableRowSelectionState.getSelectedRows(this.data);
        },

        getSelectedRowIndices() {
            return tableRowSelectionState.getSelectedRowIndices(this.data);
        },

        handleAddRowAbove() {
            const selectedRows = this.getSelectedRows();
            if (selectedRows.length === 0 || !this.hasConsecutiveSelection) return;
            
            // Get all selected indices, sort them, and use the first one
            const indices = selectedRows.map(r => r.index).sort((a, b) => a - b);
            const firstIndex = indices[0];
            
            // Emit new-row event with position info
            this.$emit('new-row', { position: 'above', targetIndex: firstIndex });
            
            // Clear selection state after adding row
            tableRowSelectionState.clearAll();
        },

        handleAddRowBelow() {
            const selectedRows = this.getSelectedRows();
            if (selectedRows.length === 0 || !this.hasConsecutiveSelection) return;
            
            // Get all selected indices, sort them, and use the last one
            const indices = selectedRows.map(r => r.index).sort((a, b) => a - b);
            const lastIndex = indices[indices.length - 1];
            
            // Emit new-row event with position info
            this.$emit('new-row', { position: 'below', targetIndex: lastIndex });
            
            // Clear selection state after adding row
            tableRowSelectionState.clearAll();
        },

        handleDeleteSelected() {
            // Toggle deletion state for all selected rows
            if (tableRowSelectionState.getTotalSelectionCount() > 0) {
                // If all selected rows are marked, unmark them; otherwise mark them
                const shouldMark = !this.areAllSelectedMarkedForDeletion;
                tableRowSelectionState.markSelectedForDeletion(shouldMark);
                tableRowSelectionState.clearAll();
            }
        },

        handleMoreOptions() {
            // Emit event with selected rows data to parent for custom menu options
            if (tableRowSelectionState.getTotalSelectionCount() > 0) {
                const selectedRows = tableRowSelectionState.getAllSelectedRows();
                this.$emit('row-options', selectedRows);
            }
        },

        handleSort(columnKey) {
            // Check if this specific column is sortable
            const column = this.columns.find(col => col.key === columnKey);
            if (!column || !this.isColumnSortable(column)) return;
            
            if (this.sortColumn === columnKey) {
                // Toggle sort direction if same column
                this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                // New column, start with ascending
                this.sortColumn = columnKey;
                this.sortDirection = 'asc';
            }
        },
        
        isColumnSortable(column) {
            // Check if column has explicit sortable property, otherwise fall back to table-wide sortable
            return column.sortable !== undefined ? column.sortable : this.sortable;
        },

        getSortIcon(columnKey) {
            const column = this.columns.find(col => col.key === columnKey);
            if (!this.isColumnSortable(column) || this.sortColumn !== columnKey) return '';
            return this.sortDirection === 'asc' ? '⭡' : '⭣';
        },
        
        handleHideColumn(columnKey) {
            // Add column to hiddenColumns array to hide it
            if (!this.hiddenColumns.includes(columnKey)) {
                this.hiddenColumns.push(columnKey);
            }
        },
        
        formatCellValue(value, column) {
            if (value === null || value === undefined) return '';
            
            // Apply column-specific formatting
            if (column.format) {
                switch (column.format) {
                    case 'currency':
                        return `$${parseFloat(value).toFixed(2)}`;
                    case 'date':
                        // If value is a string and does not contain a year (4 consecutive digits), skip formatting
                        if (typeof value === 'string' && !/\d{4}/.test(value)) {
                            return value;
                        }
                        // Use parseDate helper to handle all supported date formats
                        const parsedDate = parseDate(value);
                        return parsedDate ? parsedDate.toLocaleDateString() : value;
                    case 'number':
                        return parseFloat(value).toLocaleString();
                    case 'percentage':
                        return `${parseFloat(value).toFixed(1)}%`;
                    default:
                        return value;
                }
            }
            
            return value;
        },

        // Wrapper method for search highlighting that uses the composable with proper formatting
        highlightSearchText(value, column) {
            // Create a temporary formatter that uses this component's formatCellValue
            const formatter = (val, col) => this.formatCellValue(val, col);
            
            // Call the composable's highlightText with the formatter
            const formattedValue = formatter(value, column);
            
            // If no search, return formatted value
            if (!this.activeSearchValue || !this.activeSearchValue.trim() || !formattedValue) {
                return formattedValue;
            }
            
            // Use the composable's escapeHtml and highlighting logic
            const stringValue = String(formattedValue);
            const words = this.search.splitSearchTerms(this.activeSearchValue);
            
            // Collect all match positions
            const matches = [];
            words.forEach(word => {
                const escapedSearchWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(escapedSearchWord, 'gi');
                let match;
                while ((match = regex.exec(stringValue)) !== null) {
                    matches.push({
                        start: match.index,
                        end: match.index + match[0].length,
                        text: match[0]
                    });
                }
            });
            
            // Sort matches by start position
            matches.sort((a, b) => a.start - b.start);
            
            // Merge overlapping matches
            const merged = [];
            for (const match of matches) {
                if (merged.length === 0) {
                    merged.push(match);
                } else {
                    const last = merged[merged.length - 1];
                    if (match.start <= last.end) {
                        last.end = Math.max(last.end, match.end);
                        last.text = stringValue.substring(last.start, last.end);
                    } else {
                        merged.push(match);
                    }
                }
            }
            
            // Build HTML with highlights
            let result = '';
            let lastIndex = 0;
            
            for (const match of merged) {
                const beforeMatch = stringValue.substring(lastIndex, match.start);
                result += this.search.escapeHtml(beforeMatch);
                result += `<span class="search-match">${this.search.escapeHtml(match.text)}</span>`;
                lastIndex = match.end;
            }
            
            result += this.search.escapeHtml(stringValue.substring(lastIndex));
            return result;
        },

        // Wrapper method for search match detection
        hasSearchMatch(value, column) {
            if (!this.activeSearchValue || !this.activeSearchValue.trim()) {
                return false;
            }
            
            const formattedValue = this.formatCellValue(value, column);
            if (!formattedValue) return false;
            
            const formattedLower = String(formattedValue).toLowerCase();
            const words = this.search.splitSearchTerms(this.activeSearchValue);
            
            // Check if any search word matches (OR logic)
            return words.some(word => formattedLower.includes(word.toLowerCase()));
        },

        // Get color class for date values based on proximity to today
        getDateColorClass(dateValue) {
            if (!dateValue) return '';
            
            // Parse the date using the parseDate helper to handle all supported formats
            let date;
            if (dateValue instanceof Date) {
                date = dateValue;
            } else {
                date = parseDate(dateValue);
            }
            
            // Check if date is valid
            if (!date || isNaN(date.getTime())) {
                return '';
            }
            
            // Get today's date at midnight for comparison
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            
            // Set the target date to midnight for fair comparison
            const targetDate = new Date(date);
            targetDate.setHours(0, 0, 0, 0);
            
            // Calculate difference in days
            const diffTime = targetDate.getTime() - today.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            // Don't color dates more than a week in the past
            if (diffDays < -7) {
                return '';  // No coloring for dates older than a week
            }
            
            // Apply color based on proximity
            if (diffDays <= 2) {
                return 'red';  // Within 2 days (including past dates up to a week ago)
            } else if (diffDays <= 7) {
                return 'orange';  // Within 7 days
            }
            
            return '';  // No special coloring for dates more than 7 days in the future
        },
        
        getCellClass(value, column, rowIndex, colIndex) {
            let baseClass = '';
            
            // Support function-based cell classes FIRST (before autoColor)
            // This allows custom columns to override autoColor behavior
            if (typeof column.cellClass === 'function') {
                // Pass the full row data if rowIndex is provided and valid
                if (typeof rowIndex === 'number' && this.data && this.data[rowIndex]) {
                    const customClass = column.cellClass(value, this.data[rowIndex]);
                    if (customClass) return customClass; // Return early if custom class provided
                } else {
                    const customClass = column.cellClass(value);
                    if (customClass) return customClass; // Return early if custom class provided
                }
            }
            
            // Support object-based cell classes
            if (typeof column.cellClass === 'object') {
                for (const [className, condition] of Object.entries(column.cellClass)) {
                    if (typeof condition === 'function' && condition(value)) {
                        return className;
                    }
                    if (value === condition) {
                        return className;
                    }
                }
            }
            
            // Centralized autoColor logic for number columns
            // Only apply if value is not null/undefined
            if (column.autoColor && column.format === 'number' && value !== null && value !== undefined) {
                if (value <= 0) baseClass = 'red';
                else if (value < 5) baseClass = 'orange';
            }
            
            // Centralized autoColor logic for date columns
            if (column.autoColor && column.format === 'date') {
                const cellClass = this.getDateColorClass(value);
                if (cellClass) baseClass = cellClass;
            }
            
            // Add dirty class if cell is dirty
            if (this.dirtyCells[rowIndex] && this.dirtyCells[rowIndex][colIndex]) {
                baseClass = (baseClass ? baseClass + ' ' : '') + 'dirty';
            }
            // Add dirty class if nested table in this cell is dirty
            if (this.nestedTableDirtyCells[rowIndex] && this.nestedTableDirtyCells[rowIndex][colIndex]) {
                baseClass = (baseClass ? baseClass + ' ' : '') + 'dirty';
            }
            return baseClass;
        },
        
        getColumnWidth(column) {
            return column.width ? `${column.width}px` : 'auto';
        },
        getColumnFont(column) {
            return column.font ? 'font-' + column.font : '';
        },
        handleCellEdit(rowIndex, colIndex, value) {
            const now = Date.now();
            const timeSinceLastEdit = this.lastEditTimestamp ? now - this.lastEditTimestamp : Infinity;
            
            // Create new snapshot if:
            // 1. No snapshot captured yet (!hasUndoCaptured)
            // 2. More than 5 seconds since last edit (timeSinceLastEdit >= 5000)
            if ((!this.hasUndoCaptured || timeSinceLastEdit >= 5000) && this.appContext?.currentPath) {
                // Clear previous capture to force new snapshot
                undoRegistry.clearCurrentEditCapture();
                const routeKey = this.appContext.currentPath.split('?')[0];
                undoRegistry.capture(this.data, routeKey, {
                    type: 'cell-edit',
                    cellInfo: { rowIndex, colIndex },
                    preventDuplicates: true
                });
                this.hasUndoCaptured = true;
            }
            
            // Update last edit timestamp
            this.lastEditTimestamp = now;
            
            this.$emit('cell-edit', rowIndex, colIndex, value);
            // Dirty check for single cell
            if (!this.dirtyCells[rowIndex]) this.dirtyCells[rowIndex] = {};
            const originalValue = this.originalData[rowIndex]?.[this.columns[colIndex].key];
            if (value !== originalValue) {
                this.dirtyCells[rowIndex][colIndex] = true;
            } else {
                delete this.dirtyCells[rowIndex][colIndex];
            }
            this.checkDirtyCells();
        },
        handleCellFocus(rowIndex, colIndex, event) {
            // No undo capture on focus - only capture when user starts typing in handleCellEdit
        },
        handleCellBlur(rowIndex, colIndex, event) {
            // Clear flags when cell loses focus (enables new snapshot on next focus+edit)
            this.hasUndoCaptured = false;
            this.lastEditTimestamp = null;
            undoRegistry.clearCurrentEditCapture();
        },
        compareAllCellsDirty() {
            // Compare all cells in data vs originalData and update dirtyCells
            this.dirtyCells = {};
            if (!Array.isArray(this.data) || !Array.isArray(this.originalData)) return;
            this.data.forEach((row, rowIndex) => {
                const originalRow = this.originalData[rowIndex];
                // Treat undefined originalRow as an object with all nulls for dirty checking
                this.columns.forEach((column, colIndex) => {
                    const key = column.key;
                    if (column.editable) {
                        const currentValue = row[key];
                        // If originalRow is undefined, treat as null
                        const originalValue = originalRow ? originalRow[key] : null;
                        if (currentValue !== originalValue) {
                            if (!this.dirtyCells[rowIndex]) this.dirtyCells[rowIndex] = {};
                            this.dirtyCells[rowIndex][colIndex] = true;
                        }
                    }
                });
                
                // Always check MetaData and EditHistory columns for changes, even though they're hidden
                // Use a special column index (-1) to track these hidden column changes
                ['MetaData'].forEach(hiddenKey => {
                    if (row && row.hasOwnProperty(hiddenKey)) {
                        const currentValue = row[hiddenKey];
                        const originalValue = originalRow ? originalRow[hiddenKey] : null;
                        // Compare values (handle both string and object comparisons)
                        const isDifferent = currentValue !== originalValue;
                        if (isDifferent) {
                            if (!this.dirtyCells[rowIndex]) this.dirtyCells[rowIndex] = {};
                            // Use -1 as a sentinel column index for hidden metadata columns
                            this.dirtyCells[rowIndex][-1] = true;
                        }
                    }
                });
            });
            this.checkDirtyCells();
        },
        // Called by slot from nested TableComponent
        handleInnerTableDirty(isDirty, rowIndex, colIndex) {
            if (!this.nestedTableDirtyCells[rowIndex]) this.nestedTableDirtyCells[rowIndex] = {};
            if (isDirty) {
                this.nestedTableDirtyCells[rowIndex][colIndex] = true;
            } else {
                delete this.nestedTableDirtyCells[rowIndex][colIndex];
                if (Object.keys(this.nestedTableDirtyCells[rowIndex]).length === 0) {
                    delete this.nestedTableDirtyCells[rowIndex];
                }
            }
            this.checkDirtyCells();
        },
        checkDirtyCells() {
            // If any cell is dirty, allow save event
            const hasDirtyCell = Object.keys(this.dirtyCells).some(row =>
                Object.keys(this.dirtyCells[row]).length > 0
            );
            // If any nested table cell is dirty, allow save event
            const hasNestedDirty = Object.keys(this.nestedTableDirtyCells).some(row =>
                Object.keys(this.nestedTableDirtyCells[row]).length > 0
            );
            this.allowSaveEvent = hasDirtyCell || hasNestedDirty;
        },
        handleSave() {
            this.$emit('on-save');
            // After save, reset dirty state
            this.dirtyCells = {};
            this.nestedTableDirtyCells = {}; // <-- clear nested dirty state on save
            this.allowSaveEvent = false;
        },
        handleRowMove() {
            this.$emit('row-move');
        },
        handleHamburgerMenu() {
            // Show the hamburger menu modal directly
            if (this.hamburgerMenuComponent) {
                this.$modal.custom(
                    this.hamburgerMenuComponent.components,
                    { 
                        ...this.hamburgerMenuComponent.props,
                        modalClass: 'hamburger-menu'
                    },
                    this.title || 'Menu'
                );
            }
        },
        
        handleUndo() {
            if (this.canUndo) {
                undoRegistry.undo();
            }
        },
        
        handleRedo() {
            if (this.canRedo) {
                undoRegistry.redo();
            }
        },
        
        handleDragHandleMouseDown(rowIndex, event) {
            // Only respond to left mouse button
            if (event.button !== 0) return;
            
            // Ensure this is a drag handle
            if (!event.target.classList.contains('row-drag-handle')) return;
            
            this.clickState.isMouseDown = true;
            this.clickState.startRowIndex = rowIndex;
            this.clickState.startTime = Date.now();
            this.clickState.startX = event.clientX;
            this.clickState.startY = event.clientY;
            this.clickState.hasMoved = false;
            
            // Set up long click timer (800ms)
            this.clickState.longClickTimer = setTimeout(() => {
                if (this.clickState.isMouseDown && !this.clickState.hasMoved) {
                    // Capture selection state before multiselection starts
                    const routeKey = this.appContext?.currentPath?.split('?')[0];
                    if (routeKey) {
                        undoRegistry.capture(this.data, routeKey, { 
                            type: 'multi-selection',
                            selectionState: tableRowSelectionState
                        });
                    }
                    
                    // Long click: add row to selection and enable multi-selection mode
                    tableRowSelectionState.addRow(rowIndex, this.data, this.dragId);
                    this.clickState.isMultiSelecting = true;
                    this.clickState.lastHoveredRowIndex = rowIndex;
                    this.clickState.longClickTimer = null;
                }
            }, 700);
            
            // Add global mouse move and up listeners
            document.addEventListener('mousemove', this.handleGlobalMouseMove);
            document.addEventListener('mouseup', this.handleGlobalMouseUp);
            
            // Prevent text selection
            event.preventDefault();
        },
        
        handleDragHandleTouchStart(rowIndex, event) {
            // Extract touch coordinates from the first touch point
            const touch = event.touches[0];
            if (!touch) return;
            
            // Ensure this is a drag handle
            if (!event.target.classList.contains('row-drag-handle')) return;
            
            this.clickState.isMouseDown = true;
            this.clickState.startRowIndex = rowIndex;
            this.clickState.startTime = Date.now();
            this.clickState.startX = touch.clientX;
            this.clickState.startY = touch.clientY;
            this.clickState.hasMoved = false;
            
            // Set up long click timer (800ms)
            this.clickState.longClickTimer = setTimeout(() => {
                if (this.clickState.isMouseDown && !this.clickState.hasMoved) {
                    // Capture selection state before multiselection starts
                    const routeKey = this.appContext?.currentPath?.split('?')[0];
                    if (routeKey) {
                        undoRegistry.capture(this.data, routeKey, { 
                            type: 'multi-selection',
                            selectionState: tableRowSelectionState
                        });
                    }
                    
                    // Long touch: add row to selection and enable multi-selection mode
                    tableRowSelectionState.addRow(rowIndex, this.data, this.dragId);
                    this.clickState.isMultiSelecting = true;
                    this.clickState.lastHoveredRowIndex = rowIndex;
                    this.clickState.longClickTimer = null;
                }
            }, 700);
            
            // Add global touch move and end listeners
            document.addEventListener('touchmove', this.handleGlobalTouchMove);
            document.addEventListener('touchend', this.handleGlobalTouchEnd);
            document.addEventListener('touchcancel', this.handleGlobalTouchEnd);
            
            // Prevent text selection and default touch behavior
            event.preventDefault();
        },
        
        handleGlobalMouseMove(event) {
            if (!this.clickState.isMouseDown) return;
            
            const deltaX = Math.abs(event.clientX - this.clickState.startX);
            const deltaY = Math.abs(event.clientY - this.clickState.startY);
            const moveDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

            // If moved more than 8 pixels
            if (moveDistance > 8 && !this.clickState.hasMoved) {
                this.clickState.hasMoved = true;
                
                // Cancel long click timer
                if (this.clickState.longClickTimer) {
                    clearTimeout(this.clickState.longClickTimer);
                    this.clickState.longClickTimer = null;
                }
                
                // If not in multi-selection mode, handle normal drag logic
                if (!this.clickState.isMultiSelecting) {
                    // If dragged row is not in selection, replace entire selection with this row
                    if (!tableRowSelectionState.hasRow(this.data, this.clickState.startRowIndex)) {
                        // Capture selection state before clearing for immediate drag
                        const routeKey = this.appContext?.currentPath?.split('?')[0];
                        if (routeKey) {
                            undoRegistry.capture(this.data, routeKey, { 
                                type: 'drag-start-selection',
                                selectionState: tableRowSelectionState
                            });
                        }
                        
                        tableRowSelectionState.clearAll();
                        tableRowSelectionState.addRow(this.clickState.startRowIndex, this.data, this.dragId);
                    }
                    
                    // Start drag if table is draggable and we have selections
                    if (this.draggable && tableRowSelectionState.getTotalSelectionCount() > 0) {
                        tableRowSelectionState.startDrag(this.data, this.dragId);
                        this.unselectAllEditableCells();
                    }
                }
            }
            
            // Handle multi-selection mode
            if (this.clickState.isMultiSelecting && this.clickState.hasMoved) {
                // Find the row index at current mouse position
                const currentRowIndex = this.getRowIndexAtPosition(event.clientY);
                
                if (currentRowIndex !== null && currentRowIndex !== this.clickState.lastHoveredRowIndex) {
                    // Update the selection range
                    this.selectRowRange(this.clickState.startRowIndex, currentRowIndex);
                    this.clickState.lastHoveredRowIndex = currentRowIndex;
                }
            }
        },
        handleGlobalMouseUp(event) {
            if (!this.clickState.isMouseDown) return;
            // Clear local drop target after drag completion

            this.clearDropTarget();

            if (tableRowSelectionState.findingDropTargets) {
                // Clean up and exit early - don't process click logic when dragging
                this.resetClickState();
                return;
            }

            // Check if mouse up is on the same drag handle that started the interaction
            const targetHandle = event.target.closest('.row-drag-handle');
            const startHandle = document.elementFromPoint(this.clickState.startX, this.clickState.startY);
            
            // Special case: if we were multi-selecting, preserve the selection and exit
            if (this.clickState.isMultiSelecting) {
                // Set global timestamp to prevent handleOutsideClick from clearing selection
                tableRowSelectionState.lastMultiSelectEndTime = Date.now();
                this.resetClickState();
                return;
            }

            // Only process click logic if mouse up is on the same handle (or close enough)
            if (targetHandle && startHandle && targetHandle === startHandle) {
                // Clear long click timer
                if (this.clickState.longClickTimer) {
                    clearTimeout(this.clickState.longClickTimer);
                    this.clickState.longClickTimer = null;
                }
                
                // Short click logic (only if no movement occurred)
                if (!this.clickState.hasMoved && !this.clickState.isMultiSelecting) {
                    // Capture selection state before toggle
                    const routeKey = this.appContext?.currentPath?.split('?')[0];
                    if (routeKey) {
                        undoRegistry.capture(this.data, routeKey, { 
                            type: 'selection-toggle',
                            selectionState: tableRowSelectionState
                        });
                    }
                    
                    // Toggle selection state of clicked row
                    tableRowSelectionState.toggleRow(this.clickState.startRowIndex, this.data, this.dragId);
                }
            }
            
            // Clean up
            this.resetClickState();
        },
        
        handleGlobalTouchMove(event) {
            if (!this.clickState.isMouseDown) return;
            
            // Get the first touch point
            const touch = event.touches[0];
            if (!touch) return;
            
            const deltaX = Math.abs(touch.clientX - this.clickState.startX);
            const deltaY = Math.abs(touch.clientY - this.clickState.startY);
            const moveDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

            // If moved more than 8 pixels
            if (moveDistance > 8 && !this.clickState.hasMoved) {
                this.clickState.hasMoved = true;
                
                // Cancel long click timer
                if (this.clickState.longClickTimer) {
                    clearTimeout(this.clickState.longClickTimer);
                    this.clickState.longClickTimer = null;
                }
                
                // If not in multi-selection mode, handle normal drag logic
                if (!this.clickState.isMultiSelecting) {
                    // If dragged row is not in selection, replace entire selection with this row
                    if (!tableRowSelectionState.hasRow(this.data, this.clickState.startRowIndex)) {
                        // Capture selection state before clearing for immediate drag
                        const routeKey = this.appContext?.currentPath?.split('?')[0];
                        if (routeKey) {
                            undoRegistry.capture(this.data, routeKey, { 
                                type: 'drag-start-selection',
                                selectionState: tableRowSelectionState
                            });
                        }
                        
                        tableRowSelectionState.clearAll();
                        tableRowSelectionState.addRow(this.clickState.startRowIndex, this.data, this.dragId);
                    }
                    
                    // Start drag if table is draggable and we have selections
                    if (this.draggable && tableRowSelectionState.getTotalSelectionCount() > 0) {
                        tableRowSelectionState.startDrag(this.data, this.dragId);
                        this.unselectAllEditableCells();
                    }
                }
            }
            
            // Dispatch synthetic mousemove event for cross-table drop detection
            // This allows table @mousemove handlers to fire on whichever table is under the touch
            if (tableRowSelectionState.findingDropTargets) {
                const elementUnderTouch = document.elementFromPoint(touch.clientX, touch.clientY);
                const currentTable = elementUnderTouch?.closest('.dynamic-table');
                
                // Detect table transitions and dispatch mouseleave/mouseenter
                if (currentTable !== this.clickState.lastTouchTable) {
                    // Dispatch mouseleave to the previous table
                    if (this.clickState.lastTouchTable) {
                        const leaveEvent = new MouseEvent('mouseleave', {
                            clientX: touch.clientX,
                            clientY: touch.clientY,
                            bubbles: false,
                            cancelable: true
                        });
                        this.clickState.lastTouchTable.dispatchEvent(leaveEvent);
                    }
                    
                    // Dispatch mouseenter to the new table
                    if (currentTable) {
                        const enterEvent = new MouseEvent('mouseenter', {
                            clientX: touch.clientX,
                            clientY: touch.clientY,
                            bubbles: false,
                            cancelable: true
                        });
                        currentTable.dispatchEvent(enterEvent);
                    }
                    
                    // Update tracked table
                    this.clickState.lastTouchTable = currentTable;
                }
                
                // Dispatch mousemove to current element
                const syntheticEvent = new MouseEvent('mousemove', {
                    clientX: touch.clientX,
                    clientY: touch.clientY,
                    bubbles: true,
                    cancelable: true
                });
                elementUnderTouch?.dispatchEvent(syntheticEvent);
            }
            
            // Handle multi-selection mode
            if (this.clickState.isMultiSelecting && this.clickState.hasMoved) {
                // Find the row index at current touch position
                const currentRowIndex = this.getRowIndexAtPosition(touch.clientY);
                
                if (currentRowIndex !== null && currentRowIndex !== this.clickState.lastHoveredRowIndex) {
                    // Update the selection range
                    this.selectRowRange(this.clickState.startRowIndex, currentRowIndex);
                    this.clickState.lastHoveredRowIndex = currentRowIndex;
                }
            }
            
            // Prevent scrolling while dragging
            event.preventDefault();
        },
        
        handleGlobalTouchEnd(event) {
            if (!this.clickState.isMouseDown) return;
            
            // Clear local drop target after drag completion
            this.clearDropTarget();

            if (tableRowSelectionState.findingDropTargets) {
                // Clean up and exit early - don't process click logic when dragging
                this.resetClickState();
                return;
            }

            // Get the touch point that ended
            const touch = event.changedTouches[0];
            if (!touch) {
                this.resetClickState();
                return;
            }
            
            // Check if touch ended on the same drag handle that started the interaction
            const targetHandle = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.row-drag-handle');
            const startHandle = document.elementFromPoint(this.clickState.startX, this.clickState.startY);
            
            // Special case: if we were multi-selecting, preserve the selection and exit
            if (this.clickState.isMultiSelecting) {
                // Set global timestamp to prevent handleOutsideClick from clearing selection
                tableRowSelectionState.lastMultiSelectEndTime = Date.now();
                this.resetClickState();
                return;
            }

            // Only process click logic if touch ended on the same handle (or close enough)
            if (targetHandle && startHandle && targetHandle === startHandle) {
                // Clear long click timer
                if (this.clickState.longClickTimer) {
                    clearTimeout(this.clickState.longClickTimer);
                    this.clickState.longClickTimer = null;
                }
                
                // Short tap logic (only if no movement occurred)
                if (!this.clickState.hasMoved && !this.clickState.isMultiSelecting) {
                    // Capture selection state before toggle
                    const routeKey = this.appContext?.currentPath?.split('?')[0];
                    if (routeKey) {
                        undoRegistry.capture(this.data, routeKey, { 
                            type: 'selection-toggle',
                            selectionState: tableRowSelectionState
                        });
                    }
                    
                    // Toggle selection state of tapped row
                    tableRowSelectionState.toggleRow(this.clickState.startRowIndex, this.data, this.dragId);
                }
            }
            
            // Clean up
            this.resetClickState();
        },
        
        resetClickState() {
            if (this.clickState.longClickTimer) {
                clearTimeout(this.clickState.longClickTimer);
                this.clickState.longClickTimer = null;
            }
            
            this.clickState.isMouseDown = false;
            this.clickState.startRowIndex = null;
            this.clickState.startTime = null;
            this.clickState.startX = null;
            this.clickState.startY = null;
            this.clickState.hasMoved = false;
            this.clickState.isMultiSelecting = false;
            this.clickState.lastHoveredRowIndex = null;
            this.clickState.lastTouchTable = null;
            
            // Remove global listeners (both mouse and touch)
            document.removeEventListener('mousemove', this.handleGlobalMouseMove);
            document.removeEventListener('mouseup', this.handleGlobalMouseUp);
            document.removeEventListener('touchmove', this.handleGlobalTouchMove);
            document.removeEventListener('touchend', this.handleGlobalTouchEnd);
            document.removeEventListener('touchcancel', this.handleGlobalTouchEnd);
        },
        handleTableMouseEnter() {
            this.isMouseInTable = true;
            this.mouseMoveCounter = 0; // Reset counter when entering table
        },
        handleTableMouseLeave() {
            this.isMouseInTable = false;
            // Always clear drop target when leaving table
            this.clearDropTarget();
            tableRowSelectionState.clearDropTargetRegistration(this.data);
            this.lastKnownMouseX = null;
            this.lastKnownMouseY = null;
            this.mouseMoveCounter = 0; // Reset counter when leaving table
        },
        findDropTargetAtCursor() {
            // Use stored mouse position if available
            if (this.lastKnownMouseX === null || this.lastKnownMouseY === null) {
                return; // No mouse position available
            }
            
            let mouseX = this.lastKnownMouseX;
            let mouseY = this.lastKnownMouseY;
            if (this.lastKnownMouseX !== undefined && this.lastKnownMouseY !== undefined) {
                mouseX = this.lastKnownMouseX;
                mouseY = this.lastKnownMouseY;
            }
            
            // Find the table element - scope to this specific table using drag-id
            let tableEl;
            if (this.dragId) {
                tableEl = this.$el.querySelector(`table.${this.dragId}`);
            } else {
                tableEl = this.$el.querySelector('table');
            }
            if (!tableEl) return;
            
            const tableRect = tableEl.getBoundingClientRect();
            
            // Check if mouse is within table bounds
            if (mouseY < tableRect.top || mouseY > tableRect.bottom) {
                // Only clear if we're not in an active drag operation
                if (!tableRowSelectionState.findingDropTargets) {
                    this.clearDropTarget();
                }
                return;
            }
            
            // Find thead, tbody, and tfoot elements
            let thead, tbody, tfoot;
            if (this.dragId) {
                thead = tableEl.querySelector(`table.${this.dragId} > thead`);
                tbody = tableEl.querySelector(`table.${this.dragId} > tbody`);
                tfoot = tableEl.querySelector(`table.${this.dragId} > tfoot`);
            } else {
                thead = tableEl.querySelector('thead');
                tbody = tableEl.querySelector('tbody');
                tfoot = tableEl.querySelector('tfoot');
            }
            let newDropTarget = { type: null, position: null, isAbove: false };
            
            // Check header drop target
            if (thead) {
                const theadRect = thead.getBoundingClientRect();
                if (mouseY >= theadRect.top && mouseY <= theadRect.bottom) {
                    newDropTarget = { type: 'header', position: null, isAbove: false };
                }
            }
            
            // Check footer drop target
            if (tfoot && newDropTarget.type === null) {
                const tfootRect = tfoot.getBoundingClientRect();
                if (mouseY >= tfootRect.top && mouseY <= tfootRect.bottom) {
                    newDropTarget = { type: 'footer', position: null, isAbove: false };
                }
            }
            
            // Check between rows in tbody
            if (tbody && newDropTarget.type === null) {
                let rows;
                if (this.dragId) {
                    rows = tbody.querySelectorAll(`table.${this.dragId} > tbody > tr`);
                } else {
                    rows = tbody.querySelectorAll('tr');
                }
                for (let i = 0; i < rows.length; i++) {
                    const row = rows[i];
                    const rowRect = row.getBoundingClientRect();
                    
                    if (mouseY >= rowRect.top && mouseY <= rowRect.bottom) {
                        const rowHeight = rowRect.height;
                        const rowTop = rowRect.top;
                        const relativeY = mouseY - rowTop;
                        
                        // Split row into thirds if allowDropOnto is enabled
                        if (this.allowDropOnto) {
                            const topThird = rowHeight / 3;
                            const bottomThird = (rowHeight * 2) / 3;
                            
                            if (relativeY >= topThird && relativeY <= bottomThird) {
                                // Middle third - check if target row is eligible for drop-onto
                                const currentVisibleRow = this.visibleRows[i];
                                const targetIndex = currentVisibleRow ? currentVisibleRow.idx : i;
                                const targetRow = this.data[targetIndex];
                                
                                // Don't allow drop onto if:
                                // 1. Any selected row is a group master
                                // 2. Target row is a group child (in-group)
                                // 3. Target row is an empty placeholder (data array is empty or row has class 'empty-drop-target')
                                // 4. Target row is currently selected
                                // 5. Target row is marked for deletion
                                const hasGroupMasterSelected = tableRowSelectionState.hasAnyGroupMaster();
                                const isEmptyPlaceholder = !this.data || this.data.length === 0 || row.classList.contains('empty-drop-target');
                                const isGroupChild = this.isRowInGroup(targetIndex);
                                const isTargetSelected = tableRowSelectionState.hasRow(this.data, targetIndex);
                                const isMarkedForDeletion = this.isRowMarkedForDeletion(targetRow);
                                
                                if (!hasGroupMasterSelected && !isGroupChild && !isEmptyPlaceholder && !isTargetSelected && !isMarkedForDeletion) {
                                    newDropTarget = {
                                        type: 'onto',
                                        targetIndex: targetIndex
                                    };
                                    //console.log('Drop ONTO target found:', newDropTarget, 'visual index:', i, 'mouseY:', mouseY, 'rowRect:', rowRect);
                                    break;
                                }
                                // If any condition fails, fall through to between logic below
                            }
                        }
                        
                        // Top or bottom third (or allowDropOnto is false) - normal between behavior
                        const midpoint = rowRect.top + rowRect.height / 2;
                        const isAbove = mouseY < midpoint;
                        
                        // Map visual row index to actual data position
                        // visibleRows contains { row, idx } where idx is the actual data index
                        let targetIndex;
                        if (isAbove) {
                            // Insert before this row
                            if (i === 0) {
                                targetIndex = 0; // Insert at beginning
                            } else {
                                // Find the data index of the previous visible row and add 1
                                const prevVisibleRow = this.visibleRows[i - 1];
                                targetIndex = prevVisibleRow ? prevVisibleRow.idx + 1 : 0;
                            }
                        } else {
                            // Insert after this row
                            const currentVisibleRow = this.visibleRows[i];
                            targetIndex = currentVisibleRow ? currentVisibleRow.idx + 1 : this.data.length;
                        }
                        
                        // Check if a group master is selected and this position would split a group
                        const hasGroupMasterSelected = tableRowSelectionState.hasAnyGroupMaster();
                        if (hasGroupMasterSelected && this.wouldSplitGroup(targetIndex)) {
                            // Don't allow drop between group rows
                            continue;
                        }
                        
                        newDropTarget = {
                            type: 'between',
                            targetIndex: targetIndex
                        };
                        //console.log('Drop target found:', newDropTarget, 'visual index:', i, 'isAbove:', isAbove, 'mouseY:', mouseY, 'rowRect:', rowRect);
                        break;
                    }
                }
            }
            
            // Update drop target if changed
            if (this.dropTarget.type !== newDropTarget.type ||
                this.dropTarget.targetIndex !== newDropTarget.targetIndex) {
                
                this.dropTarget = newDropTarget;
                
                // Register the new drop target with global state
                if (this.dropTarget.type) {
                    tableRowSelectionState.registerDropTarget(this.data, this.dropTarget);
                }
            }
        },

        getRowIndexAtPosition(mouseY) {
            // Find which row index corresponds to the given Y position - scope to this specific table
            let rows;
            if (this.dragId) {
                rows = this.$el.querySelectorAll(`table.${this.dragId} > tbody > tr`);
                if (!rows || rows.length === 0) return null;
            } else {
                const tableEl = this.$el.querySelector('table');
                if (!tableEl) return null;
                const tbody = tableEl.querySelector('tbody');
                if (!tbody) return null;
                rows = tbody.querySelectorAll('tr');
            }
            
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const rowRect = row.getBoundingClientRect();
                
                if (mouseY >= rowRect.top && mouseY <= rowRect.bottom) {
                    // Need to map visual row index to actual data index
                    const visibleRowData = this.visibleRows[i];
                    return visibleRowData ? visibleRowData.idx : null;
                }
            }
            
            return null;
        },

        selectRowRange(startIndex, endIndex) {
            // Clear current selections for this table
            tableRowSelectionState.clearArray(this.data);
            
            // Determine the actual range (handle reverse selection)
            const minIndex = Math.min(startIndex, endIndex);
            const maxIndex = Math.max(startIndex, endIndex);
            
            // Select all rows in the range
            for (let i = minIndex; i <= maxIndex; i++) {
                if (i >= 0 && i < this.data.length) {
                    tableRowSelectionState.addRow(i, this.data, this.dragId);
                }
            }
        },
        clearDropTarget() {
            this.dropTarget = { type: null, position: null, isAbove: false };
        },
        handleTableMouseMove(event) {
            // Store last known mouse position for drop target detection
            const newX = event.clientX;
            const newY = event.clientY;
            
            // Only increment counter if mouse has actually moved
            if (this.lastKnownMouseX !== newX || this.lastKnownMouseY !== newY) {
                this.lastKnownMouseX = newX;
                this.lastKnownMouseY = newY;
                // Increment counter and check if it's the 6th move
                this.mouseMoveCounter++;
                if (this.mouseMoveCounter >= 6) {
                
                    // Only detect drop targets if dragging is active and this table can receive drops
                    if (tableRowSelectionState.findingDropTargets && this.draggable && tableRowSelectionState.dragId == this.dragId) {
                        this.mouseMoveCounter = 0; // Reset counter
                        this.findDropTargetAtCursor();
                    }
                }
            }
        },
        
        handleTableTouchStart(event) {
            // Treat touch start similar to mouse enter - indicates finger is in table
            this.isMouseInTable = true;
            this.mouseMoveCounter = 0;
        },
        
        handleTableTouchEnd(event) {
            // Don't clear drop targets if we're in the middle of a drag operation
            // The global touch end handler will handle that
            if (tableRowSelectionState.findingDropTargets) {
                return;
            }
            
            // Treat touch end similar to mouse leave - indicates finger left table
            this.isMouseInTable = false;
            // Always clear drop target when leaving table (if not dragging)
            this.clearDropTarget();
            tableRowSelectionState.clearDropTargetRegistration(this.data);
            this.lastKnownMouseX = null;
            this.lastKnownMouseY = null;
            this.mouseMoveCounter = 0;
        },
        
        updateAllEditableCells() {
            // Set contenteditable text for all editable cells to match data (only on mount or new row)
            if (!Array.isArray(this.data)) return; // <-- guard against null/undefined
            this.data.forEach((row, rowIndex) => {
                if (!row) return; // Skip undefined rows
                this.columns.forEach((column, colIndex) => {
                    if (column.editable) {
                        const refName = 'editable_' + rowIndex + '_' + colIndex;
                        const cell = this.$refs[refName];
                        const value = row[column.key] || '';
                        if (cell && cell instanceof HTMLElement) {
                            // Only update if cell is not focused
                            if (document.activeElement !== cell) {
                                cell.textContent = value;
                            }
                        } else if (Array.isArray(cell)) {
                            cell.forEach(el => {
                                if (el instanceof HTMLElement && document.activeElement !== el) {
                                    el.textContent = value;
                                }
                            });
                        }
                    }
                });
            });
        },
        unselectAllEditableCells() {
            // Remove focus from any editable cell. get editable cells by searching dom for contenteditable=true
            const editableCells = this.$el.querySelectorAll('[contenteditable="true"]');
            editableCells.forEach(cell => {
                if (cell instanceof HTMLElement && document.activeElement === cell) {
                    cell.blur();
                }
            });
        },
        toggleRowDetails(rowIndex) {
            if (this.expandedRows.has(rowIndex)) {
                this.expandedRows.delete(rowIndex);
            } else {
                this.expandedRows.add(rowIndex);
            }
        },
        
        toggleGroupCollapse(rowIndex) {
            // Get the group ID from this row's metadata
            const row = this.data[rowIndex];
            if (!row || !row.MetaData) return;
            
            try {
                const metadata = JSON.parse(row.MetaData);
                const grouping = metadata?.grouping;
                
                // Only toggle if this is a group master
                if (grouping && grouping.isGroupMaster) {
                    if (this.collapsedGroups.has(grouping.groupId)) {
                        this.collapsedGroups.delete(grouping.groupId);
                    } else {
                        this.collapsedGroups.add(grouping.groupId);
                    }
                }
            } catch (e) {
                console.error('Error toggling group collapse:', e);
            }
        },
        
        isGroupCollapsed(rowIndex) {
            const row = this.data[rowIndex];
            if (!row || !row.MetaData) return false;
            
            try {
                const metadata = JSON.parse(row.MetaData);
                const grouping = metadata?.grouping;
                return grouping && grouping.isGroupMaster && this.collapsedGroups.has(grouping.groupId);
            } catch (e) {
                return false;
            }
        },
        
        isRowExpanded(rowIndex) {
            return this.expandedRows.has(rowIndex);
        },
        
        handleOutsideClick(event) {
            const clickedElement = event.target;
            
            // Handle clearing selections when clicking outside selected rows
            if (tableRowSelectionState.getTotalSelectionCount() > 0) {
                // Don't clear if multiselect or drag just finished (within 100ms) - check global state
                const timeSinceMultiSelect = tableRowSelectionState.lastMultiSelectEndTime 
                    ? Date.now() - tableRowSelectionState.lastMultiSelectEndTime 
                    : Infinity;
                const timeSinceDrag = tableRowSelectionState.lastDragEndTime 
                    ? Date.now() - tableRowSelectionState.lastDragEndTime 
                    : Infinity;
                    
                if (timeSinceMultiSelect < 100 || timeSinceDrag < 100) {
                    return; // Skip clearing - multiselect or drag just finished
                }
                
                // Check if click was inside any table row at all
                const clickedRow = clickedElement.closest('tr');
                const clickedTable = clickedElement.closest('table');
                
                // If not clicking inside any table, don't clear selections (keep selections for UI elements)
                if (!clickedTable && !clickedRow) {
                    return;
                }
                
                // Check if click was on a drag handle
                const clickedDragHandle = clickedElement.closest('.row-drag-handle');
                
                // Check if click was inside any selected row
                const clickedSelectedRow = clickedElement.closest('tr.selected');
                
                // Check if click was on the selection bubble
                const clickedSelectionBubble = clickedElement.closest('.selection-action-bubble');
                
                // Only clear selections if clicking inside a table on an unselected row (not drag handle, not selection bubble)
                if (!clickedDragHandle && !clickedSelectedRow && !clickedSelectionBubble && (clickedTable || clickedRow)) {
                    // Capture state before clearing for undo
                    if (tableRowSelectionState.currentRouteKey) {
                        // Get all unique arrays involved in selections
                        const selectedRows = tableRowSelectionState.getAllSelectedRows();
                        const uniqueArrays = [...new Set(selectedRows.map(r => r.sourceArray))];
                        
                        // Capture with selection state
                        undoRegistry.capture(
                            uniqueArrays,
                            tableRowSelectionState.currentRouteKey,
                            {
                                type: 'selection-toggle',
                                selectionState: tableRowSelectionState
                            }
                        );
                    }
                    
                    tableRowSelectionState.clearAll();
                }
            }
            
            // Handle closing expanded details (existing functionality)
            if (this.expandedRows.size === 0) return;
            
            // Check if the click is outside any details area
            const detailsContainer = clickedElement.closest('.details-container');
            const detailsButton = clickedElement.closest('.details-toggle');
            
            // If click is not on a details button or inside a details container, close all expanded rows
            if (!detailsContainer && !detailsButton) {
                this.expandedRows.clear();
            }
        },
        
        handleEscapeKey(event) {
            // Handle keyboard shortcuts for table interactions
            if (event.key === 'Escape') {
                let handled = false;
                
                // Close all expanded details
                if (this.expandedRows.size > 0) {
                    this.expandedRows.clear();
                    handled = true;
                }
                
                // Clear all selections
                if (tableRowSelectionState.getTotalSelectionCount() > 0) {
                    // Capture state before clearing for undo
                    if (undoRegistry.currentRouteKey) {
                        const selectedRows = tableRowSelectionState.getAllSelectedRows();
                        const uniqueArrays = [...new Set(selectedRows.map(r => r.sourceArray))];
                        
                        undoRegistry.capture(
                            uniqueArrays,
                            undoRegistry.currentRouteKey,
                            {
                                type: 'selection-toggle',
                                selectionState: tableRowSelectionState
                            }
                        );
                    }
                    
                    tableRowSelectionState.clearAll();
                    handled = true;
                }
                
                if (handled) {
                    event.preventDefault();
                }
            }
            
            // Handle Delete key - mark selected rows for deletion
            if (event.key === 'Delete' || event.key === 'Backspace') {
                if (tableRowSelectionState.getTotalSelectionCount() > 0) {
                    // Capture state before clearing for undo
                    if (undoRegistry.currentRouteKey) {
                        const selectedRows = tableRowSelectionState.getAllSelectedRows();
                        const uniqueArrays = [...new Set(selectedRows.map(r => r.sourceArray))];
                        
                        undoRegistry.capture(
                            uniqueArrays,
                            undoRegistry.currentRouteKey,
                            {
                                type: 'selection-toggle',
                                selectionState: tableRowSelectionState
                            }
                        );
                    }

                    tableRowSelectionState.markSelectedForDeletion(true);
                    tableRowSelectionState.clearAll();
                    event.preventDefault();
                }
            }
        },

        hasDetailsSearchMatch(row) {
            if (!this.activeSearchValue || !this.activeSearchValue.trim()) {
                return false;
            }
            
            // Split search term into individual words for partial matching
            const searchWords = this.search.splitSearchTerms(this.activeSearchValue);
            
            // All search words must match somewhere in the details columns (AND logic)
            return searchWords.every(word => 
                this.detailsColumns.some(column => {
                    const value = row[column.key];
                    // Skip null/undefined values to prevent matching "undefined" or "null" strings
                    return value != null && String(value).toLowerCase().includes(word.toLowerCase());
                })
            );
        },
    },
    template: html `
        <div class="dynamic-table"
            @mouseenter="handleTableMouseEnter"
            @mouseleave="handleTableMouseLeave"
            @mousemove="handleTableMouseMove"
            @touchstart="handleTableTouchStart"
            @touchend="handleTableTouchEnd"
            @touchcancel="handleTableTouchEnd"
        >
            <!-- Selection Action Bubble (outside table) -->
            <transition name="fade">
                <div v-if="shouldShowSelectionBubble" :selectedCount="selectedRowCount" class="selection-action-bubble" :style="selectionBubbleStyle">
                    <button v-if="newRow && hasConsecutiveSelection" @click="handleAddRowAbove" class="button-symbol white" title="Add Row Above">+</button>
                    <button @click="handleDeleteSelected" :class="['button-symbol', areAllSelectedMarkedForDeletion ? 'green' : 'red']" title="Delete Selected">🗙</button>
                    <button @click="handleMoreOptions" class="button-symbol blue" title="More Options">☰</button>
                    <button v-if="newRow && hasConsecutiveSelection" @click="handleAddRowBelow" class="button-symbol white" title="Add Row Below">+</button>
                    <slot
                        name="selection-actions"
                        :selectedRows="getSelectedRows()"
                        :selectedIndices="getSelectedRowIndices()"
                    >
                        <!-- Default content if no slot provided -->
                    </slot>
                </div>
            </transition>
            
            <!-- Error State -->
            <div key="error-state" v-if="error" class="content-header red">
                <span>Error: {{ error }}</span>
            </div>

            <div key="content-header" v-if="showHeader && (title || showRefresh || showSearch)" :class="['content-header', theme]">
                <slot 
                    name="header-area"
                ></slot>
                <div v-if="showNewRowButton || showSaveButton || showRefresh || hamburgerMenuComponent || showSearch" :class="{'button-bar': showNewRowButton || showSaveButton || showRefresh || showSearch}">
                    <div v-if="showSearch" class="input-container">
                        <input
                            type="text"
                            v-model="search.searchValue.value"
                            @blur="search.handleBlur"
                            @keydown.esc="search.clearSearch"
                            placeholder="Find..."
                            class="search-input"
                        />
                        <button
                            v-if="search.searchValue.value"
                            @mousedown="search.clearSearch"
                            class="column-button"
                            title="Clear search"
                        >
                            🗙
                        </button>
                    </div>
                    <button
                        v-if="showNewRowButton"
                        @click="$emit('new-row')"
                        :disabled="isLoading"
                        :class="theme"
                    >
                        New Item
                    </button>
                    <button
                        v-if="showSaveButton || allowSaveEvent"
                        @click="handleSave"
                        :disabled="isLoading || !allowSaveEvent"
                        class="save-button green"
                    >
                        Save
                    </button>
                    <button 
                        v-if="showRefresh" 
                        @click="handleRefresh" 
                        :disabled="isLoading" 
                        :class="'refresh-button ' + (allowSaveEvent ? 'red' : '')"
                    >
                        {{ isLoading ? 'Loading...' : (allowSaveEvent ? 'Discard' : 'Refresh') }}
                    </button>
                    <button
                        v-if="hasEditableColumns"
                        @click="handleUndo"
                        :disabled="!canUndo"
                        class="button-symbol white"
                        title="Undo"
                    >
                        ⮢
                    </button>
                    <button
                        v-if="hasEditableColumns"
                        @click="handleRedo"
                        :disabled="!canRedo"
                        class="button-symbol white"
                        title="Redo"
                    >
                        ⮣
                    </button>
                    <button
                        v-if="hamburgerMenuComponent"
                        @click="handleHamburgerMenu"
                        class="button-symbol white"
                    >
                        ☰
                    </button>
                </div>
            </div>
            
            <!-- Loading/Analysis Progress Indicator -->
            <LoadingBarComponent
                :key="key + 'loading-progress'"
                v-if="showHeader"
                :is-loading="isLoading"
                :is-analyzing="isAnalyzing"
                :percent-complete="loadingProgress"
            />
            
            <!-- Data Table (always render if draggable, even when empty) -->
            <div key="data-table" v-if="(data && data.length > 0) || (draggable && !isLoading)" :class="'table-wrapper' + (theme ? ' ' + theme : '')">
                <table :class="{ editing: hasEditableColumns, [dragId]: dragId }">
                    <colgroup>
                        <col v-if="draggable" :style="{ width: '20px' }" />
                        <col v-for="(column, colIdx) in visibleColumns" 
                            :key="column.key"
                            :style="column.width ? 'width:' + column.width + 'px' : ''"
                            :class="column.columnClass || ''"
                        />
                        <col v-if="allowDetails" />
                    </colgroup>
                    <thead :class="{ [theme]: true, 'drop-target-header': dropTarget?.type === 'header' }">
                        <tr>
                            <th v-if="draggable" class="spacer-cell"></th>
                            <th 
                                v-for="(column, colIdx) in visibleColumns" 
                                :key="column.key"
                                :class="getColumnFont(column)"
                                :title="column.title || column.label"
                            >
                                <div>
                                    <span>{{ column.label }}</span>
                                    <button 
                                        v-if="isColumnSortable(column)"
                                        @click="handleSort(column.key)"
                                        :class="'column-button ' + (sortColumn === column.key ? 'active' : '')"
                                    >
                                        {{ getSortIcon(column.key) || '⭥' }}
                                    </button>
                                    <button 
                                        v-if="column.allowHide"
                                        @click="handleHideColumn(column.key)"
                                        class="column-button"
                                        title="Hide this column"
                                    >
                                        🗙
                                    </button>
                                </div>
                            </th>
                            <th v-if="allowDetails" class="details-header" style="font-size: 20px; line-height: 1em;" title="Details">&#9432;</th>
                        </tr>
                    </thead>
                    <tbody>
                        <template v-for="({ row, idx }, visibleIdx) in visibleRows" :key="idx">
                            <tr 
                                :data-visible-idx="visibleIdx"
                                :class="[
                                    {
                                        'dragging': isRowDragging(idx),
                                        'drag-over': false,
                                        'selected': hasEditableColumns && isRowSelected(idx),
                                        'analyzing': isRowAnalyzing(idx),
                                        'marked-for-deletion': isRowMarkedForDeletion(row),
                                        'in-group': isRowInGroup(idx),
                                        'is-group': isRowGroupMaster(idx),
                                        'drop-target-above': dropTarget?.type === 'between' && dropTarget?.targetIndex === visibleIdx,
                                        'drop-target-below': dropTarget?.type === 'between' && dropTarget?.targetIndex === visibleIdx + 1,
                                        'drop-target-onto': dropTarget?.type === 'onto' && dropTarget?.targetIndex === idx
                                    },
                                    getRowMetadataClass(row)
                                ]"
                            >
                                <td v-if="draggable"
                                    class="row-drag-handle"
                                    draggable="true"
                                    @mousedown="handleDragHandleMouseDown(idx, $event)"
                                    @touchstart="handleDragHandleTouchStart(idx, $event)"
                                ></td>
                                <td 
                                    v-for="(column, colIndex) in mainTableColumns" 
                                    :key="column.key"
                                    :colspan="column.colspan || 1"
                                    :class="[getCellClass(row[column.key], column, idx, colIndex)]"
                                    v-show="!hideSet.has(column.key)"
                                >
                                    <div :class="['table-cell-container', { 'search-match': hasSearchMatch(row[column.key], column) }]">
                                        <!-- Editable number input -->
                                        <slot
                                            v-if="column.editable && column.format === 'number'"
                                            :row="row"
                                            :column="column">
                                            <span class="original-value" v-if="dirtyCells[idx] && dirtyCells[idx][colIndex]">
                                                {{ formatCellValue(originalData[idx]?.[column.key], column) }} →
                                            </span>
                                            <input
                                                type="number"
                                                :value="row[column.key]"
                                                @input="handleCellEdit(idx, colIndex, $event.target.value)"
                                            />
                                        </slot>
                                        <!-- Editable text div -->
                                        <div
                                            v-else-if="column.editable"
                                            contenteditable="true"
                                            :data-row-index="idx"
                                            :data-col-index="colIndex"
                                            @input="handleCellEdit(idx, colIndex, $event.target.textContent)"
                                            @focus="handleCellFocus(idx, colIndex, $event)"
                                            @blur="handleCellBlur(idx, colIndex, $event)"
                                            class="table-edit-textarea"
                                            :class="{ 'search-match': hasSearchMatch(row[column.key], column) }"
                                            :ref="'editable_' + idx + '_' + colIndex"
                                        ></div>
                                        <!-- Non-editable content (slot) -->
                                        <slot 
                                            v-else 
                                            :row="row" 
                                            :rowIndex="idx" 
                                            :column="column"
                                            :cellRowIndex="idx"
                                            :cellColIndex="colIndex"
                                            :onInnerTableDirty="(isDirty) => handleInnerTableDirty(isDirty, idx, colIndex)"
                                        >
                                            <span v-html="highlightSearchText(row[column.key], column)"></span>
                                        </slot>
                                        
                                        <!-- Additional cell content slot (for warnings, etc.) -->
                                        <slot 
                                            name="cell-extra"
                                            :row="row" 
                                            :rowIndex="idx" 
                                            :column="column"
                                            :cellRowIndex="idx"
                                            :cellColIndex="colIndex"
                                            :isEditable="column.editable"
                                        ></slot>
                                    </div>
                                </td>
                                <td v-if="allowDetails" class="details-cell">
                                    <button 
                                        @click="toggleRowDetails(idx)"
                                        :class="['button-symbol', 'details-toggle', isRowExpanded(idx) ? 'expanded' : 'collapsed', hasDetailsSearchMatch(row) ? 'search-match' : '']"
                                    >
                                        {{ isRowExpanded(idx) ? '🗙' : '›' }}
                                    </button>
                                </td>
                            </tr>
                            
                            <!-- Expandable details row with Vue transition -->
                            <tr v-if="allowDetails" class="details-row-container">
                                <td v-if="draggable"></td>
                                <td :colspan="visibleColumns.length + (allowDetails ? 1 : 0)" class="details-container">
                                    
                                    <div v-if="isRowExpanded(idx)" class="details-content">
                                        <!-- Auto-generated details from columns marked with details: true -->
                                        <div v-if="detailsColumns.length > 0" class="auto-details">
                                            <div class="details-grid">
                                                <div 
                                                    v-for="column in detailsColumns" 
                                                    :key="column.key"
                                                    class="detail-item"
                                                >
                                                    <label>{{ column.label }}:</label>
                                                    <span v-html="highlightSearchText(row[column.key], column)"></span>
                                                </div>
                                            </div>
                                        </div>
                                        
                                        <!-- Custom slot content -->
                                        <slot 
                                            name="row-details"
                                            :row="row" 
                                            :rowIndex="idx"
                                            :isExpanded="isRowExpanded(idx)"
                                            :detailsColumns="detailsColumns"
                                        >
                                            <!-- Fallback if no details columns and no custom slot -->
                                            <div v-if="detailsColumns.length === 0" class="default-details">
                                                <h4>Row Details</h4>
                                                <pre>{{ JSON.stringify(row, null, 2) }}</pre>
                                            </div>
                                        </slot>
                                    </div>
                                </td>
                            </tr>
                        </template>
                        
                        <!-- Empty state row for draggable tables -->
                        <tr v-if="draggable && (!data || data.length === 0)" class="empty-drop-target">
                            <td class="spacer-cell"></td>
                            <td
                                :colspan="visibleColumns.length + (allowDetails ? 1 : 0)"
                                class="empty-message"
                                style="text-align: center;"
                            >
                                {{ isLoading || isAnalyzing ? loadingMessage : emptyMessage }}
                            </td>
                        </tr>
                    </tbody>
                    <tfoot v-if="newRow" :class="{ 'drop-target-footer': dropTarget?.type === 'footer' }">
                        <tr>
                            <td v-if="draggable" class="spacer-cell"></td>
                            <td 
                                :colspan="visibleColumns.length + (allowDetails ? 1 : 0)" 
                                class="new-row-button" 
                                @click="$emit('new-row')"
                            >
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        

            <!-- Sticky Header Template -->
            <table v-if="showStickyHeader" :class="{ editing: hasEditableColumns, [dragId]: dragId, 'sticky-header': true }">
                <colgroup>
                    <col v-if="draggable" :style="stickyColumnWidths[0] ? { width: stickyColumnWidths[0] + 'px' } : { width: '20px' }" />
                    <col v-for="(column, colIdx) in visibleColumns" 
                        :key="column.key"
                        :style="stickyColumnWidths[draggable ? colIdx + 1 : colIdx] ? { width: stickyColumnWidths[draggable ? colIdx + 1 : colIdx] + 'px' } : (column.width ? { width: column.width + 'px' } : {})"
                        :class="column.columnClass || ''"
                    />
                    <col v-if="allowDetails" :style="stickyColumnWidths[stickyColumnWidths.length - 1] ? { width: stickyColumnWidths[stickyColumnWidths.length - 1] + 'px' } : {}" />
                </colgroup>
                <thead :class="{ [theme]: true }">
                    <tr>
                        <th v-if="draggable" class="spacer-cell" :style="stickyColumnWidths[0] ? { width: stickyColumnWidths[0] + 'px' } : {}"></th>
                        <th 
                            v-for="(column, colIdx) in visibleColumns" 
                            :key="column.key"
                            :class="getColumnFont(column)"
                            :title="column.title || column.label"
                            :style="stickyColumnWidths[draggable ? colIdx + 1 : colIdx] ? { width: stickyColumnWidths[draggable ? colIdx + 1 : colIdx] + 'px' } : {}"
                        >
                            <div>
                                <span>{{ column.label }}</span>
                                <button 
                                    v-if="isColumnSortable(column)"
                                    @click="handleSort(column.key)"
                                    :class="'column-button ' + (sortColumn === column.key ? 'active' : '')"
                                >
                                    {{ getSortIcon(column.key) || '⭥' }}
                                </button>
                                <button 
                                    v-if="column.allowHide"
                                    @click="handleHideColumn(column.key)"
                                    class="column-button"
                                    title="Hide this column"
                                >
                                    🗙
                                </button>
                            </div>
                        </th>
                        <th v-if="allowDetails" class="details-header" style="font-size: 20px; line-height: 1em;" :style="stickyColumnWidths[stickyColumnWidths.length - 1] ? { width: stickyColumnWidths[stickyColumnWidths.length - 1] + 'px' } : {}">&#9432;</th>
                    </tr>
                </thead>
            </table>

            <!-- Loading State >
            <div key="loading-state" v-if="isLoading || isAnalyzing" class="content-footer loading-message">
                <img src="images/loading.gif" alt="..."/>
                <p>{{ loadingMessage }}</p>
            </div-->

            <!-- Data Summary -->
            <div key="data-summary" v-if="showFooter" :class="['content-footer', theme ]">
                <p v-if="isLoading || isAnalyzing" class="loading-message">{{ loadingMessage }}</p>
                <p v-else-if="visibleRows.length < data.length">Showing {{ visibleRows.length }} of {{ data.length }} item{{ data.length !== 1 ? 's' : '' }}</p>
                <p v-else-if="!data || data.length === 0" class="empty-message">{{ emptyMessage }}</p>
                <p v-else>Found {{ data.length }} item{{ data.length !== 1 ? 's' : '' }}</p>
                
                <button
                    v-if="activeSearchValue"
                    @click="search.clearSearch"
                    class="card"
                    style="width: auto;"
                    title="Clear filter"
                >
                    🗙 Clear filter
                </button>
                
                
            </div>
            <div class="content-footer red"  v-if="showFooter && allowSaveEvent"><p>There are unsaved changes in this table.</p></div>
        </div>
    `
};

