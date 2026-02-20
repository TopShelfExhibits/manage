import { html, LoadingBarComponent, NavigationRegistry } from '../../index.js';
import { useSearch } from '../../utils/useSearch.js';

// Cards Grid Component: Simple responsive grid layout with clickable cards
export const CardsComponent = {
    components: { LoadingBarComponent },
    inject: ['appContext'],
    props: {
        items: {
            type: Array,
            required: true,
            // Expected format: [{ id, title, content?, contentFooter?, onClick?, cardClass? }]
            // content and contentFooter support HTML (rendered with v-html)
            // cardClass options: 'gray' (default), 'blue', 'green', 'yellow', 'red'
        },
        onItemClick: {
            type: Function,
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
        loadingMessage: {
            type: String,
            default: 'Loading...'
        },
        emptyMessage: {
            type: String,
            default: 'No items available'
        },
        defaultCardClass: {
            type: String,
            default: 'gray'
        },
        showHeader: {
            type: Boolean,
            default: false
        },
        showRefresh: {
            type: Boolean,
            default: false
        },
        showSearch: {
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
        hideCardsOnSearch: {
            type: Boolean,
            default: true
        },
        showPinButtons: {
            type: Boolean,
            default: false
        },
        pinnedItems: {
            type: Set,
            default: () => new Set()
        },
        showPinnedOnly: {
            type: Boolean,
            default: false
        }
    },
    setup(props, { emit }) {
        // Initialize search composable
        const search = useSearch({
            formatValue: null,
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
        return {};
    },
    computed: {
        shouldShowEmpty() {
            return !this.isLoading && !this.isAnalyzing && this.items && this.items.length === 0;
        },
        shouldShowCards() {
            // Show cards if we have items, even during analysis
            return this.items && this.items.length > 0;
        },
        visibleCards() {
            // Filter rows based on search value but keep all rows including marked for deletion
            if (!Array.isArray(this.items)) return [];

            let filteredData = this.items
                .filter(row => row); // Only filter out null/undefined rows

            // Apply search filter if searchValue is provided and hideCardsOnSearch is enabled
            if (this.search.hasActiveSearch.value && this.hideCardsOnSearch) {
                const searchWords = this.search.searchWords.value;
                
                filteredData = filteredData.filter(row => {
                    if (!row) return false;
                    // Search in title, content, and contentFooter fields
                    const fields = [
                        row.title,
                        row.content,
                        row.contentFooter
                    ];
                    
                    // All search words must match somewhere in the fields (AND logic)
                    return searchWords.every(word =>
                        fields.some(field =>
                            // Skip null/undefined to prevent matching "undefined" or "null" strings
                            field != null && String(field).toLowerCase().includes(word.toLowerCase())
                        )
                    );
                });
            }

            return filteredData;
        }
    },
    mounted() {
        // Initialize search from URL and setup watcher if syncSearchWithUrl is enabled
        this.search.initializeFromUrl();
        this.search.setupUrlWatcher();
    },
    methods: {
        
        handleCardClick(item) {
            // Call item-specific onClick handler if provided, otherwise use component-level handler
            if (item.onClick && typeof item.onClick === 'function') {
                item.onClick(item);
            } else {
                this.onItemClick(item.title || item.id);
            }
        },
        handleKeyDown(event, item) {
            // Handle keyboard navigation for accessibility
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.handleCardClick(item);
            }
        },
        handleRefresh() {
            console.log('CardsComponent: Refresh requested');
            this.$emit('refresh');
        },
        isCardAnalyzing(cardIndex) {
            // Check if this card is currently being analyzed
            const card = this.visibleCards[cardIndex];
            return card && card.AppData && card.AppData._analyzing === true;
        },
        handlePinClick(event, item) {
            // Prevent card click event from firing
            event.stopPropagation();
            this.$emit('toggle-pin', item.title || item.id);
        },
        isPinned(item) {
            return this.pinnedItems.has(item.title || item.id);
        }
    },
    template: html`
        <slot>
            <div key="content-header" v-if="showHeader" class="content-header">
                <slot 
                    name="header-area" 
                ></slot>
                
                <div v-if="showRefresh || showSearch" class="button-bar">
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
                        v-if="showRefresh" 
                        @click="handleRefresh" 
                        :disabled="isLoading" 
                        class="refresh-button"
                    >
                        {{ isLoading ? 'Loading...' : 'Refresh' }}
                    </button>
                </div>
                <!-- Loading/Analysis Progress Indicator -->
                <LoadingBarComponent
                    :is-loading="isLoading"
                    :is-analyzing="isAnalyzing"
                    :percent-complete="loadingProgress"
                    class="embedded"
                />
            </div>

            <!-- Cards Grid (shows during analysis with progressive updates) -->
            <div v-if="shouldShowCards" class="cards-grid">
                <div
                    v-for="(item, idx) in visibleCards"
                    :key="item.id || item.title"
                    :class="['card', 'clickable', { 'analyzing': isCardAnalyzing(idx) }, item.cardClass || defaultCardClass]"
                    @click="handleCardClick(item)"
                    @keydown="handleKeyDown($event, item)"
                    :title="item.title"
                    :aria-label="item.title + (item.content ? ': ' + item.content : '')"
                >
                    <div class="content-header">
                        <h3 v-html="search.highlightRawText(item.title)"></h3>
                        <slot v-if="showPinButtons">
                            <button
                                @click="handlePinClick($event, item)"
                                :class="['column-button', { 'active': isPinned(item) }]"
                                :title="isPinned(item) ? 'Unpin' : 'Pin'"
                            >
                                <span class="material-symbols-outlined">{{ isPinned(item) ? 'keep_off' : 'keep' }}</span>
                            </button>
                        </slot>
                    </div>
                    <div class="content" v-if="item.content">
                        <div v-html="search.highlightHtmlContent(item.content)"></div>
                    </div>
                    <div class="content-footer" v-if="item.contentFooter">
                        <div v-html="search.highlightHtmlContent(item.contentFooter)"></div>
                    </div>
                </div>
            </div>

            
            <!-- Initial Loading State (no items yet) -->
            <div v-if="isLoading || isAnalyzing" class="loading-message">
                <img v-if="!showHeader && !shouldShowCards" src="images/loading.gif" alt="Loading..."/>
                <p>{{ loadingMessage || 'Loading...' }}</p>
            </div>
            <p v-else-if="shouldShowEmpty" class="empty-message">{{ emptyMessage }}</p>
        </slot>
    `
};
