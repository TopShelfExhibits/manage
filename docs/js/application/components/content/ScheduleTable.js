import { html, Requests, parseDate, TableComponent, getReactiveStore, createAnalysisConfig, invalidateCache } from '../../index.js';

export const ScheduleTableComponent = {
    components: {
        TableComponent
    },
    props: {
        filter: {
            type: [Object, String],
            default: null
        },
        searchParams: {
            type: Object,
            default: null
        },
        hideRowsOnSearch: {
            type: Boolean,
            default: true
        },
        templateName: {
            type: String,
            default: 'TEMPLATE'
        }
    },
    inject: ['$modal'],
    emits: ['navigate-to-path', 'packlist-created'],
    data() {
        return {
            scheduleTableStore: null
        };
    },
    computed: {
        columns() {
            const rawData = this.scheduleTableStore ? this.scheduleTableStore.data : [];
            if (!rawData || rawData.length === 0) {
                // Return a basic set of columns if no data yet (for loading state)
                return [
                    { key: 'Show', label: 'Show' },
                    { key: 'Client', label: 'Client' },
                    { key: 'packlist', label: 'Packlist' }
                ];
            }

            // Get headers from the first row of data
            const firstRow = rawData[0];
            const headers = Object.keys(firstRow).filter(header => header !== 'AppData'); // Exclude AppData from columns

            // Generate columns with rational formatting based on column names
            const dynamicColumns = headers.map(header => {
                const column = {
                    key: header,
                    label: this.formatColumnLabel(header)
                };

                // Mark columns as details if they're not Show, Client, or Ship
                if (!['Show', 'Client', 'Ship', 'City', 'Size'].includes(header)) {
                    column.details = true;
                }

                // Add sortable configuration for useful columns
                const sortableColumns = ['Show', 'Client', 'Ship', 'City', 'Size'];
                const dateColumns = ['Start Date', 'End Date', 'Load In', 'Load Out', 'Event Start', 'Event End'];
                
                if (sortableColumns.includes(header) || dateColumns.includes(header)) {
                    column.sortable = true;
                } else {
                    column.sortable = false;
                }

                // Apply rational formatting based on column name patterns
                this.applyColumnFormatting(column, header);

                return column;
            });

            // Always add the packlist column at the end
            dynamicColumns.push({
                key: 'packlist',
                label: 'Packlist',
                width: 120,
                sortable: false
            });

            return dynamicColumns;
        },
        tableData() {
            const rawData = this.scheduleTableStore ? this.scheduleTableStore.data : [];
            // Packlist information is now populated by reactive store analysis in AppData
            return rawData;
        },
        originalData() {
            return this.scheduleTableStore && Array.isArray(this.scheduleTableStore.originalData)
                ? JSON.parse(JSON.stringify(this.scheduleTableStore.originalData))
                : [];
        },
        error() {
            return this.scheduleTableStore ? this.scheduleTableStore.error : null;
        },
        loadingMessage() {
            return this.scheduleTableStore ? (this.scheduleTableStore.loadingMessage || 'Loading schedule...') : 'Loading schedule...';
        },
        isLoading() {
            return this.scheduleTableStore ? this.scheduleTableStore.isLoading : false;
        },
        isAnalyzing() {
            return this.scheduleTableStore ? this.scheduleTableStore.isAnalyzing : false;
        },
        analysisProgress() {
            return this.scheduleTableStore ? this.scheduleTableStore.analysisProgress : 0;
        },
        tableTitle() {
            // Helper to format date as 'mmm d, yyyy'
            function formatDate(dateStr) {
                if (!dateStr) return '';
                const date = parseDate(dateStr);
                if (!date || isNaN(date)) return dateStr;
                return date.toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric'
                });
            }
            // Check for dateFilters array format
            if (this.filter && this.filter.dateFilters && this.filter.dateFilters.length > 0) {
                const afterFilter = this.filter.dateFilters.find(f => f.type === 'after');
                const beforeFilter = this.filter.dateFilters.find(f => f.type === 'before');
                
                if (afterFilter && beforeFilter) {
                    // Handle date range with both start and end
                    const startVal = afterFilter.value;
                    const endVal = beforeFilter.value;
                    
                    // If values are offsets (numbers), convert to dates
                    if (typeof startVal === 'number' && typeof endVal === 'number') {
                        const today = new Date();
                        const startDate = new Date(today.getTime() + startVal * 86400000);
                        const endDate = new Date(today.getTime() + endVal * 86400000);
                        const start = startDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
                        const end = endDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
                        return `Shows between ${start} and ${end}`;
                    } else if (typeof startVal === 'string' && typeof endVal === 'string') {
                        // If values are date strings
                        const start = formatDate(startVal);
                        const end = formatDate(endVal);
                        return `Shows between ${start} and ${end}`;
                    } else if (typeof startVal === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(startVal)) {
                        // If it's a show identifier
                        return `Shows during ${startVal}`;
                    }
                }
            }
            // Legacy format support (will be removed eventually)
            if (this.filter && typeof this.filter === 'object' && this.filter.startDate && this.filter.endDate) {
                const start = formatDate(this.filter.startDate);
                const end = formatDate(this.filter.endDate);
                return `Shows between ${start} and ${end}`;
            }
            if (this.filter && (typeof this.filter === 'string' || this.filter.identifier)) {
                const id = typeof this.filter === 'string' ? this.filter : this.filter.identifier;
                return `Shows during ${id}`;
            }
            return 'Production Schedule';
        }
    },
    watch: {
        // Watch for filter or searchParams changes and recreate store with new parameters
        filter: {
            handler(newFilter, oldFilter) {
                if (JSON.stringify(newFilter) !== JSON.stringify(oldFilter)) {
                    this.recreateStore();
                }
            },
            deep: true,
            immediate: false
        },
        searchParams: {
            handler(newSearchParams, oldSearchParams) {
                if (JSON.stringify(newSearchParams) !== JSON.stringify(oldSearchParams)) {
                    this.recreateStore();
                }
            },
            deep: true,
            immediate: false
        }
    },
    async mounted() {
        this.recreateStore();
    },
    methods: {
        recreateStore() {
            // If no filter is provided, don't create a store (show empty table)
            if (this.filter === null) {
                this.scheduleTableStore = null;
                return;
            }
            
            // Create analysis configuration to check packlist existence for each row
            const analysisConfig = [
                createAnalysisConfig(
                    Requests.checkPacklistExists,
                    'packlist',
                    'Checking packlists...',
                    null, // No specific source columns
                    [], // No additional params
                    null, // Results go to AppData
                    true // Pass full item/row
                ),
                // Guess ship date if missing and store in AppData
                createAnalysisConfig(
                    Requests.guessShipDate,
                    'estimatedShipDate',
                    'Guessing missing ship dates...',
                    null, // No specific source columns
                    [], // No additional params
                    null, // Results go to AppData
                    true // Pass full item/row
                ),
                // Guess ship date if missing and store in AppData
                createAnalysisConfig(
                    Requests.guessShipDate,
                    'estimatedShipDateEnrichment',
                    'Adding missing ship dates to data...',
                    null, // No specific source columns
                    [], // No additional params
                    'Ship', // Results go to ship date column
                    true // Pass full item/row
                )
            ];

            // Create a new reactive store with the updated filter, searchParams, and analysis
            this.scheduleTableStore = getReactiveStore(
                Requests.getProductionScheduleData,
                null,
                [this.filter, this.searchParams],
                analysisConfig
            );
        },
        async handleRefresh() {
            // Reload schedule data (cache will be automatically invalidated)
            invalidateCache([
                { namespace: 'database', methodName: 'getData', args: ['PROD_SCHED'] }, // invalidate all prod sched tabs to force refresh of client and show ref info as well
                { namespace: 'database', methodName: 'getTabs', args: ['PACK_LISTS'] }
            ], true);
        },
        formatColumnLabel(header) {
            // Convert header to a more readable label
            const labelMap = {
                'S. Start': 'Start Date',
                'S. End': 'End Date',
                'Booth#': 'Booth #',
                'Year': 'Year',
                'Show': 'Show',
                'Client': 'Client',
                'City': 'City',
                'Location': 'Location',
                'Ship': 'Ship Date',
                'Production Manager': 'Production Manager',
                'Account Manager': 'Account Manager'
            };

            // Use mapped label if available
            if (labelMap[header]) {
                return labelMap[header];
            }

            // Auto-format common patterns
            let formatted = header
                // Handle camelCase and PascalCase
                .replace(/([a-z])([A-Z])/g, '$1 $2')
                // Handle underscores and dashes
                .replace(/[_-]/g, ' ')
                // Handle dots followed by letters
                .replace(/\.([a-zA-Z])/g, '. $1')
                // Capitalize each word
                .split(' ')
                .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                .join(' ');

            return formatted;
        },
        applyColumnFormatting(column, header) {
            const key = header.toLowerCase();

            // Apply date formatting for date-related columns
            if (this.isDateColumn(key)) {
                column.format = 'date';
                column.width = 120;
                
                // Apply auto-coloring for ship dates and other time-sensitive dates
                if (key === 'ship' || key.includes('ship') || key.includes('due') || key.includes('deadline')) {
                    column.autoColor = true;
                }
            }
            // Apply number formatting for numeric columns
            else if (this.isNumberColumn(key)) {
                column.format = 'number';
                column.width = 80;
            }
            // Apply currency formatting for monetary columns
            else if (this.isCurrencyColumn(key)) {
                column.format = 'currency';
                column.width = 120;
            }
            // Apply specific widths for common columns
            else {
                column.width = this.getColumnWidth(key);
            }
        },
        isDateColumn(key) {
            const dateKeywords = ['date', 'start', 'end', 'ship', 'due', 'deadline', 'created', 'updated', 'modified', 's.', 'time'];
            return dateKeywords.some(keyword => key.includes(keyword));
        },
        isNumberColumn(key) {
            const numberKeywords = ['year', 'count', 'quantity', 'id'];
            return numberKeywords.some(keyword => key.includes(keyword)) || /^\d+$/.test(key);
        },
        isCurrencyColumn(key) {
            const currencyKeywords = ['price', 'cost', 'amount', 'fee', 'rate', 'budget', 'expense', 'revenue', 'total'];
            return currencyKeywords.some(keyword => key.includes(keyword));
        },
        getColumnWidth(key) {
            // Apply specific widths based on column content type
            if (key === 'show' || key.includes('title') || key.includes('name')) {
                return 200;
            }
            else if (key === 'client' || key.includes('company')) {
                return 150;
            }
            else if (key === 'city' || key === 'location' || key.includes('address')) {
                return 150;
            }
            else if (key.includes('manager') || key.includes('contact') || key.includes('person')) {
                return 180;
            }
            else if (key.includes('booth') || key.includes('space')) {
                return 100;
            }
            else if (key.includes('email')) {
                return 200;
            }
            else if (key.includes('phone')) {
                return 140;
            }
            else if (key.includes('status') || key.includes('type')) {
                return 120;
            }
            else if (key.includes('notes') || key.includes('description') || key.includes('comment')) {
                return 250;
            }
            // Default width for other columns
            else {
                return 140;
            }
        },
        async handlePacklistClick(packlistInfo) {
            if (!packlistInfo.exists || !packlistInfo.identifier) {
                this.$modal.alert('No packlist available for this show', 'Info');
                return;
            }
            
            this.$emit('navigate-to-path', `packlist/${packlistInfo.identifier}`);
        },
        async handleCreatePacklist(identifier, scheduleRow) {
            try {
                // Validate identifier exists
                if (!identifier) {
                    this.$modal.error('Cannot create packlist: Invalid identifier', 'Error');
                    return;
                }
                
                // Confirm with user (show client, show, year info)
                const client = scheduleRow.Client || '';
                const show = scheduleRow.Show || '';
                const year = scheduleRow.Year || '';
                const startDate = scheduleRow['S. Start'] || 'TBD';
                
                const isDuplicate = this.templateName !== 'TEMPLATE';
                const confirmMessage = isDuplicate 
                    ? `Duplicate "${this.templateName}" and attach to:\n\nClient: ${client}\nShow: ${show}\nYear: ${year}\nStart Date: ${startDate}\n\nNew packlist will be named: ${identifier}`
                    : `Create new empty packlist for:\n\nClient: ${client}\nShow: ${show}\nYear: ${year}\nStart Date: ${startDate}`;
                
                this.$modal.confirm(
                    confirmMessage,
                    async () => {
                        try {
                            // Create the tab from template
                            await Requests.createNewTab('PACK_LISTS', this.templateName, identifier);
                            
                            // Success message
                            this.$modal.alert(`Packlist "${identifier}" created successfully!`, 'Success');
                            
                            // Emit event for parent to handle (e.g., close modal)
                            this.$emit('packlist-created', identifier);
                            
                            // Trigger re-analysis to update button
                            if (this.scheduleTableStore) {
                                this.scheduleTableStore.runConfiguredAnalysis();
                            }
                        } catch (createError) {
                            console.error('Error in create confirmation:', createError);
                            this.$modal.error(`Failed to create packlist: ${createError.message}`, 'Error');
                        }
                    },
                    null,
                    'Create Packlist',
                    'Create'
                );
            } catch (error) {
                console.error('Error creating packlist:', error);
                this.$modal.error(`Failed to create packlist: ${error.message}`, 'Error');
            }
        },
        getShipDateCards(row, columnKey) {
            // Only show estimated ship date cards in the ship column
            if (columnKey !== 'Ship') {
                return [];
            }
            
            const estimatedDate = row.AppData?.estimatedShipDate;
            const startDate = row['S. Start'] ? row['S. Start'] : 'N/A';

            // Only show card if there's an estimated date
            if (estimatedDate) {
                return [{
                    message: `Est: ${estimatedDate}`,
                    hoverMessage: `Starts: ${startDate}`,
                    clickable: false,
                    class: 'gray' // Gray card to indicate estimated value
                }];
            }
            
            return [];
        },
        getPacklistCards(row, columnKey) {
            // Only show packlist cards in the packlist column
            if (columnKey !== 'packlist') {
                return [];
            }
            
            const packlistInfo = row.AppData?.packlist;
            
            // If no packlist info yet or still analyzing, show loading state
            if (!packlistInfo || packlistInfo.exists === undefined) {
                return [{
                    message: 'Checking...',
                    disabled: true
                }];
            }
            
            if (packlistInfo.exists) {
                return [{
                    message: 'View Packlist',
                    disabled: false,
                    class: 'white',
                    action: () => this.handlePacklistClick(packlistInfo)
                }];
            } else {
                return [{
                    message: 'Create Packlist',
                    disabled: false,
                    action: () => this.handleCreatePacklist(packlistInfo.identifier, row)
                }];
            }
        }
    },
    template: html`
        <TableComponent
            ref="tableComponent"
            :data="tableData"
            :originalData="originalData"
            :columns="columns"
            :isLoading="isLoading"
            :isAnalyzing="isAnalyzing"
            :loading-progress="analysisProgress"
            :error="error"
            :showRefresh="true"
            :title="tableTitle"
            emptyMessage="No shows found."
            :loading-message="loadingMessage"
            :showSearch="true"
            :hideRowsOnSearch="hideRowsOnSearch"
            :allowDetails="true"
            @refresh="handleRefresh"
        >
            <template #header-area>
                <slot name="header-area"></slot>
            </template>
            <template #default="{ row, column }">
                <!-- Add estimated ship date cards in Ship column -->
                <template v-for="card in getShipDateCards(row, column.key)" :key="'ship-' + card.message">
                    <span 
                        :class="['card', card.class]"
                        :title="card.hoverMessage"
                        v-html="card.message"
                    ></span>
                </template>
                
                <!-- Add packlist cards based on AppData -->
                <template v-for="card in getPacklistCards(row, column.key)" :key="card.message">
                    <button 
                        :class="['card', card.class]"
                        :disabled="card.disabled"
                        @click="!card.disabled ? card.action() : null"
                        v-html="card.message"
                    ></button>
                </template>
            </template>
        </TableComponent>
    `
};
