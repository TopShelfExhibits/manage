import { html, parseDate, LoadingBarComponent, NavigationRegistry, undoRegistry, setTableRowSelectionState, modalManager, readRowMetadata, writeRowMetadata } from '../../index.js';
import { useSearch, SearchBoxComponent, scrollToSearchResult } from '../../utils/useSearch.js';
import { useStickyHeader } from '../../utils/useStickyHeader.js';
import { formatValue, formatText, escapeHtml } from '../../utils/views/fieldFormat.js';
import { colorFor, rowColorFor } from '../../utils/views/viewColor.js';
import { searchWords as toSearchWords, matchRows, matchRow, valueContains, valueMatchesAny, makeHighlighter } from '../../utils/views/searchMatch.js';
import { ContentHeaderComponent } from './contentHeaderComponent.js';
import { RowDetailsComponent } from './rowDetailsComponent.js';
import { CellRenderer, DecorationCards, NumberCellInput, sanitizeCellText } from './cells.js';
import { placeDecorations } from '../../utils/views/decorations.js';
import { useBatchEdits } from '../../utils/cellEdits.js';
import { isOpaqueType } from '../../../data_management/utils/column-types.js';

// Clicks landing on these never trigger a row action (§4.8 row-trigger guards)
const ROW_TRIGGER_IGNORE = 'button, a, input, select, textarea, [contenteditable], .column-button, .card.clickable';

function normalizeItemSortWords(value) {
    return String(value)
        .toLowerCase()
        .split(/[\s\-_,./\\:;|]+/)
        .filter(Boolean);
}

/**
 * Sort key for one value, parsed once per sort (same ordering as the former pairwise compare):
 * missing values last; item type by words; two dates by time; two numbers numerically; else text.
 */
function sortKeyFor(value, column) {
    if (value === null || value === undefined) return { missing: true };
    const type = String(column.type || '').toLowerCase();
    if (type === 'item') return { item: value };
    const date = parseDate(value);
    const num = parseFloat(value);
    return { raw: value, time: date ? date.getTime() : null, num: isNaN(num) ? null : num };
}

function compareSortKeys(a, b, direction) {
    if (a.missing) return 1;
    if (b.missing) return -1;
    let comparison;
    if (a.item !== undefined || b.item !== undefined) {
        comparison = compareItemLikeValues(a.item ?? a.raw, b.item ?? b.raw);
    } else if (a.time !== null && b.time !== null) {
        comparison = a.time - b.time;
    } else if (a.num !== null && b.num !== null) {
        comparison = a.num - b.num;
    } else {
        comparison = String(a.raw).localeCompare(String(b.raw));
    }
    return direction === 'desc' ? -comparison : comparison;
}

function compareItemLikeValues(aValue, bValue) {
    const aWords = normalizeItemSortWords(aValue);
    const bWords = normalizeItemSortWords(bValue);
    const maxWords = Math.max(aWords.length, bWords.length);

    for (let i = 0; i < maxWords; i++) {
        const aWord = aWords[i];
        const bWord = bWords[i];

        if (aWord === undefined) return -1;
        if (bWord === undefined) return 1;

        const wordComparison = aWord.localeCompare(bWord, undefined, { numeric: true, sensitivity: 'base' });
        if (wordComparison !== 0) {
            return wordComparison;
        }
    }

    return String(aValue).localeCompare(String(bValue), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Root drag flag: <html class="row-dragging"> while any mounted table shows a dragging row.
 * Stylesheets key drag-time styles on it instead of :has(.dragging), which made every DOM change
 * on a large table page re-check the whole document's styles (~100ms per change at 1,000 rows).
 */
let tablesWithDraggingRows = 0;
function adjustRootDragging(delta) {
    tablesWithDraggingRows = Math.max(0, tablesWithDraggingRows + delta);
    document.documentElement.classList.toggle('row-dragging', tablesWithDraggingRows > 0);
}

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

    // Snapshot selections at drag start so drag gating stays stable during a drag session
    dragSelectionSnapshot: null,

    // Global mouse position for drag follower UI
    mouseX: null,
    mouseY: null,

    // Clipboard mode state
    clipboardMode: null,           // null | 'copy' | 'cut'
    clipboardItems: [],            // Array of { clone, original } where original is null for 'copy'
    clipboardSourceDragId: null,   // dragId to gate which tables show drop targets
    clipboardSourceRoute: null,    // route key at the time Ctrl+C/X was pressed
    _clipboardCommitting: false,   // internal guard: true while completeClipboard mutates state
    _handleClipboardKeydown: null, // bound reference to the global keydown listener

    // External clipboard interop
    activeTables: new Map(),              // dragId -> [instance, ...] of mounted draggable tables
    _appClipboardContent: null,           // last TSV string written to OS clipboard by this app
    _lastSeenExternalContent: null,       // last external clipboard string shown to the user
    externalPasteActive: false,           // mutex: only one table handles a given external paste event

    // Cache parsed row metadata by row reference and raw metadata string
    _metaParseCache: new WeakMap(),
    
    // Set active route for undo tracking
    setActiveRoute(routeKey) {
        this.currentRouteKey = routeKey;
    },



    // --- Clipboard helpers ---

    // Deep-clone a row for clipboard use, stripping runtime/deletion state.
    // Grouping is preserved so structure survives paste; group IDs are remapped by _remapCloneGroupIds.
    // JSON round-trip produces a fully plain, deep copy free of Vue proxy references
    // and shared nested-object references. AppData is excluded before serialization.
    _cloneRow(row) {
        const { AppData, ...withoutAppData } = row;
        let raw;
        try {
            raw = JSON.parse(JSON.stringify(withoutAppData));
        } catch (e) {
            raw = { ...withoutAppData };
        }
        if (raw.metadata) {
            const meta = { ...readRowMetadata(raw) };
            delete meta.deletion;
            writeRowMetadata(raw, meta);
        }
        return raw;
    },

    // After deep-cloning a set of rows for a COPY operation, replace every group ID
    // that appears in the clones with a fresh unique ID so the pasted groups are
    // structurally identical to the originals but do not share the same groupId.
    _remapCloneGroupIds(clones) {
        const idMap = new Map(); // oldGroupId -> newGroupId
        clones.forEach(clone => {
            const gid = readRowMetadata(clone).grouping?.groupId;
            if (gid && !idMap.has(gid)) {
                idMap.set(gid, `G${Date.now()}_${Math.random().toString(36).substr(2, 9)}`);
            }
        });
        if (idMap.size === 0) return;
        clones.forEach(clone => {
            const meta = readRowMetadata(clone);
            const gid = meta.grouping?.groupId;
            if (gid && idMap.has(gid)) {
                meta.grouping = { ...meta.grouping, groupId: idMap.get(gid) };
                writeRowMetadata(clone, meta);
            }
        });
    },

    // Enter clipboard mode: snapshot all selected rows across all tables and activate drop-target scanning
    startClipboard(mode, dragId, routeKey) {
        const allSelected = this.getAllSelectedRows()
            .sort((a, b) => a.index - b.index);
        if (allSelected.length === 0) return false;

        this.clipboardItems = allSelected.map(({ row }) => ({
            clone: this._cloneRow(row),
            original: mode === 'cut' ? row : null
        }));

        // For copy: remap group IDs in the clones to new unique values so that the
        // pasted group structure is independent of the originals in the source table.
        if (mode === 'copy') {
            this._remapCloneGroupIds(this.clipboardItems.map(item => item.clone));
        }

        this.clipboardMode = mode;
        this.clipboardSourceDragId = dragId;
        this.clipboardSourceRoute = routeKey;

        // Reuse findingDropTargets so all matching tables show drop target indicators
        this.findingDropTargets = true;
        this.dragId = dragId;
        this.dragTargetArray = null;
        this.currentDropTarget = null;
        this._version++;

        this._handleClipboardKeydown = this._onClipboardKeydown.bind(this);
        document.addEventListener('keydown', this._handleClipboardKeydown);
        return true;
    },

    // Global keydown handler active while clipboard mode is on
    _onClipboardKeydown(event) {
        if (event.key === 'Escape') {
            this.cancelClipboard();
            event.preventDefault();
            return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key === 'v') {
            if (this.dragTargetArray && this.currentDropTarget && this.currentDropTarget.type) {
                this.completeClipboard(this.currentDropTarget);
            }
            event.preventDefault();
        }
    },

    // Exit clipboard mode and clear all clipboard state
    cancelClipboard() {
        this.clipboardMode = null;
        this.clipboardItems = [];
        this.clipboardSourceDragId = null;
        this.clipboardSourceRoute = null;
        this.findingDropTargets = false;
        this.dragId = null;
        this.dragTargetArray = null;
        this.currentDropTarget = null;
        this.mouseX = null;
        this.mouseY = null;
        this._version++;

        if (this._handleClipboardKeydown) {
            document.removeEventListener('keydown', this._handleClipboardKeydown);
            this._handleClipboardKeydown = null;
        }
    },

    // Complete a clipboard paste at the registered drop target
    completeClipboard(dropTarget) {
        if (!this.clipboardMode || !this.clipboardItems.length || !this.dragTargetArray) {
            this.cancelClipboard();
            return false;
        }

        const isCut = this.clipboardMode === 'cut';
        // Same-route cut behaves like drag-drop: move originals without marking for deletion
        const shouldMove = isCut && this.clipboardSourceRoute === this.currentRouteKey;

        // Capture state before any mutation for undo.
        // For cross-route cut: capture the paste-side and cut-side arrays independently
        // so each route's undo stack only contains its own mutations.
        if (this.currentRouteKey) {
            if (isCut && !shouldMove) {
                const formatRoute = r => r ? r.replace(/\b\w/g, c => c.toUpperCase()) : 'another page';
                const sourceName = formatRoute(this.clipboardSourceRoute);
                const destName = formatRoute(this.currentRouteKey);
                const count = this.clipboardItems.length;

                // Paste route: only the target array. Undoing here will remove the pasted clones
                // but cannot undo the deletion-marking on the source route.
                undoRegistry.capture([this.dragTargetArray], this.currentRouteKey, {
                    type: 'drag',
                    selectionState: tableRowSelectionState,
                    undoAlert: `The removal of ${count} item(s) on ${sourceName} must be undone or redone separately.`
                });
                // Cut route: snapshot source arrays so deletion-marking can be independently undone.
                if (this.clipboardSourceRoute) {
                    const sourceArrays = [];
                    for (const selection of this.selections.values()) {
                        if (!sourceArrays.includes(selection.sourceArray)) {
                            sourceArrays.push(selection.sourceArray);
                        }
                    }
                    if (sourceArrays.length > 0) {
                        undoRegistry.capture(sourceArrays, this.clipboardSourceRoute, {
                            type: 'drag',
                            undoAlert: `The addition of ${count} item(s) on ${destName} must be undone or redone separately.`
                        });
                    }
                }
            } else {
                // Same-route cut or copy: capture all involved arrays together under this route.
                const arraysToCapture = new Set([this.dragTargetArray]);
                for (const selection of this.selections.values()) {
                    arraysToCapture.add(selection.sourceArray);
                }
                undoRegistry.capture(Array.from(arraysToCapture), this.currentRouteKey, {
                    type: 'drag',
                    selectionState: tableRowSelectionState
                });
            }
        }

        // For same-route cut: build a map from sourceArray → [{row, index}] using the
        // original object references still in this.selections.
        let clipboardBySource = null;
        if (shouldMove) {
            const sourceArraysSet = new Set();
            for (const selection of this.selections.values()) {
                sourceArraysSet.add(selection.sourceArray);
            }
            clipboardBySource = new Map();
            for (const item of this.clipboardItems) {
                if (!item.original) continue;
                for (const arr of sourceArraysSet) {
                    const idx = arr.indexOf(item.original);
                    if (idx !== -1) {
                        if (!clipboardBySource.has(arr)) clipboardBySource.set(arr, []);
                        clipboardBySource.get(arr).push({ row: item.original, index: idx });
                        break;
                    }
                }
            }
        }

        // Handle 'onto' drop: group rows under the target row
        if (dropTarget.type === 'onto') {
            const targetIndex = dropTarget.targetIndex;
            const targetItem = this.dragTargetArray[targetIndex];
            if (!targetItem) {
                this.cancelClipboard();
                return false;
            }

            const existingGrouping = this._getRowGrouping(targetIndex, this.dragTargetArray);
            const groupId = existingGrouping?.groupId || `G${Date.now()}`;

            if (!existingGrouping?.isGroupMaster) {
                const meta = readRowMetadata(targetItem);
                meta.grouping = { groupId, isGroupMaster: true };
                writeRowMetadata(targetItem, meta);
            }

            let rowsToInsert;
            if (shouldMove) {
                // Remove originals from their source arrays, then insert
                rowsToInsert = [];
                for (const [sourceArray, entries] of clipboardBySource) {
                    const sortedAsc = entries.sort((a, b) => a.index - b.index);
                    const sortedDesc = [...sortedAsc].reverse();
                    sortedAsc.forEach(e => { delete e.row.AppData; rowsToInsert.push(e.row); });
                    sortedDesc.forEach(e => {
                        if (e.index < sourceArray.length) sourceArray.splice(e.index, 1);
                    });
                }
            } else {
                // Cross-route cut or copy: use clones; mark originals for deletion if cut
                rowsToInsert = this.clipboardItems.map(item => item.clone);
                if (isCut) {
                    for (const item of this.clipboardItems) {
                        if (item.original) {
                            const meta = readRowMetadata(item.original);
                            meta.deletion = { marked: true };
                            writeRowMetadata(item.original, meta);
                        }
                    }
                }
            }

            rowsToInsert.forEach(row => {
                const meta = readRowMetadata(row);
                meta.grouping = { groupId, isGroupMaster: false };
                writeRowMetadata(row, meta);
            });

            // Re-find target index after possible removals (same-array removal shifts indices)
            const newTargetIndex = this.dragTargetArray.indexOf(targetItem);
            this.dragTargetArray.splice(newTargetIndex + 1, 0, ...rowsToInsert);

            const targetDragId = this.clipboardSourceDragId;
            this._clipboardCommitting = true;
            this.clearAll();
            rowsToInsert.forEach(row => {
                const idx = this.dragTargetArray.indexOf(row);
                if (idx !== -1) this.addRow(idx, this.dragTargetArray, targetDragId);
            });
            this._clipboardCommitting = false;

            this.lastDragEndTime = Date.now();
            this.cancelClipboard();
            return true;
        }

        // Determine insertion position for between/header/footer drops
        let insertPosition;
        if (dropTarget.type === 'header') {
            insertPosition = 0;
        } else if (dropTarget.type === 'between') {
            insertPosition = dropTarget.targetIndex;
        } else {
            this.cancelClipboard();
            return false;
        }

        let finalRows;
        if (shouldMove) {
            // Same-route cut: move originals exactly like completeDrag
            finalRows = [];
            let totalRowsInserted = 0;

            for (const [sourceArray, entries] of clipboardBySource) {
                const sortedAsc = entries.sort((a, b) => a.index - b.index);
                const sortedDesc = [...sortedAsc].reverse();
                const rowsData = sortedAsc.map(e => e.row);

                rowsData.forEach(row => { delete row.AppData; });
                finalRows.push(...rowsData);

                if (sourceArray === this.dragTargetArray) {
                    // Same array: reorder (mirrors completeDrag same-array branch)
                    let adjustedInsertPosition = insertPosition + totalRowsInserted;
                    sortedDesc.forEach(e => {
                        if (e.index < sourceArray.length) {
                            sourceArray.splice(e.index, 1);
                            if (e.index < adjustedInsertPosition) adjustedInsertPosition--;
                        }
                    });
                    if (adjustedInsertPosition >= 0 && adjustedInsertPosition <= sourceArray.length) {
                        sourceArray.splice(adjustedInsertPosition, 0, ...rowsData);
                    }
                } else {
                    // Different array on same route: remove from source, insert into target
                    sortedDesc.forEach(e => {
                        if (e.index < sourceArray.length) sourceArray.splice(e.index, 1);
                    });
                    const adjustedInsertPosition = insertPosition + totalRowsInserted;
                    if (adjustedInsertPosition >= 0 && adjustedInsertPosition <= this.dragTargetArray.length) {
                        this.dragTargetArray.splice(adjustedInsertPosition, 0, ...rowsData);
                    }
                    totalRowsInserted += rowsData.length;
                }
            }
        } else {
            // Copy or cross-route cut: insert clones
            finalRows = this.clipboardItems.map(item => item.clone);
            this.dragTargetArray.splice(insertPosition, 0, ...finalRows);
            if (isCut) {
                for (const item of this.clipboardItems) {
                    if (item.original) {
                        const meta = readRowMetadata(item.original);
                        meta.deletion = { marked: true };
                        writeRowMetadata(item.original, meta);
                    }
                }
            }
        }

        const targetDragId = this.clipboardSourceDragId;
        this._clipboardCommitting = true;
        this.clearAll();
        finalRows.forEach(row => {
            const idx = this.dragTargetArray.indexOf(row);
            if (idx !== -1) this.addRow(idx, this.dragTargetArray, targetDragId);
        });
        this._clipboardCommitting = false;

        this.lastDragEndTime = Date.now();
        this.cancelClipboard();
        return true;
    },

    // --- End clipboard helpers ---
    
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

    // Read and cache parsed metadata for a row
    _getRowMetadata(row) {
        if (!row || row.metadata == null || row.metadata === '') return null;

        if (typeof row.metadata === 'object') {
            return row.metadata;
        }

        const cached = this._metaParseCache.get(row);
        if (cached && cached.raw === row.metadata) {
            return cached.parsed;
        }

        let parsed = null;
        try {
            parsed = JSON.parse(row.metadata);
        } catch (e) {
            parsed = null;
        }

        this._metaParseCache.set(row, { raw: row.metadata, parsed });
        return parsed;
    },
    
    // Helper to get all children indices of a group master
    _getGroupChildren(rowIndex, sourceArray) {
        const row = sourceArray[rowIndex];
        if (!row) return [];

        const metadata = this._getRowMetadata(row);
        if (!metadata) return [];
        
        const grouping = metadata?.grouping;
        
        // Only proceed if this row is a group master
        if (!grouping || !grouping.isGroupMaster) return [];
        
        const groupId = grouping.groupId;
        const children = [];
        
        // Find all rows with matching groupId that are NOT masters
        for (let i = 0; i < sourceArray.length; i++) {
            if (i === rowIndex) continue; // Skip the master itself
            
            const childRow = sourceArray[i];
            if (!childRow) continue;

            const childMetadata = this._getRowMetadata(childRow);
            if (!childMetadata) continue;
            
            const childGrouping = childMetadata?.grouping;
            
            if (childGrouping && childGrouping.groupId === groupId && !childGrouping.isGroupMaster) {
                children.push(i);
            }
        }
        
        return children;
    },
    
    // Shared helper to get grouping metadata from a row
    _getRowGrouping(rowIndex, sourceArray) {
        const row = sourceArray[rowIndex];
        if (!row) return null;

        const metadata = this._getRowMetadata(row);
        return metadata?.grouping || null;
    },

    // Find the index of the group master for a given groupId by scanning the array
    _findGroupMasterIndex(groupId, sourceArray) {
        for (let i = 0; i < sourceArray.length; i++) {
            const grouping = this._getRowGrouping(i, sourceArray);
            if (grouping && grouping.groupId === groupId && grouping.isGroupMaster) {
                return i;
            }
        }
        return -1;
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
            const masterIndex = this._findGroupMasterIndex(grouping.groupId, sourceArray);
            if (masterIndex !== -1 && this.hasRow(sourceArray, masterIndex)) {
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
        if (this.clipboardMode && !this._clipboardCommitting) {
            this.cancelClipboard();
            return;
        }
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
        if (this.clipboardMode && !this._clipboardCommitting) {
            this.cancelClipboard();
        }
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

    // Use drag-start snapshot when available so gating is scoped to the current drag session.
    hasGroupMasterInDragSnapshot() {
        if (Array.isArray(this.dragSelectionSnapshot) && this.dragSelectionSnapshot.length > 0) {
            for (const selection of this.dragSelectionSnapshot) {
                const grouping = this._getRowGrouping(selection.rowIndex, selection.sourceArray);
                if (grouping && grouping.isGroupMaster === true) {
                    return true;
                }
            }
            return false;
        }

        return this.hasAnyGroupMaster();
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
        
        // Get grouping metadata for both rows
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
                        const metadata = readRowMetadata(item);
                        delete metadata.grouping;
                        writeRowMetadata(item, metadata);
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
            const metadata = readRowMetadata(targetItem);
            metadata.grouping = {
                groupId: groupId,
                isGroupMaster: true
            };
            writeRowMetadata(targetItem, metadata);
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
        
        // Update dropped items metadata with grouping info
        droppedItems.forEach(droppedItem => {
            // Parse existing metadata and add/update grouping
            const metadata = readRowMetadata(droppedItem);
            metadata.grouping = {
                groupId: groupId,
                isGroupMaster: false
            };
            writeRowMetadata(droppedItem, metadata);
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
                
                // Parse existing metadata
                const metadata = readRowMetadata(row);
                
                // Set or remove deletion flag
                if (Value) {
                    metadata.deletion = { marked: true };
                } else {
                    delete metadata.deletion;
                }
                
                // Save back to metadata
                writeRowMetadata(row, metadata);
                
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
        this.dragSelectionSnapshot = Array.from(this.selections.values()).map(selection => ({
            rowIndex: selection.rowIndex,
            sourceArray: selection.sourceArray,
            dragId: selection.dragId
        }));
        
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
        
        // If dropping between rows of the same group, capture the groupId to assign after moving.
        // The drop position is respected; group membership is updated after the move.
        let splitGroupId = null;
        if (dropTarget.type === 'between' && this.wouldSplitGroup(dropTarget.targetIndex, this.dragTargetArray)) {
            const rowBefore = dropTarget.targetIndex > 0 ? this.dragTargetArray[dropTarget.targetIndex - 1] : null;
            const rowAfter = dropTarget.targetIndex < this.dragTargetArray.length ? this.dragTargetArray[dropTarget.targetIndex] : null;
            const beforeGrouping = rowBefore ? this._getRowGrouping(dropTarget.targetIndex - 1, this.dragTargetArray) : null;
            const afterGrouping = rowAfter ? this._getRowGrouping(dropTarget.targetIndex, this.dragTargetArray) : null;
            splitGroupId = beforeGrouping?.groupId || afterGrouping?.groupId || null;
            // Fall through to normal move logic — drop position is preserved
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
                    const masterIndex = this._findGroupMasterIndex(grouping.groupId, sourceArray);
                    const masterIsSelected = masterIndex !== -1 && this.hasRow(sourceArray, masterIndex);
                    
                    // Only ungroup if the master is NOT being dragged with the child
                    if (!masterIsSelected) {
                        const item = sourceArray[rowIndex];
                        if (item) {
                            // Parse existing metadata and remove only grouping
                            const metadata = readRowMetadata(item);
                            delete metadata.grouping;
                            writeRowMetadata(item, metadata);
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
            
            // If dropped into a group, assign moved rows to that group as children
            if (splitGroupId) {
                movedRows.forEach(row => {
                    const metadata = readRowMetadata(row);
                    const grouping = metadata.grouping;
                    // Don't reassign if this row is already the master of the target group
                    if (grouping && grouping.isGroupMaster && grouping.groupId === splitGroupId) return;
                    // Don't reassign a master of a different group (preserve its children's group)
                    if (grouping && grouping.isGroupMaster && grouping.groupId !== splitGroupId) return;
                    // Assign as child if not already in this group
                    if (!grouping || grouping.groupId !== splitGroupId) {
                        metadata.grouping = { groupId: splitGroupId, isGroupMaster: false };
                        writeRowMetadata(row, metadata);
                    }
                });
            }
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
    
    // --- External clipboard interop helpers ---

    registerTable(dragId, instance) {
        if (!dragId) return;
        if (!this.activeTables.has(dragId)) this.activeTables.set(dragId, []);
        const arr = this.activeTables.get(dragId);
        if (!arr.includes(instance)) arr.push(instance);
    },

    unregisterTable(dragId, instance) {
        if (!dragId) return;
        const arr = this.activeTables.get(dragId);
        if (!arr) return;
        const idx = arr.indexOf(instance);
        if (idx !== -1) arr.splice(idx, 1);
        if (arr.length === 0) this.activeTables.delete(dragId);
    },

    // Load externally-parsed rows into internal clipboard mode so the user can
    // choose a drop target via the normal Ctrl+V / drop-target UI.
    loadExternalClipboard(items, dragId) {
        if (!items || items.length === 0) return false;

        this.clipboardItems = items; // each item is { clone: rowObject, original: null }
        this.clipboardMode = 'copy';
        this.clipboardSourceDragId = dragId;
        this.clipboardSourceRoute = null; // external — no source route to undo on
        this.findingDropTargets = true;
        this.dragId = dragId;
        this.dragTargetArray = null;
        this.currentDropTarget = null;
        this._version++;

        this._handleClipboardKeydown = this._onClipboardKeydown.bind(this);
        document.addEventListener('keydown', this._handleClipboardKeydown);
        return true;
    },

    stopDrag(preserveDeletionMarkings = false) {
        this.findingDropTargets = false;
        this.dragSourceArray = null;
        this.dragTargetArray = null;
        this.dragId = null;
        this.currentDropTarget = null;
        this.dragSelectionSnapshot = null;
        this.mouseX = null;
        this.mouseY = null;
        // Keep drag state registration managed by component lifecycle
        
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

// Track the last known cursor position globally at all times so external paste can
// resolve a target table even when triggered by keyboard (no clientX/Y on the event).
document.addEventListener('mousemove', (e) => {
    tableRowSelectionState.mouseX = e.clientX;
    tableRowSelectionState.mouseY = e.clientY;
}, { passive: true });

export const TableComponent = {
    name: 'TableComponent',
    components: { LoadingBarComponent, SearchBoxComponent, ContentHeaderComponent, RowDetailsComponent, CellRenderer, DecorationCards, NumberCellInput },
    inject: ['appContext', '$modal'],
    props: {
        data: {
            type: Array,
            default: () => []
        },
        // Renderer contract (views-and-renderers-plan §4.4): the resolved view drives every column,
        // stack, width, font, colour, sticky column, details field and the default sort.
        resolved: {
            type: Object,
            required: true
        },
        // 'none' | 'batch' | 'instant' — page data, never view data
        editMode: {
            type: String,
            default: 'none'
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
        showUndoRedo: {
            type: Boolean,
            default: true
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
        rowKey: {
            type: String,
            default: null
        },
        hideGroupMembers: {
            type: Boolean,
            default: false
        },
        groupVisibilityOverride: {
            // 'open' = expand all groups, 'closed' = collapse all groups, null = no override
            type: String,
            default: null
        },
        syncSearchWithUrl: {
            type: Boolean,
            default: true
        },
        containerPath: {
            type: String,
            default: ''
        },
        navigateToPath: {
            type: Function,
            default: null
        },
        forceDetails: {
            type: Boolean,
            default: false
        },
        rowDetailsVisible: {
            type: Function,
            default: null
        },
        // Parent-owned unsaved state (e.g. a store modified outside cell editing, such as a revert
        // on a read-only table). Shows Save/Discard even when no cell is dirty.
        externalDirtyState: {
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
        showSelectionBubble: {
            type: Boolean,
            default: false
        },
        // ── Views system (DataView) ──────────────────────────────────────────
        // Primary action (ResolvedAction from resolveAction + perform(row, ctx) from DataView)
        action: {
            type: Object,
            default: null
        },
        // decorations(row, key) → Card[]; key = null is row-level
        decorations: {
            type: Function,
            default: null
        },
        decorationKeys: {
            type: Array,
            default: () => []
        },
        // ViewSelectComponent config: { views, currentId, defaultId, containerPath, navigateToPath }
        viewSelect: {
            type: Object,
            default: null
        },
        // Instant edit mode: cellState(row, key) → '' | 'unsaved' | 'failed' (utils/cellEdits.js)
        cellState: {
            type: Function,
            default: null
        },
        // cellDisabled(row, key) → '' or a reason; blocks editing a registry cell (e.g. duplicate identity)
        cellDisabled: {
            type: Function,
            default: null
        }
    },
    emits: ['refresh', 'cell-edit', 'cell-commit', 'new-row', 'inner-table-dirty', 'on-save', 'row-options', 'row-action'],
    setup(props, { emit }) {
        const appContext = Vue.inject('appContext');
        // Initialize search composable
        const search = useSearch({
            syncWithUrl: props.syncSearchWithUrl,
            navigationRegistry: NavigationRegistry,
            containerPath: props.containerPath,
            appContext
        });
        // Batch edits (utils/cellEdits.js): changed cells, revert, nested tables, undo while typing
        const batchEdits = useBatchEdits({
            rows: () => props.data,
            originalRows: () => props.originalData,
            rowKey: () => props.rowKey,
            undoRoute: () => (appContext?.currentPath ? appContext.currentPath.split('?')[0] : null),
            emitEdit: (rowIndex, key, value) => emit('cell-edit', rowIndex, key, value)
        });

        return {
            search,
            batchEdits
        };
    },
    data() {
        return {
            sortColumn: null, // Current sort column key
            sortDirection: 'asc', // Current sort direction: 'asc' or 'desc'
            isUsingDefaultSort: true,
            expandedRows: new Set(), // Track which rows are expanded for details
            overriddenGroups: new Set(), // Groups deviating from the current visibility default
            clickState: {
                isMouseDown: false,
                startRowIndex: null,
                startTime: null,
                startX: null,
                startY: null,
                longClickTimer: null,
                hasMoved: false,
                shiftKey: false, // Track shift key during mousedown for shift-select
                // Multi-selection state
                isMultiSelecting: false,
                lastHoveredRowIndex: null,
                // Shift-select anchor: the last row explicitly selected without shift
                lastAnchorRowIndex: null,
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
            showStickyHeader: false, // Controls visibility of sticky header clone
            stickyActive: false, // Controls fixed positioning of sticky wrapper
            stickyLeft: 0,
            stickyWidth: 0,
            stickyScrollLeft: 0, // Tracks horizontal scroll offset of table-wrapper for sticky clone alignment
            stickySpacerHeight: 0, // Measured height of wrapper before clone is added
            stickyColumnWidths: [], // Store actual column widths from original table
            colWidths: [], // Measured th widths for sticky column offset computation
            tableWrapperWidth: 0, // Visible width of .table-wrapper for the details panel's width
            // Runtime toggle for hiding non-matching rows; starts from the view (table.hideRowsOnSearch)
            hideRowsOnSearchLocal: this.resolved?.table?.hideRowsOnSearch !== false,
            theadActive: false // Mobile: tap-to-show column buttons toggle
        };
    },
    watch: {

        activeSearchIndex(newIndex) {
            if (newIndex == null) {
                this.$el.querySelectorAll('tr.search-active-result').forEach(r => r.classList.remove('search-active-result'));
                return;
            }
            this._scrollToActiveSearchResult();
        },
        searchMatchCount(newCount) {
            if (this.activeSearchIndex != null && newCount > 0) {
                this._scrollToActiveSearchResult();
            }
        },
        // Follows the effective search (activeSearchKey), so ineffective keystrokes do no re-matching
        activeSearchKey(newValue, oldValue) {
            const newTerm = String(newValue || '').trim();
            const oldTerm = String(oldValue || '').trim();

            // Clear selection when the search is fully cleared.
            if (!newTerm) {
                this.search.setSearchIndex(null);
                return;
            }

            if (!oldTerm || this.hideRowsOnSearchLocal) return;

            const currentIdx = this.activeSearchIndex;
            if (currentIdx == null) return;

            if (this.searchAborted) return;
            const tiers = this.searchTierKeys;
            const buildMapForTerm = (term) => {
                const words = toSearchWords(term);
                const map = new Map();
                if (words.length === 0) return map;
                let matchIdx = 0;
                for (const { row, idx } of this.visibleRows) {
                    if (!row) continue;
                    if (matchRow(row, tiers, words).matched) map.set(idx, matchIdx++);
                }
                return map;
            };

            const oldMap = buildMapForTerm(oldTerm);
            const newMap = buildMapForTerm(newTerm);
            if (newMap.size === 0) return;

            let prevDataIdx = null;
            for (const [dataIdx, matchIdx] of oldMap.entries()) {
                if (matchIdx === currentIdx - 1) {
                    prevDataIdx = dataIdx;
                    break;
                }
            }

            let targetIdx = currentIdx;
            if (prevDataIdx == null) {
                targetIdx = Math.min(currentIdx, newMap.size);
            } else {
                const newMatchIdx = newMap.get(prevDataIdx);
                if (newMatchIdx != null) {
                    targetIdx = newMatchIdx + 1;
                } else {
                    const candidates = Array.from(newMap.keys()).filter(idx => idx < prevDataIdx);
                    if (candidates.length > 0) {
                        const nearest = candidates.sort((a, b) => b - a)[0];
                        targetIdx = newMap.get(nearest) + 1;
                    } else {
                        targetIdx = 1;
                    }
                }
            }

            if (targetIdx !== currentIdx) {
                this.search.setSearchIndex(targetIdx);
            }
        },

        // Watch for changes to originalData prop and recompare the changed cells
        originalData: {
            handler() {
                this.$nextTick(() => this.recompareEdits());
            },
            deep: true
        },
        hasUnsavedEdits(val) {
            // A nested table tells its host cell whether it has changes
            this.$emit('inner-table-dirty', val);
        },
        data: {
            handler() {
                this.$nextTick(() => this._measureColWidths());
                this.$nextTick(() => this.recompareEdits());
            },
            deep: true,
            flush: 'post' // Ensure DOM updates happen after data changes
        },
        visibleColumns() {
            this.$nextTick(() => this._measureColWidths());
        },
        // Columns can become editable after mount (e.g. once a parent's lock check completes).
        // Recompare so cells edited earlier (rows restored from a store that was modified before
        // this table mounted) show as changed without waiting for another edit.
        editableColumnSignature() {
            this.$nextTick(() => this.recompareEdits());
        },
        isLoading() {
            this.$nextTick(() => this.recompareEdits());
        },
        draggable() {
            this.$nextTick(() => this.recompareEdits());
        },
        groupVisibilityOverride(val) {
            if (!val) return;
            const allGroupIds = this.data
                .map(row => tableRowSelectionState._getRowMetadata(row)?.grouping)
                .filter(g => g?.isGroupMaster)
                .map(g => g.groupId);
            if (val === 'open') {
                // Open all: in view mode, populate overrides (exceptions = open); in edit mode, clear them
                this.overriddenGroups = this.hideGroupMembers ? new Set(allGroupIds) : new Set();
            } else if (val === 'closed') {
                // Close all: in view mode, clear overrides; in edit mode, populate them
                this.overriddenGroups = this.hideGroupMembers ? new Set() : new Set(allGroupIds);
            }
        },
        hideGroupMembers() {
            // Reset per-group overrides when the default visibility mode changes
            this.overriddenGroups = new Set();
        },
        // Columns appeared or changed sortability: keep a valid sort
        columnSortSignature() {
            this.$nextTick(() => this.applyDefaultSortColumn());
        },
        // The view's default sort changed (view switch, patch): apply it
        defaultSortSignature() {
            this.applyDefaultSortColumn({ force: true });
        },
        // The view's hide-rows default changed (view switch, patch): follow it
        hideRowsByDefault(value) {
            this.hideRowsOnSearchLocal = value;
        },
        hideRowsOnSearchLocal(newValue, oldValue) {
            if (newValue === oldValue) return;
            this.syncHideRowsModeToUrl(newValue);
        },
        // Keep the root drag flag in step with this table's dragging rows
        hasDraggingRow(now, before) {
            if (now !== before) adjustRootDragging(now ? 1 : -1);
        },
        // Clear drop targets when drag ends (handles touch where mouseleave doesn't fire)
        isDraggingGlobally(isActive, wasActive) {
            if (wasActive && !isActive) {
                // Drag just ended, clear any lingering drop target highlights
                this.clearDropTarget();
            }
        },
        // Trigger sticky header recalculation when parameters change on the same route
        // (parameter-only changes don't cause component remount, unlike full route changes)
        'appContext.currentPath'(newPath, oldPath) {
            if (!newPath || !oldPath || newPath === oldPath) return;
            
            const oldBasePath = oldPath.split('?')[0];
            const newBasePath = newPath.split('?')[0];

            if (oldBasePath === newBasePath) {
                this.applyHideRowsModeFromUrl(newPath);
            }
            
            if (!this._stickyHeader) return;

            if (oldBasePath !== newBasePath) {
                // Full route change: if component is preserved (not remounted), clear stale sticky state
                this.stickyActive = false;
                this.showStickyHeader = false;
                this.stickyScrollLeft = 0;
                this.stickyTop = 0;
                this._stickyHeader.reset();
                this.$nextTick(() => this._stickyHeader.update());
                return;
            }

            // Parameter-only change on same route: recalculate
            this._stickyHeader.reset();
            this.$nextTick(() => {
                this._stickyHeader.update();
            });
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
        // True while a rendered row of this table carries the dragging class
        hasDraggingRow() {
            if (!this.isDraggingGlobally) return false;
            return this.visibleRows.some(({ idx }) => this.isRowDragging(idx));
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
            // 3. This table owns the first global selection
            // 4. This table contains at least one selected row that is currently visible
            // 4. A drag is not currently happening
            // 5. The table has editable columns (edit mode is enabled)
            if (!this.showSelectionBubble || this.selectedRowCount === 0 || !this.isBatchEditing) {
                return false;
            }
            
            // Check if an actual drag is happening (clipboard mode also sets findingDropTargets but should still show)
            if (tableRowSelectionState.findingDropTargets && !tableRowSelectionState.clipboardMode) {
                return false;
            }

            const firstSelection = tableRowSelectionState.selections.values().next().value;
            if (!firstSelection || firstSelection.sourceArray !== this.data) {
                return false;
            }

            return this.firstSelectedVisibleRowIndex !== -1;
        },
        isInClipboardMode() {
            tableRowSelectionState._version;
            return !!tableRowSelectionState.clipboardMode;
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
                if (!row) return false;
                const metadata = tableRowSelectionState._getRowMetadata(row);
                return metadata?.deletion?.marked === true;
            });
        },
        selectedGroupMasterIds() {
            // Collect unique group IDs for selected rows that are group masters in this table
            const groupIds = new Set();
            const selectedRows = this.getSelectedRows();

            selectedRows.forEach(({ data }) => {
                if (!data) return;
                const metadata = tableRowSelectionState._getRowMetadata(data);
                const grouping = metadata?.grouping;
                if (grouping?.isGroupMaster && grouping.groupId) {
                    groupIds.add(grouping.groupId);
                }
            });

            return Array.from(groupIds);
        },
        hasSelectedGroupMasters() {
            return this.selectedGroupMasterIds.length > 0;
        },
        anySelectedGroupCollapsed() {
            return this.selectedGroupMasterIds.some(groupId => this.isGroupMembersHiddenById(groupId));
        },
        shouldShowDragFollower() {
            tableRowSelectionState._version;
            return (tableRowSelectionState.findingDropTargets || tableRowSelectionState.clipboardMode) &&
                   tableRowSelectionState.mouseX !== null && 
                   tableRowSelectionState.mouseY !== null;
        },
        dragFollowerText() {
            tableRowSelectionState._version;
            const count = tableRowSelectionState.clipboardMode 
                ? tableRowSelectionState.clipboardItems.length
                : tableRowSelectionState.selections.size;
            return `${tableRowSelectionState.clipboardMode === "copy" ? 'add ' : 'move '} ${count} row${count !== 1 ? 's' : ''}`;
        },
        dragFollowerStyle() {
            tableRowSelectionState._version;
            if (!this.shouldShowDragFollower) return { display: 'none' };
            return {
                position: 'fixed',
                left: (tableRowSelectionState.mouseX) + 'px',
                top: (tableRowSelectionState.mouseY) + 'px'
            };
        },
        canCreateGroupFromSelection() {
            if (!this.newRow || this.firstSelectedVisibleRowIndex === -1) return false;

            const allSelectedRows = tableRowSelectionState.getAllSelectedRows();
            if (allSelectedRows.length === 0) return false;

            // Only allow grouping when every selected row is currently ungrouped.
            return allSelectedRows.every(({ row, index, sourceArray }) => {
                if (!row || !sourceArray) return false;
                return !tableRowSelectionState._getRowGrouping(index, sourceArray);
            });
        },
        groupToggleSymbol() {
            // If any selected group is collapsed, show expand-all action. Otherwise show collapse-all action.
            return this.anySelectedGroupCollapsed ? 'expand' : 'compress';
        },
        groupToggleTitle() {
            return this.anySelectedGroupCollapsed ? 'Show Selected Group(s)' : 'Hide Selected Group(s)';
        },
        firstSelectedVisibleRowIndex() {
            // Find the chronologically first selected row (from global selection state)
            // that belongs to this table and is currently visible.
            tableRowSelectionState._version;
            if (tableRowSelectionState.selections.size === 0 || this.visibleRows.length === 0) {
                return -1;
            }

            const visibleIndexByRowIndex = new Map();
            for (let i = 0; i < this.visibleRows.length; i++) {
                visibleIndexByRowIndex.set(this.visibleRows[i].idx, i);
            }

            for (const selection of tableRowSelectionState.selections.values()) {
                if (selection.sourceArray !== this.data) continue;

                const visibleIdx = visibleIndexByRowIndex.get(selection.rowIndex);
                if (visibleIdx !== undefined) {
                    return visibleIdx;
                }
            }

            return -1;
        },
        selectionBubbleStyle() {
            // Calculate position for the selection bubble based on the first selected row
            if (this.selectedRowCount === 0 || this.firstSelectedVisibleRowIndex === -1) {
                return { display: 'none' };
            }
            
            // Find the main data table (not the sticky header table)
            // Use .table-wrapper to ensure we get the main table, not the sticky header clone
            const table = this._rootEl()?.querySelector('.table-wrapper table');
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
            // Use parentSearchValue if provided, otherwise the composable's debounced search value
            return this.parentSearchValue || this.search.debouncedValue.value;
        },
        // The effective search as a stable string (words after the minimum term length, §4.5), from
        // the parent table's search when nested. Keystrokes that don't change the effective words
        // don't invalidate anything downstream, because an equal string doesn't trigger dependents.
        // Cells receive it as their search term (navigation cells pass it on).
        activeSearchKey() {
            return this.parentSearchValue ? toSearchWords(this.parentSearchValue).join(' ') : this.search.searchKey.value;
        },
        activeSearchWords() {
            return this.activeSearchKey ? this.activeSearchKey.split(' ') : [];
        },
        // The shared highlighter, built once per search instead of once per cell
        highlighter() {
            return makeHighlighter(this.activeSearchWords);
        },
        // The view's hide-rows default (the header shows the toggle only when hiding is the default)
        hideRowsByDefault() {
            return this.resolved?.table?.hideRowsOnSearch !== false;
        },
        theme() {
            return this.resolved?.theme || '';
        },
        /**
         * Column model from the resolved view: one entry per slot (a parent-owned stack of lines,
         * each line a list of inline keys) plus the details fields. Hidden fields never appear.
         * A column is editable when the edit mode isn't 'none' and its field is editable. An
         * editable field without a cell edits through the text cell; number fields keep their own
         * editor. (A checkbox or select field already has its type's cell: resolveView.)
         */
        columnModel() {
            const r = this.resolved;
            if (!r) return { slots: [], details: [], all: [] };
            const make = (key, extra = {}) => {
                const f = r.fieldMap.get(key) || { key };
                const s = r.style[key] || {};
                const column = {
                    ...f,
                    label: f.label ?? key,
                    width: s.width,
                    font: s.font,
                    columnClass: s.columnColor || '',
                    colorRule: s.color || null,
                    editable: this.editMode !== 'none' && !!f.editable,
                    ...extra
                };
                if (column.editable && !column.cell && column.format !== 'number') column.cell = 'text';
                return column;
            };
            const slots = r.slots.map(slot => {
                const primary = make(slot.key, { sticky: slot.sticky || null });
                // Editable fields inside a stack render read-only
                const lines = slot.lines.map((line, li) => line.map((key, ki) =>
                    (li === 0 && ki === 0) ? primary : make(key, { editable: false, stacked: true })));
                return { key: slot.key, primary, inline: lines[0].slice(1), lines: lines.slice(1), headerLines: lines };
            });
            const details = r.details.map(f => make(f.key, { details: true, editable: false }));
            return { slots, details, all: [...slots.flatMap(s => s.headerLines.flat()), ...details] };
        },
        // Keys and sortability of every column, for re-applying the default sort when they change
        columnSortSignature() {
            return this.columnModel.all.map(c => c.key + (this.isColumnSortable(c) ? '+' : '')).join('|');
        },
        slotByKey() {
            return new Map(this.columnModel.slots.map(s => [s.key, s]));
        },
        defaultSortSignature() {
            return JSON.stringify(this.resolved?.sort || []);
        },
        // Searched tiers: shown keys (incl. stacked lines) and details keys; hidden fields are never searched
        // Fields whose values are references, not text (thumbnails), are never searched
        searchTierKeys() {
            const keys = (columns) => columns.filter(c => !isOpaqueType(c.type)).map(c => c.key);
            return { shown: keys(this.visibleColumns), details: keys(this.detailsColumns) };
        },
        // One matching pass over the rows handed to the table, with the broad-search abort (§4.5)
        searchResult() {
            return matchRows(Array.isArray(this.data) ? this.data : [], this.searchTierKeys, this.activeSearchWords);
        },
        searchAborted() {
            return this.searchResult.aborted;
        },
        // True when a search filters/highlights (has words and wasn't aborted)
        searchActive() {
            return this.searchResult.active && !this.searchResult.aborted;
        },
        searchResultByRow() {
            const map = new Map();
            if (!this.searchActive) return map;
            const data = this.data || [];
            this.searchResult.results.forEach((r, i) => { if (r) map.set(data[i], r); });
            return map;
        },
        // ── Primary action (§4.8) ────────────────────────────────────────────
        effectiveAction() {
            return this.action || { kind: 'none', trigger: 'button', icon: '', label: '' };
        },
        // The action column header: the action's headerIcon, else ⓘ for details
        actionHeader() {
            const a = this.effectiveAction;
            return a.headerIcon || (a.kind === 'details' ? 'ⓘ' : '');
        },
        // Inline details expand is available (rows render the details container)
        detailsEnabled() {
            return this.effectiveAction.kind === 'details';
        },
        // Trailing sticky action cell (generalizes today's details button). Details that are
        // always shown (forceDetails) need no toggle; any other action still gets its button.
        hasActionCell() {
            const a = this.effectiveAction;
            return a.kind !== 'none' && a.trigger === 'button' && !(this.forceDetails && a.kind === 'details') && !this.actionInColumn;
        },
        // A shown column with the action cell (style cell 'action') is the primary action's button
        actionInColumn() {
            return this.columnModel.all.some(c => c.cell === 'action');
        },
        // Detail rows render for the details action, or always when details are forced open
        detailRowsEnabled() {
            return this.detailsEnabled || this.forceDetails;
        },
        hasRowTrigger() {
            const a = this.effectiveAction;
            return a.kind !== 'none' && a.trigger === 'row' && !this.isBatchEditing;
        },
        // Keys displayed in place (columns and stacked children) — decorations for other keys go row-level
        displayedKeySet() {
            return new Set(this.visibleColumns.map(c => c.key));
        },
        rowDecorMap() {
            const map = new Map();
            if (!this.decorations) return map;
            for (const { row } of this.visibleRows) {
                map.set(row, placeDecorations(this.decorations, this.decorationKeys, row, this.displayedKeySet));
            }
            return map;
        },
        // Map from data index to 0-based match index; only populated in navigate mode (rows visible, not filtered)
        searchMatchIndexMap() {
            if (!this.searchActive || this.hideRowsOnSearchLocal) return new Map();
            const results = this.searchResult.results;
            const map = new Map();
            let matchIdx = 0;
            for (const { row, idx } of this.visibleRows) {
                if (!row) continue;
                if (results[idx]) map.set(idx, matchIdx++);
            }
            return map;
        },
        // Counts individual items inside nested arrays on each row (e.g. items within packlist crates)
        searchNestedMatchCount() {
            if (!this.searchActive) return 0;
            const words = this.activeSearchWords;
            const itemMatches = (item) => words.every(w => Object.values(item).some(v => valueContains(v, w)));
            let total = 0;
            for (const { row } of this.visibleRows) {
                if (!row) continue;
                for (const arr of Object.values(row)) {
                    if (!Array.isArray(arr)) continue;
                    for (const item of arr) {
                        if (item && typeof item === 'object' && !Array.isArray(item) && itemMatches(item)) total++;
                    }
                }
            }
            return total;
        },
        searchMatchCount() {
            // Broad search aborted: the counter shows ∞
            if (this.searchAborted) return Infinity;
            // When hiding non-matching rows, count the filtered rows
            if (this.hideRowsOnSearchLocal && this.searchActive) {
                return this.visibleRows.length;
            }
            // Otherwise count nested matches or search index map
            const nested = this.searchNestedMatchCount;
            return nested > 0 ? nested : this.searchMatchIndexMap.size;
        },
        activeSearchIndex() { return this.search.searchIndex.value; },
        showSaveButton() {
            return this.isBatchEditing || !!this.newRow;
        },
        // Batch editing (edits are held until Save): changed cells, undo, row paste and selection.
        // Instant edits are written by DataView's queue instead, so none of these apply.
        isBatchEditing() {
            return this.editMode === 'batch' && this.columnModel.all.some(col => col.editable);
        },
        // The main-table columns batch edits compare ('' when not batch editing)
        editableColumnSignature() {
            if (!this.isBatchEditing) return '';
            return this.mainTableColumns.filter(c => c.editable).map(c => c.key).join('|');
        },
        // Changes in this table (or a nested one) that Save would write, or parent-owned unsaved
        // state (externalDirtyState)
        hasUnsavedEdits() {
            return this.batchEdits.hasUnsaved.value || this.externalDirtyState;
        },
        // Counteracts the clone table's translateX so sticky-end cells stay at the right edge.
        // position:sticky is disabled inside transformed ancestors, so this must be done manually.
        cloneDetailsStickyTransform() {
            const totalWidth = this.stickyColumnWidths.reduce((s, w) => s + w, 0);
            if (!totalWidth || totalWidth <= this.stickyWidth) return '';
            const offset = Math.min(0, this.stickyWidth - totalWidth + this.stickyScrollLeft);
            return 'translateX(' + offset + 'px)';
        },
        mainTableColumns() {
            // Body cells: one per slot, except that a field with colspan N covers the next N-1 slots
            // (PacklistTable's nested item header). The header keeps every slot.
            const slots = this.headerColumns;
            const clipped = [];
            let i = 0;
            while (i < slots.length) {
                const col = slots[i];
                clipped.push(col);
                i += col.colspan ? col.colspan : 1;
            }
            return clipped;
        },
        // Shown columns: every key of every slot (primary, inline and stacked lines)
        visibleColumns() {
            return this.columnModel.slots.flatMap(s => s.headerLines.flat());
        },
        // Columns to serialize when writing to the OS clipboard (visible, non-action, text columns)
        clipboardExportColumns() {
            return this.visibleColumns.filter(col => !col.key.startsWith('_') && !isOpaqueType(col.type));
        },
        // Columns eligible to receive pasted data (visible, non-action, editable, text columns)
        pasteableColumns() {
            if (!this.isBatchEditing) return [];
            return this.visibleColumns.filter(col => !col.key.startsWith('_') && col.editable && !isOpaqueType(col.type));
        },
        detailsColumns() {
            return this.columnModel.details;
        },
        // Header cells: one per slot (single header row; stacked labels share the cell)
        headerColumns() {
            return this.columnModel.slots.map(s => s.primary);
        },
        // Rows after group visibility and sorting (independent of search, so typing doesn't re-sort)
        sortedRows() {
            if (!Array.isArray(this.data)) return [];

            let filteredData = this.data
                .map((row, idx) => ({ row, idx }))
                .filter(({ row }) => row); // Only filter out null/undefined rows

            // Hide group children when the default is closed or any group has been overridden
            if (this.hideGroupMembers || this.overriddenGroups.size > 0) {
                filteredData = filteredData.filter(({ row, idx }) => {
                    const metadata = tableRowSelectionState._getRowMetadata(row);
                    const grouping = metadata?.grouping;
                    if (!grouping || grouping.isGroupMaster) return true;
                    return !this.isGroupMembersHiddenById(grouping.groupId);
                });
            }

            const sortCriteria = this.isUsingDefaultSort
                ? this.getDefaultSortCriteria()
                : this.getCurrentSortCriteria();

            if (sortCriteria.length > 0) {
                // Parse each row's sort values once (not on every comparison)
                const keyed = sortCriteria.map(c => new Map(filteredData.map(e => [e.row, sortKeyFor(e.row[c.column.key], c.column)])));
                filteredData.sort((a, b) => {
                    for (let i = 0; i < sortCriteria.length; i++) {
                        const comparison = compareSortKeys(keyed[i].get(a.row), keyed[i].get(b.row), sortCriteria[i].direction);
                        if (comparison !== 0) return comparison;
                    }
                    return 0;
                });
            }

            return filteredData;
        },
        visibleRows() {
            // Hide-rows mode filters the sorted rows; an aborted broad search leaves the set unfiltered.
            // Otherwise the sorted array is returned as is, so a search doesn't re-render every row.
            if (this.searchActive && this.hideRowsOnSearchLocal) {
                const results = this.searchResult.results;
                return this.sortedRows.filter(({ row, idx }) => row && !!results[idx]);
            }
            return this.sortedRows;
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
        },
        
        // Helper to get current route key without query params
        currentRouteKey() {
            return this.appContext?.currentPath?.split('?')[0] || null;
        }
    },
    mounted() {
        this.applyDefaultSortColumn();

        // Register route with undo system and tableRowSelectionState
        // Only top-level tables (with showHeader=true) should set the active route
        // Nested tables should not override the global route key
        if (this.appContext?.currentPath && this.showHeader) {
            const routeKey = this.appContext.currentPath.split('?')[0]; // Remove query params
            undoRegistry.setActiveRoute(routeKey);
            tableRowSelectionState.setActiveRoute(routeKey);
        }
        
        // Initialize search from URL and setup watcher if syncSearchWithUrl is enabled
        this.search.initializeFromUrl();
        this.search.setupUrlWatcher();
        this.applyHideRowsModeFromUrl();
        
        this.$nextTick(() => this.recompareEdits());
        
        // Listen for clicks outside details area to close expanded details
        document.addEventListener('click', this.handleOutsideClick);
        // Listen for keyboard shortcuts (Escape, Delete)
        document.addEventListener('keydown', this.handleEscapeKey);

        // Register draggable tables for external paste handling
        if (this.draggable) {
            tableRowSelectionState.registerTable(this.dragId, this);
            this._handleExternalPaste = this._handleExternalPaste.bind(this);
            document.addEventListener('paste', this._handleExternalPaste);
        }
        
        // Set up sticky header positioning (only for tables with showHeader enabled)
        // Nested tables with showHeader=false don't need sticky headers
        // Use requestAnimationFrame to ensure layout has been calculated before measuring
        if (this.showHeader) {
            this._stickyHeader = useStickyHeader({
                getStickyEl: () => this._rootEl()?.querySelector('.sticky-header-wrapper'),
                // .sticky-header-spacer sits in-flow at exactly the top of the content-header div
                // and its position is invariant: when sticky is inactive the spacer is 0-height and
                // the wrapper follows it; when sticky is active the spacer grows to the wrapper's
                // former height, keeping spacer.top at the same viewport position in both states.
                getAnchorEl: () => this._rootEl()?.querySelector('.sticky-header-spacer'),
                getContainerEl: () => [
                    this._rootEl()?.querySelector('.table-wrapper'),
                    this._rootEl()?.closest('.container'),
                ].filter(Boolean),
                getIsActive: () => this.stickyActive,
                canActivate: () => {
                    const minHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--page-height-card')) || 360;
                    return (this._rootEl()?.offsetHeight ?? 0) >= minHeight;
                },
                onActivate: () => {
                    // Measure spacer height only on first activation (before thead clone is added)
                    if (!this.stickyActive) {
                        const wrapper = this._rootEl()?.querySelector('.sticky-header-wrapper');
                        this.stickySpacerHeight = wrapper ? wrapper.offsetHeight : 0;
                    }
                    // Re-measure column widths on every tick (table may resize)
                    const thead = this._rootEl()?.querySelector('.table-wrapper thead');
                    if (thead) {
                        this.stickyColumnWidths = Array.from(thead.querySelectorAll('tr:first-child th'))
                            .map(th => th.getBoundingClientRect().width);
                    }
                    // Update position (left and width only; top uses CSS variable --navbar-height)
                    const tableWrapper = this._rootEl()?.querySelector('.table-wrapper');
                    const rect = tableWrapper ? tableWrapper.getBoundingClientRect() : this._rootEl()?.getBoundingClientRect();
                    const navEl = document.querySelector('header nav');
                    this.stickyTop = navEl ? Math.max(0, navEl.getBoundingClientRect().bottom) : 0;
                    this.stickyActive = true;
                    this.showStickyHeader = true;
                    this.stickyLeft = rect ? rect.left : 0;
                    this.stickyWidth = rect ? rect.width : 0;
                    // clientWidth excludes scrollbar; rect.width does not — the details panel must fit inside.
                    this.tableWrapperWidth = tableWrapper ? tableWrapper.clientWidth : (rect ? rect.width : 0);
                    this.stickyScrollLeft = tableWrapper?.scrollLeft ?? 0;
                    this.colWidths = this.stickyColumnWidths.slice();
                    // Lazily attach horizontal scroll listener — .table-wrapper may not exist at mounted() time
                    if (tableWrapper && !this._tableWrapperScrollEl) {
                        this._tableWrapperScrollEl = tableWrapper;
                        this._tableWrapperScrollFn = () => {
                            if (this.stickyActive) {
                                this.stickyScrollLeft = this._tableWrapperScrollEl.scrollLeft;
                            }
                        };
                        this._tableWrapperScrollEl.addEventListener('scroll', this._tableWrapperScrollFn, { passive: true });
                    }
                },
                onDeactivate: () => {
                    this.stickyActive = false;
                    this.showStickyHeader = false;
                    this.stickyScrollLeft = 0;
                    // Keep colWidths and tableWrapperWidth fresh on the same events that drive sticky positioning.
                    this._measureColWidths();
                },
            });
            // Use requestAnimationFrame to ensure layout measurements are accurate after all DOM updates
            this.$nextTick(() => {
                requestAnimationFrame(() => {
                    if (this._stickyHeader) this._stickyHeader.setup();
                    this._measureColWidths();
                });
            });
        }

        // Mobile: collapse thead column buttons on scroll
        this._theadActiveScrollEl = document.querySelector('#app-content');
        if (this._theadActiveScrollEl) {
            this._theadActiveScrollFn = () => { this.theadActive = false; };
            this._theadActiveScrollEl.addEventListener('scroll', this._theadActiveScrollFn, { passive: true });
        }
    },
    beforeUnmount() {
        this.batchEdits.dispose();
        if (this.hasDraggingRow) adjustRootDragging(-1);
        document.removeEventListener('click', this.handleOutsideClick);
        document.removeEventListener('keydown', this.handleEscapeKey);

        // Deregister from external paste system
        if (this.draggable) {
            tableRowSelectionState.unregisterTable(this.dragId, this);
            if (this._handleExternalPaste) document.removeEventListener('paste', this._handleExternalPaste);
        }

        // Clean up any active click state
        this.resetClickState();
        
        // Clean up sticky header scroll/resize listeners
        this._stickyHeader?.teardown();

        // Clean up table-wrapper horizontal scroll listener
        if (this._tableWrapperScrollEl && this._tableWrapperScrollFn) {
            this._tableWrapperScrollEl.removeEventListener('scroll', this._tableWrapperScrollFn);
        }

        // Clean up thead active scroll listener
        if (this._theadActiveScrollEl && this._theadActiveScrollFn) {
            this._theadActiveScrollEl.removeEventListener('scroll', this._theadActiveScrollFn);
        }
    },
    methods: {
        applyHideRowsModeFromUrl(path = this.appContext?.currentPath) {
            if (!this.syncSearchWithUrl || !this.containerPath || !path) return;
            const params = NavigationRegistry.getParametersForContainer(this.containerPath, path);
            if (!params || params.hideRowsOnSearch == null) return;
            const raw = String(params.hideRowsOnSearch).toLowerCase();
            const parsed = !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
            if (this.hideRowsOnSearchLocal !== parsed) {
                this.hideRowsOnSearchLocal = parsed;
            }
        },
        syncHideRowsModeToUrl(value = this.hideRowsOnSearchLocal) {
            if (!this.syncSearchWithUrl || !this.containerPath) return;
            NavigationRegistry.updatePathParametersSilently(
                this.containerPath.split('?')[0],
                this.appContext?.currentPath,
                {
                    hideRowsOnSearch: value ? '1' : '0',
                    // Preserve existing search parameters when toggling hideRows
                    searchTerm: (this.search.searchValue.value && this.search.searchValue.value.trim()) ? this.search.searchValue.value : undefined,
                    searchIndex: (this.search.searchIndex.value != null) ? String(this.search.searchIndex.value) : undefined
                }
            );
        },
        // Returns null when $el is a text/comment node (fragment root) to prevent querySelector errors.
        _rootEl() { return this.$el instanceof Element ? this.$el : null; },
        _measureColWidths() {
            const ths = this._rootEl()?.querySelectorAll('.table-wrapper thead tr:first-child th');
            if (!ths?.length) return;
            this.colWidths = Array.from(ths).map(th => th.getBoundingClientRect().width);
            const tw = this._rootEl()?.querySelector('.table-wrapper');
            if (tw) this.tableWrapperWidth = tw.clientWidth;
        },
        _stickyStartLeft(colIdx) {
            let offset = this.draggable ? (this.colWidths[0] ?? 20) : 0;
            for (let i = 0; i < colIdx; i++) {
                if (this.headerColumns[i]?.sticky === 'start') {
                    offset += this.colWidths[this.draggable ? i + 1 : i] ?? this.headerColumns[i].width ?? 0;
                }
            }
            return offset;
        },
        _stickyEndRight(colIdx) {
            const detailsAbsIdx = (this.draggable ? 1 : 0) + this.headerColumns.length;
            let offset = this.hasActionCell ? (this.colWidths[detailsAbsIdx] ?? 40) : 0;
            for (let i = this.headerColumns.length - 1; i > colIdx; i--) {
                if (this.headerColumns[i]?.sticky === 'end') {
                    offset += this.colWidths[this.draggable ? i + 1 : i] ?? this.headerColumns[i].width ?? 0;
                }
            }
            return offset;
        },
        getStickyColProps(column) {
            if (!column?.sticky) return null;
            const colIdx = this.headerColumns.findIndex(c => c.key === column.key);
            if (colIdx === -1) return null;
            const isStart = column.sticky === 'start';
            const offset = isStart ? this._stickyStartLeft(colIdx) : this._stickyEndRight(colIdx);
            return {
                stickyClass: isStart ? 'col-sticky-start' : 'col-sticky-end',
                stickyStyle: isStart ? { left: offset + 'px' } : { right: offset + 'px' },
            };
        },
        // position:sticky is broken inside transformed ancestors; manually pin sticky columns in the clone header.
        getCloneStickyThStyle(column, colIdx) {
            if (!column?.sticky) return {};
            const absIdx = this.draggable ? colIdx + 1 : colIdx;
            let naturalLeft = 0;
            for (let i = 0; i < absIdx; i++) naturalLeft += this.stickyColumnWidths[i] ?? 0;
            if (column.sticky === 'start') {
                const dx = Math.max(0, this._stickyStartLeft(colIdx) - naturalLeft + this.stickyScrollLeft);
                return dx ? { transform: 'translateX(' + dx + 'px)' } : {};
            } else {
                const colWidth = this.stickyColumnWidths[absIdx] ?? 0;
                // Sticky-end columns are off-screen to the right at low scroll values; correction is negative (pull left).
                const dx = Math.min(0, this.stickyWidth - this._stickyEndRight(colIdx) - naturalLeft - colWidth + this.stickyScrollLeft);
                return dx ? { transform: 'translateX(' + dx + 'px)' } : {};
            }
        },

        handleRefresh() {
            // Capture state before discarding changes
            if (this.hasUnsavedEdits && undoRegistry.currentRouteKey) {
                undoRegistry.capture(this.data, undoRegistry.currentRouteKey, { type: 'discard' });
            }

            this.$emit('refresh');
            // Nested tables are rebuilt from the reloaded rows
            this.batchEdits.clearNested();
        },

        // Selection helper methods
        isRowSelected(rowIndex) {
            // Access _version to create reactive dependency
            tableRowSelectionState._version;
            return tableRowSelectionState.hasRow(this.data, rowIndex);
        },

        isRowDragging(rowIndex) {
            if (!tableRowSelectionState.findingDropTargets) return false;
            if (!tableRowSelectionState.hasRow(this.data, rowIndex)) return false;
            // During clipboard mode, any selected row is a clipboard source
            if (tableRowSelectionState.clipboardMode) return true;
            // Regular drag: only rows in the source array get the dragging style
            return tableRowSelectionState.dragSourceArray === this.data;
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
            if (!row) return false;
            const metadata = tableRowSelectionState._getRowMetadata(row);
            return metadata?.deletion?.marked === true;
        },

        getRowMetadataClass(row) {
            if (!row) return '';
            const metadata = tableRowSelectionState._getRowMetadata(row);
            return metadata?.highlight?.class || '';
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

        cancelClipboard() {
            tableRowSelectionState.cancelClipboard();
        },

        // Complete the clipboard paste at the currently registered drop target.
        // Used by click handlers on drop-target zones as an alternative to Ctrl+V.
        completeClipboardAtCurrentTarget() {
            if (!tableRowSelectionState.clipboardMode) return;
            if (!this.dropTarget?.type) return;
            tableRowSelectionState.completeClipboard(this.dropTarget);
        },

        // Click on the header area while in clipboard mode — paste at top of table.
        // Ignores clicks that originated from a button (sort / hide) inside the header.
        handleClipboardHeaderClick(event) {
            if (!tableRowSelectionState.clipboardMode) return;
            if (this.dropTarget?.type !== 'header') return;
            if (event.target.closest('button')) return;
            this.completeClipboardAtCurrentTarget();
        },

        // Mobile: tap on thead (not on a button) toggles column-button visibility
        handleTheadTap(event) {
            if (event.target.closest('button')) return;
            this.theadActive = !this.theadActive;
        },

        // Click on a row while in clipboard mode — paste if that row is showing a drop-target indicator.
        handleClipboardRowClick(idx, visibleIdx, event) {
            if (!tableRowSelectionState.clipboardMode) return;
            const dt = this.dropTarget;
            if (!dt?.type) return;
            const isBetween = dt.type === 'between' &&
                (dt.visualTargetIndex === visibleIdx || dt.visualTargetIndex === visibleIdx + 1);
            const isOnto = dt.type === 'onto' && dt.targetIndex === idx;
            if (isBetween || isOnto) this.completeClipboardAtCurrentTarget();
        },

        handleSearchResultClick(idx) {
            if (!this.search.hasActiveSearch.value || this.hideRowsOnSearchLocal) return;
            const matchIdx = this.searchMatchIndexMap.get(idx);
            if (matchIdx === undefined) return;
            this.search.setSearchIndex(matchIdx + 1);
        },

        _scrollToActiveSearchResult() {
            this.$nextTick(() => {
                const index = this.activeSearchIndex;
                if (index == null) return;
                const el = this._findOwnSearchRow(index - 1);
                if (!el && this.searchMatchCount === 0) return;
                scrollToSearchResult(el, this.$el);
            });
        },

        // Finds the matchIdx-th (0-based) search result, scoped to this table.
        // If nested sub-tables are present, navigates through their individual item matches in DOM order.
        _findOwnSearchRow(matchIdx) {
            // Nested-table mode: collect all sub-table matches in DOM order and index them globally
            const nestedMatches = Array.from(this.$el.querySelectorAll('[data-search-match-idx]'))
                .filter(el => el.closest('.dynamic-table') !== this.$el);
            if (nestedMatches.length > 0) {
                return nestedMatches[matchIdx] ?? null;
            }
            // Flat-table mode: find the row belonging to this table by its match index
            const candidates = this.$el.querySelectorAll(`[data-search-match-idx="${matchIdx}"]`);
            for (const el of candidates) {
                if (el.closest('.dynamic-table') === this.$el) return el;
            }
            return null;
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

        handleToggleSelectedGroups() {
            if (!this.hasSelectedGroupMasters) return;

            // If any selected group is hidden, show all selected; otherwise hide all.
            const shouldHide = !this.anySelectedGroupCollapsed;
            this.selectedGroupMasterIds.forEach(groupId => {
                // shouldOverride = add to overriddenGroups; the meaning of overridden flips with mode.
                // view mode: overridden = open (exception to default-closed)
                // edit mode: overridden = closed (exception to default-open)
                const shouldOverride = shouldHide !== this.hideGroupMembers;
                if (shouldOverride) {
                    this.overriddenGroups.add(groupId);
                } else {
                    this.overriddenGroups.delete(groupId);
                }
            });
            this.overriddenGroups = new Set(this.overriddenGroups);
        },

        createEmptyGroupMasterRow(targetIndex) {
            const templateRow = this.data[targetIndex] || this.data[targetIndex - 1] || {};
            const emptyRow = {};

            // Preserve known row shape while forcing an empty payload row.
            Object.keys(templateRow).forEach(key => {
                if (key === 'metadata') {
                    emptyRow[key] = '';
                } else if (key === 'AppData') {
                    emptyRow[key] = undefined;
                } else {
                    emptyRow[key] = '';
                }
            });

            // Ensure all declared columns exist on the row.
            this.columnModel.all.forEach(column => {
                if (!Object.prototype.hasOwnProperty.call(emptyRow, column.key)) {
                    emptyRow[column.key] = '';
                }
            });

            this.data.splice(targetIndex, 0, emptyRow);
            return emptyRow;
        },

        handleCreateGroupFromSelection() {
            if (!this.canCreateGroupFromSelection) return;

            const anchorVisibleIndex = this.firstSelectedVisibleRowIndex;
            const anchorEntry = this.visibleRows[anchorVisibleIndex];
            if (!anchorEntry) return;

            const targetIndex = anchorEntry.idx;
            if (typeof targetIndex !== 'number' || targetIndex < 0 || targetIndex > this.data.length) return;

            const selectedRowsSnapshot = tableRowSelectionState.getAllSelectedRows()
                .map(({ row, sourceArray, index }) => ({ row, sourceArray, index }))
                .filter(({ row, sourceArray }) => !!row && !!sourceArray);

            if (selectedRowsSnapshot.length === 0) return;

            if (tableRowSelectionState.currentRouteKey) {
                const arraysToCapture = new Set([this.data]);
                selectedRowsSnapshot.forEach(({ sourceArray }) => arraysToCapture.add(sourceArray));
                undoRegistry.capture(Array.from(arraysToCapture), tableRowSelectionState.currentRouteKey, {
                    type: 'group-create-from-selection',
                    selectionState: tableRowSelectionState
                });
            }

            const masterRow = this.createEmptyGroupMasterRow(targetIndex);

            // Row insertion shifts numeric indices; rebuild selection from object references.
            tableRowSelectionState.clearAll();
            selectedRowsSnapshot.forEach(({ row, sourceArray }) => {
                const updatedIndex = sourceArray.indexOf(row);
                if (updatedIndex !== -1) {
                    tableRowSelectionState.addRow(updatedIndex, sourceArray, this.dragId);
                }
            });

            const masterIndex = this.data.indexOf(masterRow);
            if (masterIndex === -1) return;

            const result = tableRowSelectionState.groupSelectedItemsUnder(masterIndex, this.data);
            if (!result) return;

            // Follow drag grouping behavior: keep selection on grouped children.
            tableRowSelectionState.clearAll();
            result.droppedItems.forEach(item => {
                const childIndex = this.data.indexOf(item);
                if (childIndex !== -1) {
                    tableRowSelectionState.addRow(childIndex, this.data, this.dragId);
                }
            });
        },

        handleSort(columnKey) {
            // Check if this specific column is sortable
            const column = this.columnModel.all.find(col => col.key === columnKey);
            if (!column || !this.isColumnSortable(column)) return;
            this.isUsingDefaultSort = false;
            
            if (this.sortColumn === columnKey) {
                // Toggle sort direction if same column
                this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                // New column, start with ascending
                this.sortColumn = columnKey;
                this.sortDirection = 'asc';
            }
        },

        // The view's sort (resolveView normalizes it to [{ key, direction }]), on sortable columns
        getDefaultSortCriteria() {
            return (this.resolved?.sort || [])
                .map(({ key, direction }) => {
                    const column = this.columnModel.all.find(col => col.key === key);
                    return column && this.isColumnSortable(column) ? { column, direction } : null;
                })
                .filter(Boolean);
        },

        getCurrentSortCriteria() {
            if (!this.sortColumn) return [];
            const column = this.columnModel.all.find(col => col.key === this.sortColumn);
            if (!column || !this.isColumnSortable(column)) return [];
            return [{ column, direction: this.sortDirection }];
        },

        applyDefaultSortColumn(options = {}) {
            const { force = false } = options;
            const defaultSortCriteria = this.getDefaultSortCriteria();
            if (defaultSortCriteria.length === 0) return;

            const activeSortColumn = this.columnModel.all.find(col => col.key === this.sortColumn);
            const hasValidActiveSort = !!(this.sortColumn && activeSortColumn && this.isColumnSortable(activeSortColumn));

            if (!force && hasValidActiveSort) return;

            this.sortColumn = defaultSortCriteria[0].column.key;
            this.sortDirection = defaultSortCriteria[0].direction;
            this.isUsingDefaultSort = true;
        },
        
        // Sortability comes from the view (resolved field.sortable)
        isColumnSortable(column) {
            return !!column.sortable;
        },
        // A material symbol name ('calendar_month') rather than a glyph ('☷')
        isSymbolName(text) {
            return typeof text === 'string' && /^[a-z][a-z0-9_]*$/.test(text);
        },
        // The row's primary action for an action cell
        rowActionFor(row, idx) {
            if (this.effectiveAction.kind === 'none') return null;
            return {
                run: () => this.performAction(row, idx),
                disabled: this.isActionDisabled(row),
                title: this.effectiveAction.title || this.effectiveAction.label || ''
            };
        },

        getSortIcon(columnKey) {
            const column = this.columnModel.all.find(col => col.key === columnKey);
            if (!this.isColumnSortable(column) || this.sortColumn !== columnKey) return '';
            return this.sortDirection === 'asc' ? 'arrow_upward_alt' : 'arrow_downward_alt';
        },
        
        
        formatCellValue(value, column) {
            return formatValue(value, column);
        },

        // Format, escape and highlight a cell value (highlighting only while a search is active)
        highlightSearchText(value, column) {
            const text = formatText(value, column);
            return this.searchActive ? this.highlighter(text) : escapeHtml(text);
        },

        // Per-cell match indication (OR across words) on the raw or formatted value
        hasSearchMatch(value, column) {
            if (!this.searchActive) return false;
            const words = this.activeSearchWords;
            if (valueMatchesAny(value, words)) return true;
            const formattedValue = this.formatCellValue(value, column);
            return formattedValue !== value && valueMatchesAny(formattedValue, words);
        },

        // ── Primary action (§4.8) ────────────────────────────────────────────
        // Details-only match: the row matched but its shown fields don't explain it
        isDetailsOnlyMatch(row) {
            const r = this.searchResultByRow.get(row);
            return !!(r && r.matched && !r.shownMatch);
        },
        isActionDisabled(row) {
            const fn = this.effectiveAction.disabled;
            try { return typeof fn === 'function' ? !!fn(row) : false; } catch { return false; }
        },
        performAction(row, idx) {
            const a = this.effectiveAction;
            if (a.kind === 'none' || this.isActionDisabled(row)) return;
            if (a.kind === 'details' && this.detailsEnabled) {
                this.toggleRowDetails(idx);
                return;
            }
            const ctx = { searchTerm: (this.activeSearchValue || '').trim() };
            if (typeof a.perform === 'function') a.perform(row, ctx);
            else this.$emit('row-action', row, ctx);
        },
        // Whole-row trigger with guards: interactive elements, selected text, clipboard/drag mode
        handleRowTriggerClick(row, idx, event) {
            if (!this.hasRowTrigger) return;
            const target = event?.target;
            if (target?.closest?.(ROW_TRIGGER_IGNORE)) return;
            const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
            if (sel && !sel.isCollapsed && String(sel).trim()) return;
            if (tableRowSelectionState.clipboardMode || tableRowSelectionState.findingDropTargets) return;
            this.performAction(row, idx);
        },
        handleRowTriggerKey(row, idx, event) {
            if (!this.hasRowTrigger) return;
            if (event.target !== event.currentTarget) return;
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.performAction(row, idx);
            }
        },
        cellDecorations(row, key) {
            return this.rowDecorMap.get(row)?.byKey.get(key) || [];
        },
        rowLevelDecorations(row) {
            return this.rowDecorMap.get(row)?.rowLevel || [];
        },
        
        // Cell colour from the view (style[key].color); the edit state class is added after it
        cellColorClass(row, column) {
            if (!column?.colorRule || !row) return '';
            return colorFor(row, column, this.resolved);
        },
        // Row colour from the view (rowColor) — lowest colour precedence (§4.9)
        rowColorClass(row) {
            if (!this.resolved?.rowColor || !row) return '';
            return rowColorFor(row, this.resolved);
        },
        getCellClass(value, column, rowIndex) {
            const row = typeof rowIndex === 'number' && this.data ? this.data[rowIndex] : null;
            return row ? this.cellColorClass(row, column) : '';
        },
        
        getColumnFont(column) {
            return column.font ? 'font-' + column.font : '';
        },
        // Every cell edit (registry cells and the number input) comes here:
        //   batch   → batchEdits (cell-edit to the page; changed-cell tracking; Save)
        //   instant → cell-commit(row, columnKey, value) for DataView's delayed verified-write queue
        commitCellValue(rowIndex, column, value) {
            if (!column.editable) return;
            if (this.editMode === 'instant') this.$emit('cell-commit', this.data[rowIndex], column.key, value);
            else if (this.isBatchEditing) this.batchEdits.edit(rowIndex, column.key, value);
        },
        // The cell's edit state as a class: cell-unsaved, cell-failed (utils/cellEdits.js)
        cellStateClass(row, rowIndex, column) {
            const state = this.editMode === 'instant'
                ? (this.cellState ? this.cellState(row, column.key) : '')
                : (this.isBatchEditing ? this.batchEdits.cellState(rowIndex, column.key) : '');
            return state ? 'cell-' + state : '';
        },
        cellDisabledReason(row, column) {
            if (!this.cellDisabled) return '';
            try { return this.cellDisabled(row, column.key) || ''; } catch { return ''; }
        },
        // A batch cell changed from its loaded value shows the original and a revert control
        showRevert(row, rowIndex, column) {
            return this.isBatchEditing && column.editable && column.cell !== 'external-edit'
                && this.batchEdits.isChanged(rowIndex, column.key)
                && this.batchEdits.originalRow(row, rowIndex) !== undefined
                && this.batchEdits.originalValue(row, rowIndex, column.key) !== row[column.key];
        },
        // A batch cell's loaded value; undefined outside batch edits and on new rows
        savedCellValue(row, rowIndex, column) {
            if (!this.isBatchEditing || this.batchEdits.originalRow(row, rowIndex) === undefined) return undefined;
            return this.batchEdits.originalValue(row, rowIndex, column.key);
        },
        revertCellToOriginal(rowIndex, column, event) {
            if (!this.isBatchEditing) return;
            // Stop propagation to prevent cell focus
            if (event) {
                event.stopPropagation();
                event.preventDefault();
            }
            this.batchEdits.revert(rowIndex, column.key);
        },
        // A click anywhere in an editable cell focuses its text or number editor
        handleEditableCellContainerClick(column, event) {
            if (!column?.editable) return;
            const target = event?.target;
            if (target?.isContentEditable || target?.closest?.('input, select, button, label')) return;
            const editor = event.currentTarget?.querySelector?.('[contenteditable], input[type="number"], .number-arithmetic input');
            editor?.focus({ preventScroll: true });
        },
        // Leaving a batch cell ends its undo step
        handleCellBlur() {
            if (this.isBatchEditing) this.batchEdits.endEdit();
        },
        // Recompare the changed cells after rows change (editable main-table columns)
        recompareEdits() {
            if (!this.isBatchEditing) return;
            this.batchEdits.compareAll(this.mainTableColumns.filter(c => c.editable).map(c => c.key));
        },
        handleSave() {
            this.$emit('on-save');
        },
        
        handleUndo() {
            if (this.canUndo) {
                const alert = undoRegistry.undo();
                if (alert) modalManager.confirm(alert, () => {}, null, 'Note', 'OK', null, '');
            }
        },
        
        handleRedo() {
            if (this.canRedo) {
                const alert = undoRegistry.redo();
                if (alert) modalManager.confirm(alert, () => {}, null, 'Note', 'OK', null, '');
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
            this.clickState.shiftKey = event.shiftKey;
            
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
            
            // Update global mouse position for drag follower
            tableRowSelectionState.mouseX = event.clientX;
            tableRowSelectionState.mouseY = event.clientY;
            
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
                    if (this.clickState.shiftKey && this.clickState.lastAnchorRowIndex !== null) {
                        // Shift-click: range select from anchor to clicked row
                        this.selectRowRange(this.clickState.lastAnchorRowIndex, this.clickState.startRowIndex);
                    } else {
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
                        this.clickState.lastAnchorRowIndex = this.clickState.startRowIndex;
                    }
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
                    this.clickState.lastAnchorRowIndex = this.clickState.startRowIndex;
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
            this.clickState.shiftKey = false;
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
            
            // Find the table element - scope to this specific table using drag-id.
            // Exclude the sticky header clone (class 'sticky-header') which also carries the dragId
            // class but has no tbody; without this exclusion a scrolled page would always resolve
            // tableEl to the fixed clone, causing the bounds check to discard every cursor position.
            let tableEl;
            if (this.dragId) {
                tableEl = this.$el.querySelector(`table.${this.dragId}:not(.sticky-header)`);
            } else {
                tableEl = this.$el.querySelector('table:not(.sticky-header)');
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
            let thead, tbody;
            if (this.dragId) {
                thead = tableEl.querySelector(`table.${this.dragId} > thead`);
                tbody = tableEl.querySelector(`table.${this.dragId} > tbody`);
            } else {
                thead = tableEl.querySelector('thead');
                tbody = tableEl.querySelector('tbody');
            }
            let newDropTarget = { type: null, position: null, isAbove: false };
            
            // Check header drop target
            if (thead) {
                const theadRect = thead.getBoundingClientRect();
                if (mouseY >= theadRect.top && mouseY <= theadRect.bottom) {
                    newDropTarget = { type: 'header', position: null, isAbove: false };
                }
            }
            
            // Check between rows in tbody
            if (tbody && newDropTarget.type === null) {
                // Select only data rows (those with data-visible-idx) to correctly map back to
                // visibleRows. This excludes details-row-container rows and any extra <tr> elements
                // injected by slots, which would otherwise cause the loop index to drift ahead of
                // visibleRows and break drop-target detection for rows lower in the table.
                const rows = tbody.querySelectorAll(':scope > tr[data-visible-idx]');
                
                // Special case: if table is empty but draggable, check the empty-drop-target row
                if (rows.length === 0 && this.draggable) {
                    const emptyRow = tbody.querySelector('tr.empty-drop-target');
                    if (emptyRow) {
                        const rowRect = emptyRow.getBoundingClientRect();
                        if (mouseY >= rowRect.top && mouseY <= rowRect.bottom) {
                            // Drop at the beginning of empty table
                            newDropTarget = {
                                type: 'between',
                                targetIndex: 0,
                                visualTargetIndex: 0
                            };
                        }
                    }
                }
                
                for (let i = 0; i < rows.length; i++) {
                    const row = rows[i];
                    const rowRect = row.getBoundingClientRect();
                    
                    if (mouseY >= rowRect.top && mouseY <= rowRect.bottom) {
                        // Read visibleIdx directly from the element so the mapping is correct
                        // regardless of how many non-data rows exist between data rows in the DOM.
                        const visibleIdx = parseInt(row.getAttribute('data-visible-idx'), 10);
                        const rowHeight = rowRect.height;
                        const rowTop = rowRect.top;
                        const relativeY = mouseY - rowTop;
                        
                        // Split row into thirds if allowDropOnto is enabled
                        if (this.allowDropOnto) {
                            const topThird = rowHeight / 3;
                            const bottomThird = (rowHeight * 2) / 3;
                            
                            if (relativeY >= topThird && relativeY <= bottomThird) {
                                // Middle third - check if target row is eligible for drop-onto
                                const currentVisibleRow = this.visibleRows[visibleIdx];
                                const targetIndex = currentVisibleRow ? currentVisibleRow.idx : visibleIdx;
                                const targetRow = this.data[targetIndex];
                                
                                // Don't allow drop onto if:
                                // 1. Any selected row is a group master
                                // 2. Target row is a group child (in-group)
                                // 3. Target row is an empty placeholder (data array is empty or row has class 'empty-drop-target')
                                // 4. Target row is currently selected
                                // 5. Target row is marked for deletion
                                const hasGroupMasterSelected = tableRowSelectionState.hasGroupMasterInDragSnapshot();
                                const isEmptyPlaceholder = !this.data || this.data.length === 0 || row.classList.contains('empty-drop-target');
                                const isGroupChild = this.isRowInGroup(targetIndex);
                                const isTargetSelected = tableRowSelectionState.hasRow(this.data, targetIndex);
                                const isMarkedForDeletion = this.isRowMarkedForDeletion(targetRow);
                                
                                if (!hasGroupMasterSelected && !isGroupChild && !isEmptyPlaceholder && !isTargetSelected && !isMarkedForDeletion) {
                                    newDropTarget = {
                                        type: 'onto',
                                        targetIndex: targetIndex
                                    };
                                    //console.log('Drop ONTO target found:', newDropTarget, 'visual index:', visibleIdx, 'mouseY:', mouseY, 'rowRect:', rowRect);
                                    break;
                                }
                                // If any condition fails, fall through to between logic below
                            }
                        }
                        
                        // Top or bottom third (or allowDropOnto is false) - normal between behavior
                        const midpoint = rowRect.top + rowRect.height / 2;
                        const isAbove = mouseY < midpoint;
                        
                        // Map visual row index to actual data position.
                        // visibleRows contains { row, idx } where idx is the actual data index.
                        // visualTargetIndex tracks which visual row shows the drop indicator;
                        // targetIndex is the data insertion point (may differ when groups are closed).
                        let targetIndex;
                        let visualTargetIndex;
                        if (isAbove) {
                            // Insert before this row
                            visualTargetIndex = visibleIdx;
                            if (visibleIdx === 0) {
                                targetIndex = 0; // Insert at beginning
                            } else {
                                // Find the data index of the previous visible row and add 1,
                                // skipping past any hidden group children that follow it.
                                const prevVisibleRow = this.visibleRows[visibleIdx - 1];
                                if (prevVisibleRow) {
                                    const prevMeta = tableRowSelectionState._getRowMetadata(prevVisibleRow.row);
                                    const prevGrouping = prevMeta?.grouping;
                                    if (prevGrouping?.isGroupMaster && this.isGroupMembersHiddenById(prevGrouping.groupId)) {
                                        const children = tableRowSelectionState._getGroupChildren(prevVisibleRow.idx, this.data);
                                        targetIndex = prevVisibleRow.idx + children.length + 1;
                                    } else {
                                        targetIndex = prevVisibleRow.idx + 1;
                                    }
                                } else {
                                    targetIndex = 0;
                                }
                            }
                        } else {
                            // Insert after this row, skipping past any hidden group children.
                            visualTargetIndex = visibleIdx + 1;
                            const currentVisibleRow = this.visibleRows[visibleIdx];
                            if (currentVisibleRow) {
                                const curMeta = tableRowSelectionState._getRowMetadata(currentVisibleRow.row);
                                const curGrouping = curMeta?.grouping;
                                if (curGrouping?.isGroupMaster && this.isGroupMembersHiddenById(curGrouping.groupId)) {
                                    const children = tableRowSelectionState._getGroupChildren(currentVisibleRow.idx, this.data);
                                    targetIndex = currentVisibleRow.idx + children.length + 1;
                                } else {
                                    targetIndex = currentVisibleRow.idx + 1;
                                }
                            } else {
                                targetIndex = this.data.length;
                            }
                        }
                        
                        // Check if a group master is selected and this position would split a group
                        const hasGroupMasterSelected = tableRowSelectionState.hasGroupMasterInDragSnapshot();
                        if (hasGroupMasterSelected && this.wouldSplitGroup(targetIndex)) {
                            // Don't allow drop between group rows
                            continue;
                        }
                        
                        newDropTarget = {
                            type: 'between',
                            targetIndex: targetIndex,
                            visualTargetIndex: visualTargetIndex
                        };
                        //console.log('Drop target found:', newDropTarget, 'visual index:', visibleIdx, 'isAbove:', isAbove, 'mouseY:', mouseY, 'rowRect:', rowRect);
                        break;
                    }
                }
            }
            
            // Update drop target if changed
            if (this.dropTarget.type !== newDropTarget.type ||
                this.dropTarget.targetIndex !== newDropTarget.targetIndex ||
                this.dropTarget.visualTargetIndex !== newDropTarget.visualTargetIndex) {
                
                this.dropTarget = newDropTarget;
                
                // Register the new drop target with global state
                if (this.dropTarget.type) {
                    tableRowSelectionState.registerDropTarget(this.data, this.dropTarget);
                }
            }
        },

        getRowIndexAtPosition(mouseY) {
            // Find which row index corresponds to the given Y position - scope to this specific table.
            // Use [data-visible-idx] to select only data rows, excluding details rows and nested rows.
            // Exclude the sticky header clone so we always target the actual data table.
            const tableEl = this.dragId
                ? this.$el.querySelector(`table.${this.dragId}:not(.sticky-header)`)
                : this.$el.querySelector('table:not(.sticky-header)');
            if (!tableEl) return null;
            const tbody = tableEl.querySelector('tbody');
            if (!tbody) return null;
            const rows = tbody.querySelectorAll(':scope > tr[data-visible-idx]');
            
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const rowRect = row.getBoundingClientRect();
                
                if (mouseY >= rowRect.top && mouseY <= rowRect.bottom) {
                    const visibleIdx = parseInt(row.getAttribute('data-visible-idx'), 10);
                    const visibleRowData = this.visibleRows[visibleIdx];
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
            
            // Update global mouse position for drag follower when in drag/clipboard mode
            if (tableRowSelectionState.findingDropTargets || tableRowSelectionState.clipboardMode) {
                tableRowSelectionState.mouseX = newX;
                tableRowSelectionState.mouseY = newY;
            }
            
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
        
        unselectAllEditableCells() {
            // Remove focus from any editable cell. get editable cells by searching dom for contenteditable
            const editableCells = this.$el.querySelectorAll('[contenteditable]');
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
        
        isGroupMembersHiddenById(groupId) {
            // view mode (hideGroupMembers=true): default=closed, override=open → hidden when NOT overridden
            // edit mode (hideGroupMembers=false): default=open, override=closed → hidden when overridden
            return this.hideGroupMembers
                ? !this.overriddenGroups.has(groupId)
                : this.overriddenGroups.has(groupId);
        },

        isGroupMembersHidden(rowIndex) {
            const row = this.data[rowIndex];
            if (!row) return false;
            const metadata = tableRowSelectionState._getRowMetadata(row);
            const grouping = metadata?.grouping;
            if (!grouping?.isGroupMaster) return false;
            return this.isGroupMembersHiddenById(grouping.groupId);
        },

        toggleGroupCollapse(rowIndex) {
            const row = this.data[rowIndex];
            if (!row) return;
            const metadata = tableRowSelectionState._getRowMetadata(row);
            const grouping = metadata?.grouping;
            if (!grouping?.isGroupMaster) return;
            if (this.overriddenGroups.has(grouping.groupId)) {
                this.overriddenGroups.delete(grouping.groupId);
            } else {
                this.overriddenGroups.add(grouping.groupId);
            }
            this.overriddenGroups = new Set(this.overriddenGroups);
        },

        showGroup(rowIndex) {
            const row = this.data[rowIndex];
            if (!row) return;
            const metadata = tableRowSelectionState._getRowMetadata(row);
            const grouping = metadata?.grouping;
            if (!grouping?.isGroupMaster) return;
            // To open: in view mode add the exception (open), in edit mode remove the exception (not closed)
            if (this.hideGroupMembers) {
                this.overriddenGroups.add(grouping.groupId);
            } else {
                this.overriddenGroups.delete(grouping.groupId);
            }
            this.overriddenGroups = new Set(this.overriddenGroups);
        },

        getGroupToggleIcon(rowIndex) {
            // Returns 'expand' if group is collapsed, 'compress' if expanded
            return this.isGroupMembersHidden(rowIndex) ? 'expand' : 'compress';
        },

        getGroupToggleTitle(rowIndex) {
            // Returns appropriate title based on group state
            return this.isGroupMembersHidden(rowIndex) ? 'Expand Group' : 'Collapse Group';
        },
        
        isRowExpanded(rowIndex) {
            return this.expandedRows.has(rowIndex);
        },

        shouldShowDetailsContent(row, rowIndex) {
            if (this.forceDetails) {
                return !this.rowDetailsVisible || this.rowDetailsVisible(row);
            }
            return this.isRowExpanded(rowIndex);
        },
        
        handleOutsideClick(event) {
            const clickedElement = event.target;
            
            // Handle clearing selections when clicking outside selected rows
            if (tableRowSelectionState.getTotalSelectionCount() > 0) {
                // Don't clear if a cut, copy, or drag operation is currently active
                if (tableRowSelectionState.clipboardMode !== null || tableRowSelectionState.findingDropTargets) {
                    return; // Skip clearing - operation in progress
                }
                
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
                
                // Check if click was on a drag handle
                const clickedDragHandle = clickedElement.closest('.row-drag-handle');
                
                // Check if click was on the selection bubble
                const clickedSelectionBubble = clickedElement.closest('.selection-action-bubble');
                
                // Check if click was within a table header (to avoid interfering with header buttons like undo/redo)
                const clickedInHeader = clickedElement.closest('.content-header');
                
                // Clear selections for any click that isn't on a drag handle, selection bubble, or table header —
                // including clicks outside all tables. Drag handles are the only way to build/extend selections.
                if (!clickedDragHandle && !clickedSelectionBubble && !clickedInHeader) {
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
                    this.clickState.lastAnchorRowIndex = null;
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
        
        // Serialize selected visible rows to a tab-delimited string for the OS clipboard.
        _serializeRowsToTsv() {
            const cols = this.clipboardExportColumns;
            if (cols.length === 0) return null;
            const allSelected = tableRowSelectionState.getAllSelectedRows();
            if (allSelected.length === 0) return null;
            return allSelected.map(({ row }) =>
                cols.map(col => {
                    const val = String(row[col.key] ?? '');
                    return val.replace(/\t/g, ' ').replace(/\n/g, ' ').replace(/\r/g, '');
                }).join('\t')
            ).join('\n');
        },

        // Handle the browser paste event — fires on Ctrl+V from any context.
        // Multiple draggable tables each register this listener; externalPasteActive acts as a
        // mutex so only the first handler to claim the event runs.
        // When a contenteditable cell is focused, the paste event fires on that element but
        // still bubbles; for multi-column TSV we intercept here so rows are inserted rather
        // than the raw text being dumped into the focused cell.
        _handleExternalPaste(event) {
            if (tableRowSelectionState.clipboardMode) return;
            if (tableRowSelectionState.externalPasteActive) return;

            // Sanitizing also normalizes \r\n, so Excel rows don't leave a stray \r in the last cell
            const text = sanitizeCellText(event.clipboardData?.getData('text/plain'));
            if (!text || (!text.includes('\t') && !text.includes('\n'))) return;

            const lines = text.trim().split('\n');
            const rows = lines
                .map(line => line.split('\t'))
                .filter(cells => cells.some(c => c.trim() !== ''));
            if (rows.length === 0) return;
            const colCount = rows[0].length;

            // Use event coordinates when available; fall back to the globally-tracked position.
            const mouseX = event.clientX || tableRowSelectionState.mouseX;
            const mouseY = event.clientY || tableRowSelectionState.mouseY;

            const target = this._resolveExternalPasteTarget(rows, colCount, mouseX, mouseY);
            if (!target) return;

            // If a cell is focused and this is single-column data, let the cell handle it.
            const focusedEditable = document.activeElement?.isContentEditable
                ? document.activeElement
                : null;
            if (focusedEditable && colCount === 1) return;

            event.preventDefault();
            tableRowSelectionState._lastSeenExternalContent = text;
            tableRowSelectionState.externalPasteActive = true;
            Promise.resolve().then(() => { tableRowSelectionState.externalPasteActive = false; });

            tableRowSelectionState.loadExternalClipboard(target.items, target.dragId);
            tableRowSelectionState.dragTargetArray = target.inst.data;
            tableRowSelectionState.completeClipboard(target.dropTarget);
        },

        // Find the best compatible table under the cursor and compute the insertion position.
        // Selects the deepest-nested compatible table (e.g. an item table inside a crate table).
        // Returns { inst, items, dropTarget, dragId } or null if no valid target exists.
        _resolveExternalPasteTarget(rows, colCount, mouseX, mouseY) {
            if (mouseX == null || mouseY == null) return null;

            // Collect compatible table instances whose bounding rect contains the cursor.
            // Iterate through all instances for each dragId (not just the first) so nested tables
            // like item tables within different crates are all considered.
            const candidates = [];
            for (const [dragId, instances] of tableRowSelectionState.activeTables) {
                for (const inst of instances) {
                    if (!inst || !inst.$el) continue;
                    const cols = inst.pasteableColumns;
                    if (cols.length < colCount) continue;

                    const rect = inst.$el.getBoundingClientRect();
                    if (mouseX < rect.left || mouseX > rect.right || mouseY < rect.top || mouseY > rect.bottom) continue;
                    candidates.push({ dragId, inst, cols });
                }
            }

            if (candidates.length === 0) return null;

            // Pick the deepest-nested candidate: the one whose $el is contained within another.
            const chosen = candidates.reduce((deepest, candidate) => {
                if (!deepest) return candidate;
                if (deepest.inst.$el.contains(candidate.inst.$el)) return candidate;
                return deepest;
            });

            const dropTarget = this._computeExternalDropTarget(chosen.inst, mouseX, mouseY);

            // Build paste items from the TSV rows using the target table's row structure.
            const items = rows.map(cells => {
                const templateRow = chosen.inst.data.find(r => r != null) || null;
                const row = {};
                if (templateRow) {
                    Object.keys(templateRow).forEach(key => {
                        if (key === 'Items') {
                            row.Items = [];
                        } else if (key !== 'AppData') {
                            row[key] = '';
                        }
                    });
                }
                chosen.cols.forEach((col, i) => {
                    row[col.key] = i < cells.length ? cells[i].trim() : '';
                });
                return { clone: row, original: null };
            });

            return { inst: chosen.inst, items, dropTarget, dragId: chosen.dragId };
        },

        // Compute a drop target for external paste at (mouseX, mouseY) within inst's table.
        // Mirrors findDropTargetAtCursor without side effects. Returns a dropTarget object
        // compatible with completeClipboard: { type: 'header' } or { type: 'between', targetIndex, visualTargetIndex }.
        _computeExternalDropTarget(inst, mouseX, mouseY) {
            const dragId = inst.dragId;
            const tableEl = inst.$el.querySelector(
                dragId ? `table.${dragId}:not(.sticky-header)` : 'table:not(.sticky-header)'
            );
            if (!tableEl) return { type: 'header' };

            const tableRect = tableEl.getBoundingClientRect();
            if (mouseY < tableRect.top || mouseY > tableRect.bottom) return { type: 'header' };

            const thead = tableEl.querySelector('thead');
            if (thead) {
                const theadRect = thead.getBoundingClientRect();
                if (mouseY >= theadRect.top && mouseY <= theadRect.bottom) return { type: 'header' };
            }

            const tbody = tableEl.querySelector('tbody');
            if (!tbody) return { type: 'header' };

            const dataRows = tbody.querySelectorAll(':scope > tr[data-visible-idx]');
            if (dataRows.length === 0) {
                return { type: 'between', targetIndex: 0, visualTargetIndex: 0 };
            }

            for (let i = 0; i < dataRows.length; i++) {
                const row = dataRows[i];
                const rowRect = row.getBoundingClientRect();
                if (mouseY < rowRect.top || mouseY > rowRect.bottom) continue;

                const visibleIdx = parseInt(row.getAttribute('data-visible-idx'), 10);
                const isAbove = mouseY < rowRect.top + rowRect.height / 2;

                let targetIndex, visualTargetIndex;
                if (isAbove) {
                    visualTargetIndex = visibleIdx;
                    if (visibleIdx === 0) {
                        targetIndex = 0;
                    } else {
                        const prevVisible = inst.visibleRows[visibleIdx - 1];
                        if (prevVisible) {
                            const prevMeta = tableRowSelectionState._getRowMetadata(prevVisible.row);
                            const prevGrouping = prevMeta?.grouping;
                            if (prevGrouping?.isGroupMaster && inst.isGroupMembersHiddenById(prevGrouping.groupId)) {
                                const children = tableRowSelectionState._getGroupChildren(prevVisible.idx, inst.data);
                                targetIndex = prevVisible.idx + children.length + 1;
                            } else {
                                targetIndex = prevVisible.idx + 1;
                            }
                        } else {
                            targetIndex = 0;
                        }
                    }
                } else {
                    visualTargetIndex = visibleIdx + 1;
                    const curVisible = inst.visibleRows[visibleIdx];
                    if (curVisible) {
                        const curMeta = tableRowSelectionState._getRowMetadata(curVisible.row);
                        const curGrouping = curMeta?.grouping;
                        if (curGrouping?.isGroupMaster && inst.isGroupMembersHiddenById(curGrouping.groupId)) {
                            const children = tableRowSelectionState._getGroupChildren(curVisible.idx, inst.data);
                            targetIndex = curVisible.idx + children.length + 1;
                        } else {
                            targetIndex = curVisible.idx + 1;
                        }
                    } else {
                        targetIndex = inst.data.length;
                    }
                }

                return { type: 'between', targetIndex, visualTargetIndex };
            }

            // Cursor is in tbody but below all rows — append at end.
            return { type: 'between', targetIndex: inst.data.length, visualTargetIndex: inst.visibleRows.length };
        },

        handleEscapeKey(event) {
            // Handle Ctrl+C / Ctrl+X: activate clipboard mode for selected rows in this table
            if ((event.ctrlKey || event.metaKey) && (event.key === 'c' || event.key === 'x')) {
                if (
                    tableRowSelectionState.getArraySelectionCount(this.data) > 0 &&
                    !tableRowSelectionState.clipboardMode &&
                    this.draggable
                ) {
                    const mode = event.key === 'c' ? 'copy' : 'cut';
                    tableRowSelectionState.startClipboard(mode, this.dragId, this.currentRouteKey);
                    // Also write selected rows as TSV to the OS clipboard so Excel/Sheets can receive them.
                    const tsv = this._serializeRowsToTsv();
                    if (tsv !== null) {
                        navigator.clipboard.writeText(tsv).then(() => {
                            tableRowSelectionState._appClipboardContent = tsv;
                        }).catch(() => {});
                    }
                    event.preventDefault();
                }
                return;
            }

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

        // Action button glow: the row matched through fields not visible in place
        hasDetailsSearchMatch(row) {
            if (!this.searchActive || this.detailsColumns.length === 0) return false;
            return this.isDetailsOnlyMatch(row);
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
            <!-- Drag Follower UI -->
            <div v-if="shouldShowDragFollower" class="drag-follower" :style="dragFollowerStyle">
                {{ dragFollowerText }}
            </div>
            <!-- Selection Action Bubble (outside table) -->
            <transition name="fade">
                <div v-if="shouldShowSelectionBubble" :selectedCount="selectedRowCount" class="selection-action-bubble" :style="selectionBubbleStyle">
                    <template v-if="isInClipboardMode">
                        <button @click="cancelClipboard" class="button-symbol white" title="Cancel (Esc)"><span class="material-symbols-outlined">close</span></button>
                    </template>
                    <template v-else>
                        <button v-if="newRow && hasConsecutiveSelection" @click="handleAddRowAbove" class="button-symbol white" title="Add Row Above">+</button>
                        <button @click="handleDeleteSelected" :class="['button-symbol', areAllSelectedMarkedForDeletion ? 'green' : 'red']" title="Delete Selected"><span v-if="areAllSelectedMarkedForDeletion" class="material-symbols-outlined">restore_from_trash</span><span v-else class="material-symbols-outlined">delete</span></button>
                        <button v-if="canCreateGroupFromSelection" @click="handleCreateGroupFromSelection" class="button-symbol white" title="Group Selected Rows">
                            <span class="material-symbols-outlined">cell_merge</span>
                        </button>
                        <button v-if="hasSelectedGroupMasters" @click="handleToggleSelectedGroups" class="button-symbol white" :title="groupToggleTitle">
                            <span class="material-symbols-outlined">{{ groupToggleSymbol }}</span>
                        </button>
                        <button @click="handleMoreOptions" class="button-symbol blue" title="More Row Options">☰</button>
                        <button v-if="newRow && hasConsecutiveSelection" @click="handleAddRowBelow" class="button-symbol white" title="Add Row Below">+</button>
                        <slot
                            name="selection-actions"
                            :selectedRows="getSelectedRows()"
                            :selectedIndices="getSelectedRowIndices()"
                        >
                            <!-- Default content if no slot provided -->
                        </slot>
                    </template>
                </div>
            </transition>
            
            <!-- Error State -->
            <div key="error-state" v-if="error" class="content-header red">
                <span>Error: {{ error }}</span>
            </div>

            <!-- Spacer: holds layout space when sticky wrapper becomes fixed -->
            <div class="sticky-header-spacer" :style="{ height: stickyActive ? stickySpacerHeight + 'px' : '0' }" aria-hidden="true"></div>

            <!-- Sticky wrapper: content-header + loading bar + thead clone (all fixed together when sticky) -->
            <div class="sticky-header-wrapper" :style="stickyActive ? { position: 'fixed', left: stickyLeft + 'px', width: stickyWidth + 'px', zIndex: '1000' } : {}">

                <ContentHeaderComponent
                    key="content-header"
                    v-if="showHeader && (title || showRefresh || showSearch)"
                    :theme="theme"
                    :search="search"
                    :show-search="showSearch && !parentSearchValue"
                    :match-count="searchMatchCount"
                    :show-hide-toggle="hideRowsByDefault"
                    v-model:hide-rows="hideRowsOnSearchLocal"
                    :show-refresh="showRefresh"
                    :is-loading="isLoading"
                    :dirty="hasUnsavedEdits"
                    :view-select="viewSelect"
                    @refresh="handleRefresh"
                >
                    <template #header-area><slot name="header-area"></slot></template>
                    <template #actions>
                        <button
                            v-if="showNewRowButton"
                            @click="$emit('new-row')"
                            :disabled="isLoading"
                            :class="theme"
                        >
                            New Item
                        </button>
                        <button
                            v-if="showSaveButton || hasUnsavedEdits"
                            @click="handleSave"
                            :disabled="isLoading || !hasUnsavedEdits"
                            class="green"
                        >
                            Save
                        </button>
                    </template>
                    <template #actions-end>
                        <button
                            v-if="isBatchEditing && showUndoRedo"
                            @click="handleUndo"
                            :disabled="!canUndo"
                            class="button-symbol white"
                            title="Undo"
                        >
                            ⮢
                        </button>
                        <button
                            v-if="isBatchEditing && showUndoRedo"
                            @click="handleRedo"
                            :disabled="!canRedo"
                            class="button-symbol white"
                            title="Redo"
                        >
                            ⮣
                        </button>
                    </template>
                </ContentHeaderComponent>

                <!-- Loading/Analysis Progress Indicator -->
                <LoadingBarComponent
                    :key="key + 'loading-progress'"
                    v-if="showHeader"
                    :is-loading="isLoading"
                    :is-analyzing="isAnalyzing"
                    :percent-complete="loadingProgress"
                />

                <!-- Sticky Header Clone (thead only, mirrors column widths) -->
                <table v-if="showStickyHeader" :class="{ editing: isBatchEditing, [dragId]: dragId, 'sticky-header': true }" :style="stickyScrollLeft ? { transform: 'translateX(-' + stickyScrollLeft + 'px)' } : {}">
                    <colgroup>
                        <col v-if="draggable" :style="stickyColumnWidths[0] ? { width: stickyColumnWidths[0] + 'px' } : { width: '20px' }" />
                        <col v-for="(column, colIdx) in headerColumns" 
                            :key="column.key"
                            :style="stickyColumnWidths[draggable ? colIdx + 1 : colIdx] ? { width: stickyColumnWidths[draggable ? colIdx + 1 : colIdx] + 'px' } : (column.width ? { width: column.width + 'px' } : {})"
                            :class="column.columnClass || ''"
                        />
                        <col v-if="hasActionCell" :style="stickyColumnWidths[stickyColumnWidths.length - 1] ? { width: stickyColumnWidths[stickyColumnWidths.length - 1] + 'px' } : {}" />
                    </colgroup>
                    <thead :class="{ [theme]: true, active: theadActive }" @click="handleTheadTap($event)">
                        <tr>
                            <th v-if="draggable" class="spacer-cell" :style="stickyColumnWidths[0] ? { width: stickyColumnWidths[0] + 'px' } : {}"></th>
                            <th
                                v-for="(column, colIdx) in headerColumns"
                                :key="column.key"
                                :class="[getColumnFont(column), getStickyColProps(column)?.stickyClass, slotByKey.get(column.key)?.headerLines.length > 1 ? 'stacked-header' : '']"
                                :title="column.title || column.label"
                                :style="[stickyColumnWidths[draggable ? colIdx + 1 : colIdx] ? { width: stickyColumnWidths[draggable ? colIdx + 1 : colIdx] + 'px' } : {}, getCloneStickyThStyle(column, colIdx)]"
                            >
                                <div v-for="(line, li) in slotByKey.get(column.key).headerLines" :key="li" :class="li > 0 ? 'stack-line' : ''">
                                    <template v-for="(col, ci) in line" :key="col.key">
                                        <span v-if="ci > 0" class="chip-sep"> | </span>
                                        <span v-if="col.labelHtml" v-html="col.labelHtml"></span>
                                        <span v-else>{{ col.label }}</span>
                                        <button
                                            v-if="isColumnSortable(col)"
                                            @click="handleSort(col.key)"
                                            :class="'column-button ' + (sortColumn === col.key ? 'active' : '')"
                                        >
                                            <span class="material-symbols-outlined">{{ getSortIcon(col.key) || 'swap_vert' }}</span>
                                        </button>
                                    </template>
                                </div>
                            </th>
                            <th v-if="hasActionCell" class="details-header col-sticky-end" style="font-size: 20px; line-height: 1em;" :style="[stickyColumnWidths[stickyColumnWidths.length - 1] ? { width: stickyColumnWidths[stickyColumnWidths.length - 1] + 'px' } : {}, cloneDetailsStickyTransform ? { transform: cloneDetailsStickyTransform } : {}]"><span v-if="isSymbolName(actionHeader)" class="material-symbols-outlined">{{ actionHeader }}</span><template v-else>{{ actionHeader }}</template></th>
                        </tr>
                    </thead>
                </table>

            </div>

            <!-- Data Table (always render if draggable, even when empty) -->
            <div key="data-table" v-if="(data && data.length > 0) || (draggable && !isLoading)" :class="'table-wrapper' + (theme ? ' ' + theme : '')">
                <table :class="{ editing: isBatchEditing, [dragId]: dragId }">
                    <colgroup>
                        <col v-if="draggable" :style="{ width: '20px' }" />
                        <col v-for="(column, colIdx) in headerColumns" 
                            :key="column.key"
                            :style="column.width ? 'width:' + column.width + 'px' : ''"
                            :class="column.columnClass || ''"
                        />
                        <col v-if="hasActionCell" />
                    </colgroup>
                    <thead :class="{ [theme]: true, 'drop-target-header': dropTarget?.type === 'header', active: theadActive }" @click="handleClipboardHeaderClick($event); handleTheadTap($event)">
                        <tr>
                            <th v-if="draggable" class="spacer-cell"></th>
                            <th
                                v-for="(column, colIdx) in headerColumns"
                                :key="column.key"
                                :class="[getColumnFont(column), getStickyColProps(column)?.stickyClass, slotByKey.get(column.key)?.headerLines.length > 1 ? 'stacked-header' : '']"
                                :title="column.title || column.label"
                                :style="getStickyColProps(column)?.stickyStyle"
                            >
                                <div v-for="(line, li) in slotByKey.get(column.key).headerLines" :key="li" :class="li > 0 ? 'stack-line' : ''">
                                    <template v-for="(col, ci) in line" :key="col.key">
                                        <span v-if="ci > 0" class="chip-sep"> | </span>
                                        <span v-if="col.labelHtml" v-html="col.labelHtml"></span>
                                        <span v-else>{{ col.label }}</span>
                                        <button
                                            v-if="isColumnSortable(col)"
                                            @click="handleSort(col.key)"
                                            :class="'column-button ' + (sortColumn === col.key ? 'active' : '')"
                                        >
                                            <span class="material-symbols-outlined">{{ getSortIcon(col.key) || 'swap_vert' }}</span>
                                        </button>
                                    </template>
                                </div>
                            </th>
                            <th v-if="hasActionCell" class="details-header col-sticky-end" style="font-size: 20px; line-height: 1em; right: 0;" :title="effectiveAction.kind === 'details' ? 'Details' : (effectiveAction.title || effectiveAction.label || '')"><span v-if="isSymbolName(actionHeader)" class="material-symbols-outlined">{{ actionHeader }}</span><template v-else>{{ actionHeader }}</template></th>
                        </tr>
                    </thead>
                    <tbody>
                        <template v-for="({ row, idx }, visibleIdx) in visibleRows" :key="idx">
                            <tr 
                                :data-visible-idx="visibleIdx"
                                :data-search-match-idx="searchMatchIndexMap.get(idx)"
                                :class="[
                                    {
                                        'dragging': isRowDragging(idx),
                                        'drag-over': false,
                                        'selected': isBatchEditing && isRowSelected(idx),
                                        'analyzing': isRowAnalyzing(idx),
                                        'marked-for-deletion': isRowMarkedForDeletion(row),
                                        'in-group': isRowInGroup(idx),
                                        'is-group': isRowGroupMaster(idx),
                                        'drop-target-above': dropTarget?.type === 'between' && dropTarget?.visualTargetIndex === visibleIdx,
                                        'drop-target-below': dropTarget?.type === 'between' && dropTarget?.visualTargetIndex === visibleIdx + 1,
                                        'drop-target-onto': dropTarget?.type === 'onto' && dropTarget?.targetIndex === idx,
                                        'clickable row-action': hasRowTrigger && !isActionDisabled(row),
                                        'details-match': hasRowTrigger && isDetailsOnlyMatch(row)
                                    },
                                    getRowMetadataClass(row),
                                    rowColorClass(row)
                                ]"
                                :tabindex="hasRowTrigger ? 0 : null"
                                @click="handleClipboardRowClick(idx, visibleIdx, $event); handleSearchResultClick(idx); handleRowTriggerClick(row, idx, $event)"
                                @keydown="handleRowTriggerKey(row, idx, $event)"
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
                                    :class="[getCellClass(row[column.key], column, idx), getStickyColProps(column)?.stickyClass, cellStateClass(row, idx, column)]"
                                    :style="getStickyColProps(column)?.stickyStyle"
                                    @click="handleEditableCellContainerClick(column, $event)"
                                    @focusout="handleCellBlur"
                                >
                                    <div :class="['table-cell-container', { 'search-match': hasSearchMatch(row[column.key], column), 'search-active-result': hasSearchMatch(row[column.key], column) && searchMatchIndexMap.get(idx) === search.searchIndex.value - 1 }]">
                                        <!-- Editable number: the saved value (click to revert) while changed, then the input (+ or - starts a calculation) -->
                                        <slot
                                            v-if="column.editable && column.format === 'number'"
                                            :row="row"
                                            :column="column">
                                            <NumberCellInput
                                                :row="row"
                                                :field="column.key"
                                                :commit="(value) => commitCellValue(idx, column, value)"
                                                :original="savedCellValue(row, idx, column)"
                                                :original-label="formatCellValue(savedCellValue(row, idx, column), column)"
                                                :changed="showRevert(row, idx, column)"
                                                :revert="isBatchEditing ? (event) => revertCellToOriginal(idx, column, event) : null"
                                            />
                                        </slot>
                                        <!-- Registry or page cell (editable text fields use the text cell) -->
                                        <CellRenderer
                                            v-else-if="column.cell"
                                            :row="row"
                                            :field="column"
                                            renderer="table"
                                            density="full"
                                            :search-term="activeSearchKey"
                                            :highlight="highlightSearchText"
                                            :theme="theme"
                                            :cell-slot="$slots.cell"
                                            :editable="column.editable"
                                            :edit-mode="editMode"
                                            :commit="(value) => commitCellValue(idx, column, value)"
                                            :disabled="cellDisabledReason(row, column)"
                                            :row-action="column.cell === 'action' ? rowActionFor(row, idx) : null"
                                            :original="batchEdits.originalValue(row, idx, column.key)"
                                            :cell-scope="{ rowIndex: idx, onInnerTableDirty: (isDirty) => batchEdits.setNested(idx, column.key, isDirty) }"
                                        />
                                        <span v-else v-html="highlightSearchText(row[column.key], column)"></span>
                                        <!-- Changed batch cell (not number): revert button; its hint shows the original over the editor -->
                                        <template v-if="column.format !== 'number' && showRevert(row, idx, column)">
                                            <span class="column-button-hint">{{ formatCellValue(batchEdits.originalValue(row, idx, column.key), column) || '(empty)' }}</span>
                                            <button
                                                @click="revertCellToOriginal(idx, column, $event)"
                                                title="Revert to original value"
                                                class="column-button red">
                                                ⮢
                                            </button>
                                        </template>

                                        <!-- Inline keys on the slot's first line -->
                                        <template v-for="col in (slotByKey.get(column.key)?.inline || [])" :key="col.key">
                                            <span class="chip-sep"> | </span>
                                            <span :class="[cellColorClass(row, col), { 'search-match': hasSearchMatch(row[col.key], col) }]">
                                                <CellRenderer v-if="col.cell" :row="row" :field="col" renderer="table" density="full" :search-term="activeSearchKey" :highlight="highlightSearchText" :theme="theme" :cell-slot="$slots.cell" :cell-scope="{ rowIndex: idx }" />
                                                <span v-else v-html="highlightSearchText(row[col.key], col)"></span>
                                            </span>
                                            <DecorationCards v-if="decorations" :cards="cellDecorations(row, col.key)" :inline="true" />
                                        </template>

                                        <!-- Decorations for this key (§4.14) -->
                                        <DecorationCards v-if="decorations" :cards="cellDecorations(row, column.key)" />

                                        <!-- Additional cell content slot (for warnings, etc.) -->
                                        <slot 
                                            name="cell-extra"
                                            :row="row" 
                                            :rowIndex="idx" 
                                            :column="column"
                                            :cellRowIndex="idx"
                                            :cellColIndex="colIndex"
                                            :isGroupMembersHidden="isGroupMembersHidden(idx)"
                                            :showGroup="() => showGroup(idx)"
                                            :isEditable="column.editable"
                                        ></slot>
                                    </div>
                                    <!-- Stacked lines (N-high, parent-owned): each line lists its keys inline -->
                                    <div
                                        v-for="(line, li) in (slotByKey.get(column.key)?.lines || [])"
                                        :key="'line-' + li"
                                        :class="['table-cell-container', 'stacked-child-cell', { 'search-match': line.some(c => hasSearchMatch(row[c.key], c)) }]"
                                    >
                                        <template v-for="(col, ci) in line" :key="col.key">
                                            <span v-if="ci > 0" class="chip-sep"> | </span>
                                            <span :class="cellColorClass(row, col)">
                                                <CellRenderer v-if="col.cell" :row="row" :field="col" renderer="table" density="full" :search-term="activeSearchKey" :highlight="highlightSearchText" :theme="theme" :cell-slot="$slots.cell" :cell-scope="{ rowIndex: idx }" />
                                                <span v-else v-html="highlightSearchText(row[col.key], col)"></span>
                                            </span>
                                            <DecorationCards v-if="decorations" :cards="cellDecorations(row, col.key)" />
                                        </template>
                                    </div>
                                </td>
                                <td v-if="hasActionCell" class="details-cell col-sticky-end" :style="{ right: '0' }">
                                        <button
                                            v-if="effectiveAction.kind === 'details'"
                                            @click="toggleRowDetails(idx)"
                                            title="Toggle Details"
                                            :class="[theme, 'button-symbol', 'details-toggle', isRowExpanded(idx) ? 'expanded' : 'collapsed', hasDetailsSearchMatch(row) ? 'search-match' : '']"
                                        >
                                            <span v-if="isRowExpanded(idx)" class="material-symbols-outlined">close</span>
                                            <span v-else-if="isSymbolName(effectiveAction.icon)" class="material-symbols-outlined">{{ effectiveAction.icon }}</span>
                                            <template v-else>{{ effectiveAction.icon || '☷' }}</template>
                                        </button>
                                        <button
                                            v-else
                                            @click.stop="performAction(row, idx)"
                                            :disabled="isActionDisabled(row)"
                                            :title="effectiveAction.title || effectiveAction.label || 'Open'"
                                            :class="[theme, effectiveAction.label ? 'action-button' : 'button-symbol', 'row-action-button', isDetailsOnlyMatch(row) ? 'search-match' : '']"
                                        ><template v-if="effectiveAction.label">{{ effectiveAction.label }}</template><span v-else-if="isSymbolName(effectiveAction.icon)" class="material-symbols-outlined">{{ effectiveAction.icon }}</span><template v-else>{{ effectiveAction.icon || '☷' }}</template></button>
                                </td>
                            </tr>
                            
                            <!-- Group expand/collapse button between rows -->
                            
                            <button
                                v-if="isRowGroupMaster(idx)"
                                class="column-button between-rows" 
                                :title="getGroupToggleTitle(idx)"
                                @click="toggleGroupCollapse(idx)"
                            >
                                <span class="material-symbols-outlined">{{ getGroupToggleIcon(idx) }}</span>
                            </button>
                            
                            <!-- Column-aligned detail rows (row-detail-rows slot) -->
                            <template v-if="detailRowsEnabled && $slots['row-detail-rows'] && shouldShowDetailsContent(row, idx)">
                                <slot name="row-detail-rows" :row="row" :rowIndex="idx" :visibleColumns="visibleColumns" :hasActionCell="hasActionCell" />
                            </template>

                            <!-- Expandable single-cell details row (details grid + row-details slot) -->
                            <tr v-if="detailRowsEnabled && !$slots['row-detail-rows']" class="details-row-container">
                                <td v-if="draggable"></td>
                                <td :colspan="headerColumns.length + (hasActionCell ? 1 : 0)" class="details-container">

                                    <div v-if="shouldShowDetailsContent(row, idx)" class="content" :style="tableWrapperWidth ? { width: (tableWrapperWidth - 2) + 'px' } : {}">
                                        <RowDetailsComponent
                                            :row="row"
                                            :fields="detailsColumns"
                                            :highlight="highlightSearchText"
                                            :cell-slot="$slots.cell"
                                            :search-term="activeSearchKey"
                                            :theme="theme"
                                        >
                                            <!-- Custom slot content -->
                                            <slot
                                                name="row-details"
                                                :row="row"
                                                :rowIndex="idx"
                                                :isExpanded="isRowExpanded(idx)"
                                                :detailsColumns="detailsColumns"
                                            >
                                            </slot>
                                            <!-- Row-level decorations (and decorated keys not shown in place) -->
                                            <div v-if="decorations && rowLevelDecorations(row).length > 0" class="button-bar">
                                                <DecorationCards :cards="rowLevelDecorations(row)" />
                                            </div>
                                        </RowDetailsComponent>
                                    </div>
                                </td>
                            </tr>
                        </template>
                        
                        <!-- Empty state row for draggable tables -->
                        <tr v-if="draggable && (!data || data.length === 0)" class="empty-drop-target">
                            <td class="spacer-cell"></td>
                            <td
                                :colspan="headerColumns.length + (hasActionCell ? 1 : 0)"
                                class="empty-message"
                                style="text-align: center;"
                            >
                                {{ isLoading || isAnalyzing ? loadingMessage : emptyMessage }}
                            </td>
                        </tr>
                    </tbody>
                    <tfoot v-if="newRow">
                        <tr>
                            <td v-if="draggable" class="spacer-cell"></td>
                            <td 
                                :colspan="headerColumns.length + (hasActionCell ? 1 : 0)"
                                class="new-row-button"
                                title="Add new row"
                                @click="isInClipboardMode && dropTarget?.type === 'footer' ? completeClipboardAtCurrentTarget() : $emit('new-row')"
                            >
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        

            <!-- Loading State >
            <div key="loading-state" v-if="isLoading || isAnalyzing" class="content-footer loading-message">
                <img src="assets/loading.gif" alt="..."/>
                <p>{{ loadingMessage }}</p>
            </div-->

            <!-- Data Summary -->
            <div key="data-summary" v-if="showFooter" :class="['content-footer', theme ]">
                <p v-if="isLoading || isAnalyzing" class="loading-message">{{ loadingMessage }}</p>
                <p v-else-if="visibleRows.length < data.length">Showing {{ visibleRows.length }} of {{ data.length }} row{{ data.length !== 1 ? 's' : '' }}</p>
                <p v-else-if="!data || data.length === 0" class="empty-message">{{ emptyMessage }}</p>
                <p v-else>Showing {{ data.length }} row{{ data.length !== 1 ? 's' : '' }}</p>
                
                <button
                    v-if="searchActive && hideRowsOnSearchLocal"
                    @click="search.clearSearch"
                    class="card yellow"
                    style="width: auto;"
                    title="Clear filter"
                >
                    Show all
                </button>
                
                
            </div>
            <div class="content-footer red"  v-if="showFooter && hasUnsavedEdits"><p>There are unsaved changes in this table.</p></div>
        </div>
    `
};
