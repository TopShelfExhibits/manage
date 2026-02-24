import { html, Requests, TableComponent, getReactiveStore, createAnalysisConfig, NavigationRegistry, Priority, invalidateCache, authState, undoRegistry } from '../../index.js';


// Simple modal component for entering new item number
const NewItemNumberPrompt = {
    props: ['initialItemNumber', 'existingItems', 'onConfirm'],
    data() {
        return {
            itemNumber: this.initialItemNumber,
            error: null,
            suggestion: null,
            isNewPrefix: false
        };
    },
    computed: {
        helperText() {
            if (this.error) {
                return null; // Error takes precedence
            }            if (this.isNewPrefix && this.itemNumber) {
                return `"${this.itemNumber}" is a new prefix`;
            }            if (this.suggestion) {
                return `Next available: ${this.suggestion}`;
            }
            return 'Creating a new item';
        },
        ghostText() {
            // Show the remainder of the suggestion that hasn't been typed yet
            if (!this.suggestion || !this.itemNumber) {
                return '';
            }
            
            if (this.suggestion.startsWith(this.itemNumber)) {
                return this.suggestion.substring(this.itemNumber.length);
            }
            
            return '';
        }
    },
    methods: {
        validate() {
            if (!this.itemNumber) {
                this.error = 'Item number is required';
                this.suggestion = null;
                return false;
            }
            
            const duplicate = this.existingItems.find(
                item => item.itemNumber === this.itemNumber
            );
            
            if (duplicate) {
                this.error = 'Item number already exists';
                this.suggestion = null;
                return false;
            }
            
            this.error = null;
            return true;
        },
        updateSuggestion() {
            // Detect if user is typing a prefix that matches existing items
            if (!this.itemNumber || this.itemNumber.length < 2) {
                this.isNewPrefix = false;
                return;
            }
            
            // Find items that start with the current input
            const matchingItems = this.existingItems
                .map(item => item.itemNumber)
                .filter(num => num && num.startsWith(this.itemNumber));
            
            if (matchingItems.length > 0) {
                // Try to extract pattern and suggest next number
                const pattern = this.detectPatternFromPrefix(this.itemNumber, matchingItems);
                if (pattern) {
                    this.suggestion = this.incrementPattern(pattern);
                    this.isNewPrefix = false;
                } else {
                    this.suggestion = null;
                    this.isNewPrefix = false;
                }
            } else {
                // No direct matches - check if user typed a complete item following an existing pattern
                // Extract the prefix part from user's input (e.g., "CHAIR-" from "CHAIR-005")
                const prefixMatch = this.itemNumber.match(/^([A-Za-z\-_]+)(\d+)$/);
                
                if (prefixMatch) {
                    const extractedPrefix = prefixMatch[1];
                    // Check if any items start with this extracted prefix
                    const prefixItems = this.existingItems
                        .map(item => item.itemNumber)
                        .filter(num => num && num.startsWith(extractedPrefix));
                    
                    if (prefixItems.length > 0) {
                        // This prefix exists, so not a new prefix - just show default text
                        this.suggestion = null;
                        this.isNewPrefix = false;
                    } else {
                        // Truly a new prefix
                        this.suggestion = null;
                        this.isNewPrefix = true;
                    }
                } else {
                    // User is typing a prefix (e.g., "BLAH-")
                    this.suggestion = null;
                    this.isNewPrefix = true;
                }
            }
        },
        detectPatternFromPrefix(prefix, matchingItems) {
            // Try to detect the full prefix pattern from matching items
            // even if user has only typed a partial prefix
            const patterns = {};
            
            matchingItems.forEach(item => {
                // Try to extract the full prefix including separators
                // Match patterns like "PROP-123", "PROPS001", "LT-05", etc.
                const match = item.match(/^([A-Za-z\-_]+)(\d+)$/);
                if (match) {
                    const fullPrefix = match[1];
                    const number = parseInt(match[2], 10);
                    const padding = match[2].length;
                    
                    // Only consider this pattern if the full prefix starts with user's input
                    if (fullPrefix.startsWith(prefix)) {
                        if (!patterns[fullPrefix]) {
                            patterns[fullPrefix] = {
                                numbers: [],
                                padding: padding
                            };
                        }
                        patterns[fullPrefix].numbers.push(number);
                    }
                }
            });
            
            // Find the most common prefix pattern
            let bestPrefix = null;
            let maxNumber = 0;
            let maxCount = 0;
            let bestPadding = 3;
            
            for (const [fullPrefix, data] of Object.entries(patterns)) {
                if (data.numbers.length > maxCount) {
                    maxCount = data.numbers.length;
                    bestPrefix = fullPrefix;
                    maxNumber = Math.max(...data.numbers);
                    bestPadding = data.padding;
                } else if (data.numbers.length === maxCount) {
                    // If tied, prefer shorter prefix (more specific)
                    if (!bestPrefix || fullPrefix.length < bestPrefix.length) {
                        bestPrefix = fullPrefix;
                        maxNumber = Math.max(...data.numbers);
                        bestPadding = data.padding;
                    }
                }
            }
            
            if (bestPrefix) {
                return {
                    prefix: bestPrefix,
                    nextNumber: maxNumber + 1,
                    padding: bestPadding
                };
            }
            
            return null;
        },
        incrementPattern(pattern) {
            const { prefix, nextNumber, padding } = pattern;
            return `${prefix}${String(nextNumber).padStart(padding, '0')}`;
        },
        handleKeydown(event) {
            // Accept suggestion on Tab key
            if (event.key === 'Tab' && this.suggestion) {
                event.preventDefault();
                this.itemNumber = this.suggestion;
            }
        },
        handleSubmit() {
            if (this.validate()) {
                this.onConfirm(this.itemNumber);
                this.$emit('close-modal');
            }
        }
    },
    watch: {
        itemNumber() {
            this.validate();
            this.updateSuggestion();
        }
    },
    template: html`
        <div class="content">
            <div class="form-group">
                <div class="autocomplete-wrapper">
                    <input 
                        id="item-number-input"
                        type="text"
                        v-model="itemNumber"
                        @keyup.enter="handleSubmit"
                        @keydown="handleKeydown"
                        :class="{ error: error }"
                        autofocus
                    />
                    <div class="ghost-text" v-if="ghostText">{{ itemNumber }}<span class="ghost">{{ ghostText }}</span></div>
                </div>
                <span v-if="error" class="error-message">{{ error }}</span>
                <span v-else-if="helperText" class="helper-text">{{ helperText }}</span>
            </div>
            <div class="button-bar">
                <button @click="handleSubmit" :disabled="!!error" class="purple">Add Item</button>
                <button @click="$emit('close-modal')">Cancel</button>
            </div>
        </div>
    `
};


// Image component for displaying item thumbnails
// Image URL should be provided via analysis step in reactive store
export const ItemImageComponent = {
    props: {
        imageUrl: {
            type: String,
            default: 'images/placeholder.png'
        },
        itemNumber: {
            type: String,
            default: ''
        },
        imageSize: {
            type: Number,
            default: 64
        }
    },
    inject: ['$modal'],
    computed: {
        displayUrl() {
            return this.imageUrl || 'images/placeholder.png';
        },
        imageFound() {
            return this.displayUrl !== 'images/placeholder.png';
        }
    },
    methods: {
        showImageModal() {
            if (this.imageFound) {
                this.$modal.image(this.displayUrl, `Image: ${this.itemNumber}`, this.itemNumber);
            }
        },
        handleError() {
            // If image fails to load, will fall back to placeholder via error handling in template
            console.warn(`Failed to load image for item ${this.itemNumber}`);
        }
    },
    template: html`
        <div class="item-image-container" :style="{ position: 'relative', width: imageSize + 'px', height: imageSize + 'px' }">
            <img 
                :src="displayUrl" 
                alt="Item Image" 
                :style="imageFound ? 'cursor: pointer;' : ''"
                @click="showImageModal"
                @error="handleError"
            />
        </div>
    `
};



export const InventoryTableComponent = {
    components: {
        TableComponent,
        ItemImageComponent
    },
    inject: ['appContext', '$modal'],
    props: {
        containerPath: {
            type: String,
            default: 'inventory'
        },
        inventoryName: {
            type: String,
            default: 'Inventory'
        },
        tabTitle: {
            type: String,
            default: undefined
        },
        editMode: {
            type: Boolean,
            default: true
        }
    },
    data() {
        return {
            inventoryTableStore: null,
            isLocked: false, // Track lock state (owned by this component)
            lockingInProgress: false, // Prevent concurrent lock operations
            lockedByOther: false, // Track if locked by another user
            lockOwner: null, // Track who owns the lock
            lockCheckComplete: false // Track if initial lock check is done
        };
    },
    computed: {
        columns() {
            // Dynamically set columns' editable property based on allowEdit
            return [
                { 
                    key: 'image', 
                    label: 'IMG',
                    width: 1,
                    sortable: false
                },
                { 
                    key: 'itemNumber', 
                    label: 'ITEM#',
                    width: 120,
                    sortable: true
                },
                { 
                    key: 'quantity', 
                    label: 'QTY',
                    format: 'number',
                    editable: this.allowEdit,
                    autoColor: true,
                    width: 120,
                    sortable: true
                },
                { 
                    key: 'description', 
                    label: 'Description (visible in pack lists)',
                    editable: this.allowEdit,
                    sortable: true
                },
                { 
                    key: 'notes', 
                    label: 'Notes (internal only)',
                    editable: this.allowEdit,
                    sortable: false
                }
            ];
        },
        tableData() {
            return this.inventoryTableStore ? this.inventoryTableStore.data : [];
        },
        originalData() {
            // Use the originalData from the store, not a copy of the reactive data
            return this.inventoryTableStore && Array.isArray(this.inventoryTableStore.originalData)
                ? JSON.parse(JSON.stringify(this.inventoryTableStore.originalData))
                : [];
        },
        error() {
            return this.inventoryTableStore ? this.inventoryTableStore.error : null;
        },
        loadingMessage() {
            return this.inventoryTableStore ? (this.inventoryTableStore.loadingMessage || 'Loading data...') : 'Loading data...';
        },
        isLoading() {
            return this.inventoryTableStore ? this.inventoryTableStore.isLoading : false;
        },
        isDirty() {
            const result = this.inventoryTableStore?.isModified || false;
            console.log('[InventoryTable] isDirty computed:', result, '| store exists:', !!this.inventoryTableStore, '| isModified:', this.inventoryTableStore?.isModified);
            return result;
        },
        allowEdit() {
            // Allow editing only if editMode is true AND not locked by another user AND lock check is complete
            return this.editMode && !this.lockedByOther && this.lockCheckComplete;
        },
        allowSave() {
            const result = this.isDirty && !this.lockedByOther && this.lockCheckComplete;
            console.log('[InventoryTable] allowSave computed:', result, '| isDirty:', this.isDirty, '| lockedByOther:', this.lockedByOther, '| lockCheckComplete:', this.lockCheckComplete);
            return result;
        }
    },
    async mounted() {
        // Create analysis config for image URLs
        const analysisConfig = [
            createAnalysisConfig(
                Requests.getItemImageUrl,
                'imageUrl',
                'Loading item images...',
                ['itemNumber'],
                [],
                null, // Store in AppData, not a column
                false,
                Priority.BACKGROUND // Images are visual enhancements, lowest priority
            )
        ];
        
        // Defensive: always set up the store before using it
        this.inventoryTableStore = getReactiveStore(
            Requests.getInventoryTabData,
            Requests.saveInventoryTabData,
            [this.tabTitle, undefined, undefined], // No filters needed - search is handled in UI
            analysisConfig
        );
        
        // Check lock status when component mounts
        await this.checkLockStatus();
    },
    watch: {
        isDirty(newValue, oldValue) {
            console.log('[InventoryTable] isDirty watcher fired:', oldValue, '->', newValue, '| lockCheckComplete:', this.lockCheckComplete, '| lockedByOther:', this.lockedByOther);
            if (!this.lockCheckComplete || this.lockedByOther) return;
            this.handleLockState(newValue);
        },
        
        'inventoryTableStore.error'(newError) {
            if (!newError) return;
            
            const lockErrorPattern = /locked by (.+)$/i;
            const match = newError.match(lockErrorPattern);
            
            if (match) {
                this.setLockState(false, match[1]);
                this.$modal.alert(`Cannot save: this inventory tab is locked by ${match[1]}`, 'Locked');
            }
        },
        
        // Watch for lock status changes
        // Note: InventoryTable doesn't have explicit edit mode navigation like PacklistTable,
        // but allowEdit computed property will prevent further edits when lockedByOther=true
        lockedByOther(newValue) {
            if (newValue) {
                console.log(`[InventoryTable] Lock detected - editing disabled (locked by ${this.lockOwner})`);
            }
        }
    },
    methods: {
        async checkLockStatus() {
            const user = authState.user?.email;
            if (!user || !this.tabTitle) return;
            
            try {
                const lockInfo = await Requests.getInventoryLock(this.tabTitle);
                
                if (lockInfo && lockInfo.user !== user) {
                    this.setLockState(false, lockInfo.user);
                    this.lockCheckComplete = true;
                    return;
                }
                
                if (lockInfo && lockInfo.user === user) {
                    this.setLockState(true, user);
                    
                    if (this.inventoryTableStore && this.inventoryTableStore.isLoading) {
                        await new Promise(resolve => {
                            const unwatch = this.$watch('inventoryTableStore.isLoading', (newValue) => {
                                if (!newValue) {
                                    unwatch();
                                    resolve();
                                }
                            });
                        });
                    }
                    
                    if (!this.isDirty) {
                        const unlocked = await Requests.unlockSheet('INVENTORY', this.tabTitle, user);
                        if (!unlocked) {
                            console.warn('[InventoryTable] Failed to remove stale lock');
                        }
                        this.setLockState(false, null);
                    }
                } else {
                    this.setLockState(false, null);
                }
            } catch (error) {
                console.error('[InventoryTable] Failed to check lock status:', error);
            } finally {
                this.lockCheckComplete = true;
            }
        },
        
        async handleLockState(isDirty) {
            //console.log('[InventoryTable] handleLockState called with isDirty:', isDirty, '| isLocked:', this.isLocked, '| lockingInProgress:', this.lockingInProgress, '| lockedByOther:', this.lockedByOther);
            if (this.lockingInProgress || this.lockedByOther) return;
            
            const user = authState.user?.email;
            if (!user || !this.tabTitle) return;
            
            this.lockingInProgress = true;
            
            try {
                if (isDirty && !this.isLocked) {
                    const lockAcquired = await Requests.lockSheet('INVENTORY', this.tabTitle, user);
                    if (lockAcquired) {
                        this.setLockState(true, user);
                    } else {
                        const lockInfo = await Requests.getInventoryLock(this.tabTitle, user);
                        if (lockInfo && lockInfo.user !== user) {
                            this.setLockState(false, lockInfo.user);
                            console.warn(`[InventoryTable] Category locked by ${lockInfo.user}`);
                            await this.handleRefresh();
                        }
                    }
                } else if (!isDirty && this.isLocked) {
                    const unlocked = await Requests.unlockSheet('INVENTORY', this.tabTitle, user);
                    if (unlocked) {
                        this.setLockState(false, null);
                    } else {
                        console.warn('[InventoryTable] Failed to release lock');
                    }
                }
            } catch (error) {
                console.error('[InventoryTable] Lock operation failed:', error);
                if (error.message && error.message.includes('Failed to acquire write lock')) {
                    this.$modal.alert(
                        `Unable to acquire lock for ${this.tabTitle}. The system is experiencing high concurrency. Please try again in a moment.`,
                        'Error'
                    );
                } else {
                    this.$modal.alert(
                        `Lock operation failed: ${error.message}`,
                        'Error'
                    );
                }
            } finally {
                this.lockingInProgress = false;
            }
        },
        
        async handleRefresh() {
            this.$modal.confirm(
                'This removes undo history and clears unsaved changes.',
                () => {
                    // Clear undo/redo history for this route
                    const routeKey = this.$route?.path;
                    if (routeKey) {
                        undoRegistry.clearRouteHistory(routeKey);
                    }
                    
                    invalidateCache([
                        { namespace: 'database', methodName: 'getData', args: ['INVENTORY', this.tabTitle] }
                    ], true);
                },
                null,
                'Refresh Data',
                'Refresh Data',
                'Cancel'
            );
        },
        
        setLockState(isLocked, owner = null) {
            this.isLocked = isLocked;
            this.lockedByOther = owner && owner !== authState.user?.email;
            this.lockOwner = owner;
        },
        
        async handleCellEdit(rowIdx, colIdx, value) {
            const user = authState.user?.email;
            if (!user || !this.tabTitle) return;
            
            try {
                const lockInfo = await Requests.getInventoryLock(this.tabTitle);
                if (lockInfo && lockInfo.user !== user) {
                    this.setLockState(false, lockInfo.user);
                    this.$modal.alert(`Cannot edit: this category is locked by ${lockInfo.user}`, 'Locked');
                    return;
                }
                
                if (!this.isLocked) {
                    const lockAcquired = await Requests.lockSheet('INVENTORY', this.tabTitle, user);
                    if (lockAcquired) {
                        this.setLockState(true, user);
                    } else {
                        return;
                    }
                }
            } catch (error) {
                console.error('[InventoryTable] Error checking lock on edit:', error);
                return;
            }
            
            const colKey = this.columns[colIdx]?.key;
            if (colKey && this.inventoryTableStore) {
                this.inventoryTableStore.data[rowIdx][colKey] = value;
            }
        },
        async handleNewRow(positionData) {
            // positionData: { position: 'above'|'below', targetIndex: number }
            
            // Generate next item number
            const nextItemNumber = await this.generateNextItemNumber();
            
            // Show prompt modal
            this.$modal.custom(NewItemNumberPrompt, {
                initialItemNumber: nextItemNumber,
                existingItems: this.inventoryTableStore?.data || [],
                onConfirm: (itemNumber) => {
                    this.addNewRow(itemNumber, positionData);
                },
                modalClass: ''
            }, 'New Item');
        },
        
        async generateNextItemNumber() {
            const items = this.inventoryTableStore?.data || [];
            
            if (items.length === 0) {
                return `${this.tabTitle}-001`;
            }
            
            const itemNumbers = items.map(item => item.itemNumber).filter(Boolean);
            
            // Try to detect pattern
            const pattern = this.detectNumberingPattern(itemNumbers);
            
            if (pattern) {
                return this.incrementPattern(pattern);
            }
            
            // Fallback: category prefix + next number
            return `${this.tabTitle}-${String(items.length + 1).padStart(3, '0')}`;
        },
        
        detectNumberingPattern(itemNumbers) {
            // Look for common patterns like "PREFIX-###" or "PREFIX###"
            const patterns = {};
            
            itemNumbers.forEach(num => {
                // Match patterns like "ABC-123", "ABC123", etc.
                const match = num.match(/^([A-Za-z\-_]+)(\d+)$/);
                if (match) {
                    const prefix = match[1];
                    const number = parseInt(match[2], 10);
                    
                    if (!patterns[prefix]) {
                        patterns[prefix] = [];
                    }
                    patterns[prefix].push(number);
                }
            });
            
            // Find the most common prefix and its max number
            let bestPrefix = null;
            let maxNumber = 0;
            let maxCount = 0;
            
            for (const [prefix, numbers] of Object.entries(patterns)) {
                if (numbers.length > maxCount) {
                    maxCount = numbers.length;
                    bestPrefix = prefix;
                    maxNumber = Math.max(...numbers);
                }
            }
            
            if (bestPrefix) {
                return {
                    prefix: bestPrefix,
                    nextNumber: maxNumber + 1,
                    padding: 3 // Default to 3-digit padding
                };
            }
            
            return null;
        },
        
        incrementPattern(pattern) {
            const { prefix, nextNumber, padding } = pattern;
            return `${prefix}${String(nextNumber).padStart(padding, '0')}`;
        },
        
        addNewRow(itemNumber, positionData) {
            // Capture state for undo
            const routeKey = this.appContext?.currentPath?.split('?')[0];
            if (routeKey) {
                undoRegistry.capture(this.inventoryTableStore.data, routeKey, { type: 'add-row' });
            }
            
            // Create new item object
            const newItem = {
                itemNumber: itemNumber,
                quantity: 0,
                description: '',
                notes: ''
            };
            
            const data = this.inventoryTableStore.data;
            
            if (positionData) {
                // Insert at specific position
                const insertIndex = positionData.position === 'above' 
                    ? positionData.targetIndex 
                    : positionData.targetIndex + 1;
                
                data.splice(insertIndex, 0, newItem);
            } else {
                // Add to end
                data.push(newItem);
            }
            
            // Navigate with searchTerm to highlight the new item
            const newPath = NavigationRegistry.buildPath(
                this.containerPath,
                { searchTerm: itemNumber }
            );
            
            if (this.appContext?.navigateToPath) {
                this.appContext.navigateToPath(newPath);
            }
            
            // Store is now dirty, save button will appear
        },
        
        async handleSave() {
            // Only use the store's save method if this is called from the on-save event
            if (this.inventoryTableStore) {
                console.log('[InventoryTableComponent] Saving data:', JSON.parse(JSON.stringify(this.inventoryTableStore.data)));
                await this.inventoryTableStore.save('Saving inventory...');
            }
        },

        handleReportsClick() {
            if (this.appContext?.navigateToPath) {
                const path = this.tabTitle 
                    ? NavigationRegistry.buildPath('inventory/reports', { itemCategoryFilter: this.tabTitle })
                    : 'inventory/reports';
                this.appContext.navigateToPath(path);
            }
        }
    },
    template: html `
        <slot>
            <div v-if="lockedByOther" class="card white">
                Locked for edit by: {{ lockOwner && lockOwner.includes('@') ? lockOwner.split('@')[0] : (lockOwner || 'Unknown') }}
            </div>

            <TableComponent
                ref="tableComponent"
                theme="purple"
                :data="tableData"
                :title="inventoryName || tabTitle"
                :originalData="originalData"
                :columns="columns"
                :isLoading="isLoading"
                :error="error"
                :showRefresh="true"
                :showSearch="true"
                :showNewRowButton="allowEdit"
                :sync-search-with-url="true"
                :container-path="containerPath"
                :navigate-to-path="appContext.navigateToPath"
                :newRow="allowEdit"
                :external-dirty-state="isDirty"
                emptyMessage="No inventory items found"
                :loading-message="loadingMessage"
                class="inventory-table-component mark-dirty"
                @refresh="handleRefresh"
                @cell-edit="handleCellEdit"
                @new-row="handleNewRow"
                @on-save="handleSave"
            >
                <template #header-area>
                    <div class="button-bar">
                        <button @click="appContext.navigateToPath('inventory/categories')" class="purple">Categories</button>
                        <button @click="handleReportsClick" class="purple">Reports</button>
                    </div>
                </template>
                <template #default="{ row, column, rowIndex, cellRowIndex, cellColIndex }">
                    <ItemImageComponent 
                        v-if="column.key === 'image'"
                        :itemNumber="row.itemNumber"
                        :imageUrl="row.AppData && row.AppData.imageUrl"
                    />
                </template>
            </TableComponent>
        </slot>
    `
};