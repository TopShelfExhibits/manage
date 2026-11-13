import { html, DataView, Requests, getReactiveStore, todayISOString, THUMBNAIL_FIELD } from '../../index.js';
import { thumbnailStyle } from '../../utils/views/viewStyles.js';

/**
 * InventorySelectorModal — pick an inventory item to add to a table (CLAUDE.md "Adding inventory
 * items"). A modal component: open it with $modal.custom(InventorySelectorModal, { ...props }).
 * Every category's items (Requests.getAllInventoryData), with search and a category filter;
 * clicking a row picks the item.
 *
 * Props:
 *   onItemSelected(item)  the picked inventory row (with `tab`, its category)
 *   onAddEmpty()          optional: shows "+ Empty Row" for tables that take a row without an item
 *   loadReferenceDate()   optional: async, the date whose quantities to show (pending changes due
 *                         by then applied), e.g. a pack list's ship date; today when omitted
 */
export const InventorySelectorModal = {
    components: { DataView },
    props: {
        onItemSelected: { type: Function, required: true },
        onAddEmpty: { type: Function, default: null },
        loadReferenceDate: { type: Function, default: null }
    },
    data() {
        return {
            inventoryStore: null,
            error: null,
            selectedCategory: null
        };
    },
    computed: {
        // Rows from Requests.getAllInventoryData (inventory rows carry their thumbnail)
        fields() {
            return [
                THUMBNAIL_FIELD,
                { key: 'itemNumber', label: 'Item#', type: 'item' },
                { key: 'description', label: 'Description' },
                { key: 'quantity', label: 'Available' }
            ];
        },
        // Single-view registry in a modal (no URL); picking the item is the primary action (a row click)
        registry() {
            return {
                id: 'inventory-selector',
                default: 'table',
                theme: 'purple',
                views: [{
                    id: 'table', name: 'Inventory', layout: 'table',
                    columns: ['thumbnail', 'itemNumber', 'description', 'quantity'],
                    sortable: ['itemNumber', 'description', 'quantity'],
                    style: { thumbnail: thumbnailStyle('itemNumber'), itemNumber: { width: 120 }, quantity: { width: 100 } },
                    table: { sticky: { start: ['thumbnail'] } },
                    sort: { key: 'itemNumber', dir: 'asc' },
                    action: 'row'
                }]
            };
        },
        addAction() {
            return { run: (row) => this.selectItem(row), label: '+ Add Item' };
        },
        allInventoryData() {
            return this.inventoryStore ? this.inventoryStore.data : [];
        },
        availableCategories() {
            return [...new Set(this.allInventoryData.map(item => item.tab).filter(Boolean))].sort();
        },
        inventoryData() {
            if (!this.selectedCategory) return this.allInventoryData;
            return this.allInventoryData.filter(item => item.tab === this.selectedCategory);
        },
        originalData() {
            return this.inventoryStore && Array.isArray(this.inventoryStore.originalData)
                ? JSON.parse(JSON.stringify(this.inventoryStore.originalData))
                : [];
        },
        isLoading() {
            return !this.inventoryStore || this.inventoryStore.isLoading;
        }
    },
    async mounted() {
        try {
            const referenceDate = (this.loadReferenceDate && await this.loadReferenceDate()) || todayISOString();
            // Read-only store; quantities as of the reference date (pending changes applied)
            this.inventoryStore = getReactiveStore(Requests.getAllInventoryData, null, [referenceDate]);
        } catch (error) {
            console.error('Failed to load inventory data:', error);
            this.error = 'Failed to load inventory data';
        }
    },
    methods: {
        selectItem(item) {
            this.onItemSelected(item);
            this.$emit('close-modal');
        },
        addEmpty() {
            this.onAddEmpty?.();
            this.$emit('close-modal');
        }
    },
    template: html`
        <div v-if="error" class="error-message">{{ error }}</div>
        <DataView
            v-else
            :fields="fields"
            :rows="inventoryData"
            :registry="registry"
            :action="addAction"
            :original-data="originalData"
            :isLoading="isLoading"
            :isAnalyzing="inventoryStore && inventoryStore.isAnalyzing"
            :showSearch="true"
            :showRefresh="false"
            :showFooter="true"
            :emptyMessage="'No inventory items found'"
            :loadingMessage="inventoryStore && inventoryStore.isAnalyzing ? 'Loading images...' : 'Loading inventory...'"
        >
            <template #header-area>
                <button v-if="onAddEmpty" @click="addEmpty" class="large">+ Empty Row</button>
                <p style="margin-left: 1em;">{{ onAddEmpty ? 'Or add from inventory below...' : 'Pick an item from inventory below...' }}</p>
                <select :value="selectedCategory" @change="e => selectedCategory = e.target.value || null" style="margin-left: auto;">
                    <option value="">All Categories</option>
                    <option v-for="cat in availableCategories" :key="cat" :value="cat">{{ cat.charAt(0) + cat.slice(1).toLowerCase() }}</option>
                </select>
            </template>
        </DataView>
    `
};
