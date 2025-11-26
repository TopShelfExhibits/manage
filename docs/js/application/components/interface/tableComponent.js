import { html, parseDate, LoadingBarComponent } from '../../index.js';

// Global table row selection state - single source of truth for all selections
export const tableRowSelectionState = Vue.reactive({
    // Selection map with unique keys to handle multiple tables
    selections: new Map(), // Map of selectionKey -> { rowIndex: number, sourceArray: arrayRef, dragId: dragId }
    
    // Configuration options
    allowMultiSourceDrag: true, // Allow dragging selections from different data sources
    
    // Drag state
    findingDropTargets: false,
    dragSourceArray: null,
    dragTargetArray: null,
    dragId: null, // The dragId of the table group participating in drag operations
    currentDropTarget: null, // Current registered drop target from tables
    
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
    
    // Add a row to global selection
    addRow(rowIndex, sourceArray, dragId = null) {
        if (dragId && dragId !== this.dragId) {
            this.clearAll();
        }

        const selectionKey = this._getSelectionKey(rowIndex, sourceArray);
        this.selections.set(selectionKey, {
            rowIndex: rowIndex,
            sourceArray: sourceArray,
            dragId: dragId
        });
        this.dragId = dragId;
    },
    
    // Remove a row from global selection
    removeRow(rowIndex, sourceArray) {
        const selectionKey = this._getSelectionKey(rowIndex, sourceArray);
        this.selections.delete(selectionKey);
    },
    
    // Toggle row selection
    toggleRow(rowIndex, sourceArray, dragId = null) {
        if (this.hasRow(sourceArray, rowIndex)) {
            this.removeRow(rowIndex, sourceArray)
        } else {
            this.addRow(rowIndex, sourceArray, dragId)
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
    },
    
    // Clear selections from a specific array
    clearArray(sourceArray) {
        for (const [selectionKey, selection] of this.selections) {
            if (selection.sourceArray === sourceArray) {
                this.selections.delete(selectionKey);
            }
        }
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
        const sources = this.getSelectedDataSources();
        return sources.length <= 1;
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
    
    // Keyboard action methods
    clearAllSelections() {
        // Clear all selections (used by Escape key)
        this.clearAll();
        console.log('All selections cleared via keyboard');
    },
    
    markSelectedForDeletion(Value = true) {
        // Mark all selected rows for deletion (used by Delete key)
        if (this.selections.size === 0) {
            console.log('No selections to mark for deletion');
            return;
        }
        
        let deletedCount = 0;
        for (const [selectionKey, selection] of this.selections) {
            const { rowIndex, sourceArray } = selection;
            if (sourceArray[rowIndex]) {
                // Ensure AppData exists
                if (!sourceArray[rowIndex].AppData) {
                    sourceArray[rowIndex].AppData = {};
                }
                
                // Mark for deletion
                sourceArray[rowIndex].AppData['marked-for-deletion'] = Value;
                deletedCount++;
            }
        }
        
        console.log(`Marked ${deletedCount} selected rows for deletion = ${Value}`);
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
        
        // Set up global mouse up listener with proper binding
        this.handleGlobalMouseUp = this.handleGlobalMouseUp.bind(this);
        document.addEventListener('mouseup', this.handleGlobalMouseUp);
        return true;
    },
    
    // Register drop target from a table
    registerDropTarget(tableData, dropTarget) {
        if (this.findingDropTargets) {
            this.currentDropTarget = dropTarget;
            this.dragTargetArray = tableData;
            // Handle deletion marking based on drop target
            this.markSelectedForDeletion((this.dragSourceArray === tableData && dropTarget.type === 'footer'));
        }
    },
    
    // Clear drop target registration
    clearDropTargetRegistration(tableData) {
        if (this.dragTargetArray === tableData) {
            // Before clearing, remove any deletion markings since we're no longer over a footer
            if (this.currentDropTarget && this.currentDropTarget.type === 'footer') {
                this.markSelectedForDeletion(false);
            }
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
    
    completeDrag(dropTarget) {
        console.log('completeDrag called with:', dropTarget, 'findingDropTargets:', this.findingDropTargets, 'selections:', this.selections.size, 'dragTargetArray:', this.dragTargetArray);
        if (!this.findingDropTargets || this.selections.size === 0 || !this.dragTargetArray) {
            console.log('completeDrag early exit - conditions not met');
            this.stopDrag();
            return false;
        }
        
        // Group selections by source array
        const selectionsBySource = this.getSelectionSummary();
        
        if (selectionsBySource.size === 0) {
            console.log('No selections found');
            this.stopDrag();
            return false;
        }
        
        // Calculate insertion position
        let insertPosition;
        console.log('dropTarget.type:', dropTarget.type);
        if (dropTarget.type === 'header') {
            insertPosition = 0;
        } else if (dropTarget.type === 'footer') {
            // For footer drops, insert after the last element (at the end of the array)
            insertPosition = this.dragTargetArray.length;
        } else if (dropTarget.type === 'between') {
            insertPosition = dropTarget.targetIndex;
        } else {
            console.log('Invalid dropTarget.type:', dropTarget.type);
            this.stopDrag();
            return false;
        }
        
        // Perform atomic move operation to prevent reactivity issues
        try {
            let totalRowsInserted = 0;
            
            // Process each source array
            for (const [sourceArray, sourceInfo] of selectionsBySource) {
                console.log(`Processing source with ${sourceInfo.count} rows from ${sourceInfo.dragId || 'unknown'}`);
                
                // Sort row indices in ascending order to preserve original order
                const sortedIndicesAsc = sourceInfo.rowIndices.sort((a, b) => a - b);
                // Sort row indices in reverse order (highest first) for safe removal
                const sortedIndicesDesc = [...sortedIndicesAsc].reverse();
                
                // Extract row data BEFORE removal using ascending order to preserve original sequence
                const rowsData = sortedIndicesAsc.map(index => sourceArray[index]).filter(row => row !== undefined);
                
                if (sourceArray === this.dragTargetArray) {
                    // Same array: reorder rows
                    console.log('Same array reorder - insertPosition:', insertPosition + totalRowsInserted);
                    
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
                    console.log('Different arrays move - from:', sourceArray.length, 'to:', this.dragTargetArray.length, 'insertPosition:', insertPosition + totalRowsInserted);
                    
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
                    console.log('After move - from:', sourceArray.length, 'to:', this.dragTargetArray.length);
                }
            }
            
            console.log(`Total rows moved: ${totalRowsInserted}`);
        } catch (error) {
            console.error('Error during drag operation:', error);
            this.stopDrag();
            return false;
        }
        
        // Clear selection and drag state
        this.stopDrag(true);
        this.clearAll();
        return true;
    },
    
    stopDrag(preserveDeletionMarkings = false) {
        // Clean up any temporary deletion markings before stopping drag
        // unless explicitly preserving them (e.g., successful footer drop)
        if (!preserveDeletionMarkings) {
            this.markSelectedForDeletion(false);
        }
        
        this.findingDropTargets = false;
        this.dragSourceArray = null;
        this.dragTargetArray = null;
        this.dragId = null;
        this.currentDropTarget = null;
        
        // Remove global mouse up listener
        document.removeEventListener('mouseup', this.handleGlobalMouseUp);
    }
});

export const TableComponent = {
    name: 'TableComponent',
    components: { LoadingBarComponent },
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
        sortable: {
            type: Boolean,
            default: false
        },
        searchTerm: {
            type: String,
            default: ''
        },
        hideRowsOnSearch: {
            type: Boolean,
            default: true
        },
        allowDetails: {
            type: Boolean,
            default: false
        }
    },
    emits: ['refresh', 'cell-edit', 'new-row', 'inner-table-dirty', 'show-hamburger-menu', 'search'],
    data() {
        return {
            dirtyCells: {},
            allowSaveEvent: false,
            nestedTableDirtyCells: {}, // Track dirty state for nested tables by [row][col]
            searchValue: this.searchTerm || '', // Initialize with searchTerm prop
            sortColumn: null, // Current sort column key
            sortDirection: 'asc', // Current sort direction: 'asc' or 'desc'
            expandedRows: new Set(), // Track which rows are expanded for details
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
                lastHoveredRowIndex: null
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
            hiddenColumns: [] // Reactive property for dynamically hiding columns (internal use only)
        };
    },
    watch: {
        // Watch for changes to searchTerm prop and update internal searchValue
        searchTerm(newValue) {
            this.searchValue = newValue || '';
        },
        // Watch for changes to originalData prop and recompare dirty state
        originalData: {
            handler() {
                this.$nextTick(() => {
                    this.compareAllCellsDirty();
                });
            },
            deep: true
        }
    },
    computed: {
        selectedRowCount() {
            return tableRowSelectionState.getArraySelectionCount(this.data);
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
            // Hide columns from hideColumns prop, hiddenColumns reactive data, and always hide 'AppData' and 'MetaData'
            return new Set([...(this.hideColumns || []), 'AppData', 'MetaData', ...(this.hiddenColumns || [])]);
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

            // Apply search filter if searchValue is provided and hideRowsOnSearch is enabled
            if (this.searchValue && this.searchValue.trim() && this.hideRowsOnSearch) {
                const searchTerm = this.searchValue.toLowerCase().trim();
                filteredData = filteredData.filter(({ row }) => {
                    if (!row) return false;
                    // Only search visible columns (exclude hidden columns)
                    const visibleColumns = this.columns.filter(column => !this.hideSet.has(column.key));
                    return visibleColumns.some(column => {
                        const value = row[column.key];
                        return String(value).toLowerCase().includes(searchTerm);
                    });
                });
            }

            // Apply sorting if sortColumn is set
            if (this.sortColumn && this.sortable) {
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

            return filteredData;
        }
    },
    watch: {
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
            deep: true
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
        }
    },
    mounted() {
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
            // Create a clone of thead for sticky positioning
            this.stickyHeaderClone = null;
            
            this.handleStickyHeaders = () => {
                const thead = this.$el.querySelector('thead');
                if (!thead) return;

                const table = this.$el.querySelector('table');
                if (!table) return;

                // Get CSS variable values
                const computedStyle = getComputedStyle(document.documentElement);
                const navbarHeight = parseInt(computedStyle.getPropertyValue('--navbar-height')) || 0;
                const stickyOffset = navbarHeight;

                // Get positions
                const tableRect = table.getBoundingClientRect();
                const theadRect = thead.getBoundingClientRect();

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

                if (shouldStick && !this.stickyHeaderClone) {
                    // Create and position the clone
                    this.stickyHeaderClone = thead.cloneNode(true);
                    this.stickyHeaderClone.style.position = 'fixed';
                    this.stickyHeaderClone.style.top = stickyOffset + 'px';
                    this.stickyHeaderClone.style.left = tableRect.left + 'px';
                    this.stickyHeaderClone.style.width = tableRect.width + 'px';
                    this.stickyHeaderClone.style.zIndex = '10';
                    this.stickyHeaderClone.style.boxShadow = '0 4px 8px var(--color-shadow)';
                    this.stickyHeaderClone.style.tableLayout = 'fixed';
                    this.stickyHeaderClone.classList.add('sticky-header-clone');
                    
                    // Create a wrapper table to maintain proper table structure
                    const wrapperTable = document.createElement('table');
                    wrapperTable.style.position = 'fixed';
                    wrapperTable.style.top = stickyOffset + 'px';
                    wrapperTable.style.left = tableRect.left + 'px';
                    wrapperTable.style.width = tableRect.width + 'px';
                    wrapperTable.style.zIndex = '10';
                    wrapperTable.style.boxShadow = '0 4px 8px var(--color-shadow)';
                    wrapperTable.style.tableLayout = 'fixed';
                    wrapperTable.style.borderCollapse = 'collapse';
                    wrapperTable.style.background = 'var(--background-color)';
                    wrapperTable.className = table.className;
                    
                    // Clone colgroup to preserve column widths
                    const colgroup = table.querySelector('colgroup');
                    if (colgroup) {
                        const clonedColgroup = colgroup.cloneNode(true);
                        wrapperTable.appendChild(clonedColgroup);
                    }
                    
                    // Append cloned thead to wrapper table
                    wrapperTable.appendChild(this.stickyHeaderClone);
                    
                    // Copy exact computed widths from original header cells to clone cells
                    const originalCells = thead.querySelectorAll('th');
                    const cloneCells = this.stickyHeaderClone.querySelectorAll('th');
                    originalCells.forEach((cell, i) => {
                        if (cloneCells[i]) {
                            const computedWidth = window.getComputedStyle(cell).width;
                            cloneCells[i].style.width = computedWidth;
                            cloneCells[i].style.minWidth = computedWidth;
                            cloneCells[i].style.maxWidth = computedWidth;
                        }
                    });
                    
                    // Store reference to wrapper table
                    this.stickyHeaderWrapper = wrapperTable;
                    table.parentElement.appendChild(wrapperTable);
                } else if (!shouldStick && this.stickyHeaderWrapper) {
                    // Remove the clone
                    this.stickyHeaderWrapper.remove();
                    this.stickyHeaderWrapper = null;
                    this.stickyHeaderClone = null;
                } else if (shouldStick && this.stickyHeaderWrapper) {
                    // Update position if scrolling horizontally
                    this.stickyHeaderWrapper.style.left = tableRect.left + 'px';
                }
            };
            
            appContent.addEventListener('scroll', this.handleStickyHeaders, { passive: true });
            this.handleStickyHeaders(); // Initial position
        }
    },
    beforeUnmount() {
        document.removeEventListener('click', this.handleOutsideClick);
        document.removeEventListener('keydown', this.handleEscapeKey);
        // Clean up any active click state
        this.resetClickState();
        
        // Clean up sticky header clone and scroll listener
        const appContent = document.querySelector('#app-content');
        if (appContent && this.handleStickyHeaders) {
            appContent.removeEventListener('scroll', this.handleStickyHeaders);
        }
        if (this.stickyHeaderWrapper) {
            this.stickyHeaderWrapper.remove();
            this.stickyHeaderWrapper = null;
            this.stickyHeaderClone = null;
        }
    },
    methods: {
        handleRefresh() {
            this.$emit('refresh');
            // Clear hidden columns on refresh
            this.hiddenColumns = [];
            // Also clear dirty state for nested tables on refresh
            this.nestedTableDirtyCells = {};
        },

        // Selection helper methods
        isRowSelected(rowIndex) {
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

        handleSort(columnKey) {
            if (!this.sortable) return;
            
            if (this.sortColumn === columnKey) {
                // Toggle sort direction if same column
                this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                // New column, start with ascending
                this.sortColumn = columnKey;
                this.sortDirection = 'asc';
            }
        },

        getSortIcon(columnKey) {
            if (!this.sortable || this.sortColumn !== columnKey) return '';
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

        highlightSearchText(value, column) {
            // First format the value
            const formattedValue = this.formatCellValue(value, column);
            
            // If no search value or empty formatted value, return as-is
            if (!this.searchValue || !this.searchValue.trim() || !formattedValue) {
                return formattedValue;
            }
            
            // Escape HTML in the formatted value to prevent XSS
            const escapedValue = String(formattedValue)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
            
            // Escape the search term for regex
            const searchTerm = this.searchValue.trim();
            const escapedSearchTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            
            // Create case-insensitive regex to find matches
            const regex = new RegExp(`(${escapedSearchTerm})`, 'gi');
            
            // Replace matches with highlighted version
            return escapedValue.replace(regex, '<span class="search-match">$1</span>');
        },

        // Check if a value contains the search text (for CSS-based highlighting in inputs)
        hasSearchMatch(value, column) {
            if (!this.searchValue || !this.searchValue.trim()) {
                return false;
            }
            
            const formattedValue = this.formatCellValue(value, column);
            if (!formattedValue) return false;
            
            const searchTerm = this.searchValue.trim().toLowerCase();
            return String(formattedValue).toLowerCase().includes(searchTerm);
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
            // Also, if any row is marked for deletion, allow save event
            if (!this.allowSaveEvent && Array.isArray(this.data)) {
                this.allowSaveEvent = this.data.some(row => row && row.AppData && row.AppData['marked-for-deletion']);
            }
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
            // Emit event to parent to show hamburger menu
            this.$emit('show-hamburger-menu', {
                menuComponent: this.hamburgerMenuComponent,
                tableId: this.title || 'table'
            });
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
            
            // Only process click logic if mouse up is on the same handle (or close enough)
            if (targetHandle && startHandle && targetHandle === startHandle) {
                // Clear long click timer
                if (this.clickState.longClickTimer) {
                    clearTimeout(this.clickState.longClickTimer);
                    this.clickState.longClickTimer = null;
                }
                
                // Short click logic (only if no movement occurred)
                if (!this.clickState.hasMoved && !this.clickState.isMultiSelecting) {
                    if (tableRowSelectionState.getTotalSelectionCount() > 0 && tableRowSelectionState.dragId === this.dragId) {
                        // Toggle selection state of clicked row
                        tableRowSelectionState.toggleRow(this.clickState.startRowIndex, this.data, this.dragId);
                    }
                }
            } else if (tableRowSelectionState.getTotalSelectionCount() > 0 && !this.clickState.isMultiSelecting) {
                // If click is not on a drag handle, clear selection
                if (!targetHandle) {
                    console.log('Click outside drag handle - clearing selection');
                    tableRowSelectionState.clearAll();
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
            
            // Remove global listeners
            document.removeEventListener('mousemove', this.handleGlobalMouseMove);
            document.removeEventListener('mouseup', this.handleGlobalMouseUp);
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
                        
                        newDropTarget = {
                            type: 'between',
                            targetIndex: targetIndex
                        };
                        console.log('Drop target found:', newDropTarget, 'visual index:', i, 'isAbove:', isAbove, 'mouseY:', mouseY, 'rowRect:', rowRect);
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
        
        isRowExpanded(rowIndex) {
            return this.expandedRows.has(rowIndex);
        },
        
        handleOutsideClick(event) {
            const clickedElement = event.target;
            
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
                    tableRowSelectionState.markSelectedForDeletion(true);
                    tableRowSelectionState.clearAll();
                    event.preventDefault();
                }
            }
        },

        hasDetailsSearchMatch(row) {
            if (!this.searchValue || !this.searchValue.trim()) {
                return false;
            }
            const searchTerm = this.searchValue.trim().toLowerCase();
            return this.detailsColumns.some(column => {
                const value = row[column.key];
                return value && String(value).toLowerCase().includes(searchTerm);
            });
        },
    },
    template: html `
        <div class="dynamic-table"
            @mouseenter="handleTableMouseEnter"
            @mouseleave="handleTableMouseLeave"
            @mousemove="handleTableMouseMove"
        >
            <!-- Error State -->
            <div key="error-state" v-if="error" class="content-header red">
                <span>Error: {{ error }}</span>
            </div>

            <div key="content-header" v-if="showHeader && (title || showRefresh || showSearch)" :class="['content-header', theme]">
                <!--h3 v-if="title">{{ title }}</h3-->
                <slot 
                    name="header-area"
                ></slot>
                <p v-if="isAnalyzing">{{ loadingMessage }}</p>
                <div v-if="showSaveButton || showRefresh || hamburgerMenuComponent || showSearch" :class="{'button-bar': showSaveButton || showRefresh || showSearch}">
                    <input
                        v-if="showSearch"
                        type="text"
                        v-model="searchValue"
                        placeholder="Find..."
                        class="search-input"
                    />
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
            <div key="data-table" v-if="(data && data.length > 0) || (draggable && !isLoading)" class="table-wrapper">
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
                                        v-if="sortable"
                                        @click="handleSort(column.key)"
                                        :class="'sort-button ' + (sortColumn === column.key ? 'active' : '')"
                                    >
                                        {{ getSortIcon(column.key) || '⭥' }}
                                    </button>
                                    <button 
                                        v-if="column.allowHide"
                                        @click="handleHideColumn(column.key)"
                                        class="sort-button"
                                        title="Hide this column"
                                    >
                                        ✕
                                    </button>
                                </div>
                            </th>
                            <th v-if="allowDetails" class="details-header" style="font-size: 20px; line-height: 1em;">&#9432;</th>
                        </tr>
                    </thead>
                    <tbody>
                        <template v-for="({ row, idx }, visibleIdx) in visibleRows" :key="idx">
                            <tr 
                                :class="{
                                    'dragging': isRowDragging(idx),
                                    'drag-over': false,
                                    'selected': isRowSelected(idx),
                                    'analyzing': isRowAnalyzing(idx),
                                    'marked-for-deletion': row.AppData && row.AppData['marked-for-deletion'],
                                    'drop-target-above': dropTarget?.type === 'between' && dropTarget?.targetIndex === visibleIdx,
                                    'drop-target-below': dropTarget?.type === 'between' && dropTarget?.targetIndex === visibleIdx + 1
                                }"
                            >
                                <td v-if="draggable"
                                    class="row-drag-handle"
                                    draggable="true"
                                    @mousedown="handleDragHandleMouseDown(idx, $event)"
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
                                                {{ formatCellValue(originalData[idx][column.key], column) }} →
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
                                        {{ isRowExpanded(idx) ? '×' : '&#9432;' }}
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
        

            <!-- Loading State >
            <div key="loading-state" v-if="isLoading || isAnalyzing" class="content-footer loading-message">
                <img src="images/loading.gif" alt="..."/>
                <p>{{ loadingMessage }}</p>
            </div-->

            <!-- Data Summary -->
            <div key="unsaved-changes" v-if="showFooter && allowSaveEvent" class="content-footer red">
                <p>There are unsaved changes in this table.</p>
            </div>
            <div key="data-summary" v-else-if="showFooter && data && data.length > 0 && !isLoading" :class="['content-footer', theme]">
                <p v-if="visibleRows.length < data.length">Showing {{ visibleRows.length }} of {{ data.length }} item{{ data.length !== 1 ? 's' : '' }}</p>
                <p v-else>Found {{ data.length }} item{{ data.length !== 1 ? 's' : '' }}</p>
            </div>
            <div key="empty-state" v-else-if="showFooter" :class="['content-footer', theme]">
                <p>{{ isLoading || isAnalyzing ? loadingMessage : emptyMessage }}</p>
            </div>
        </div>
    `
};

