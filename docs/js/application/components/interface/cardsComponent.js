import { html, LoadingBarComponent, NavigationRegistry, parseDate } from '../../index.js';
import { useSearch, SearchBoxComponent, scrollToActiveResult } from '../../utils/useSearch.js';
import { useStickyHeader } from '../../utils/useStickyHeader.js';
import { matchRows, valueContains } from '../../utils/views/searchMatch.js';
import { formatText, escapeHtml } from '../../utils/views/fieldFormat.js';
import { searchTiers } from '../../utils/views/resolveView.js';
import { rowsToCards, bucketRowsToCards } from '../../utils/views/cardsAdapter.js';
import { ContentHeaderComponent } from './contentHeaderComponent.js';

function normalizeItemSortWords(value) {
    return String(value)
        .toLowerCase()
        .split(/[\s\-_,./\\:;|]+/)
        .filter(Boolean);
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

// Max matched-field entries listed on a card during a search
const MAX_MATCHED_FIELDS = 6;

/**
 * CardsComponent — the cards renderer (views-and-renderers-plan §4.6). Same contract as the table
 * and calendar: `resolved` (the ResolvedView), `data` (rows), `action`, decorations. Cards are built
 * by the cards adapter: one per row, or one per bucket (cards.bucketBy) with the bucket hooks.
 * Search: one matcher over the member rows (shown and details keys; hidden never searched), with
 *   the minimum term length and the broad-search abort (§4.5). Cards whose match comes from fields
 *   not on the card list the matched fields; with a row trigger they also get `details-match`,
 *   with a button trigger the action button glows.
 * Sort: the view's sort; the sort select lists sortable fields (bucket cards sort by title).
 * Primary action (§4.8): `action.trigger === 'row'` → the whole card; 'button' → a footer button.
 */
export const CardsComponent = {
    name: 'CardsComponent',
    components: { LoadingBarComponent, SearchBoxComponent, ContentHeaderComponent },
    inject: ['appContext'],
    props: {
        resolved: { type: Object, required: true },
        data: { type: Array, default: () => [] },
        // ResolvedAction + perform(row, ctx) from DataView
        action: { type: Object, default: null },
        // decorations(row, key) → Card[] with decorationKeys (the keys the page decorates)
        decorations: { type: Function, default: null },
        decorationKeys: { type: Array, default: () => [] },
        // Bucket cards: bucketKeys seed empty buckets; bucketDecorations(key, rows) → Card[]
        bucketKeys: { type: Array, default: () => [] },
        bucketDecorations: { type: Function, default: null },
        bucketLabel: { type: Function, default: null },
        bucketAppData: { type: Function, default: null },
        isLoading: { type: Boolean, default: false },
        isAnalyzing: { type: Boolean, default: false },
        loadingProgress: { type: Number, default: -1 },
        loadingMessage: { type: String, default: 'Loading...' },
        emptyMessage: { type: String, default: 'No items available' },
        showHeader: { type: Boolean, default: true },
        showRefresh: { type: Boolean, default: false },
        showSearch: { type: Boolean, default: false },
        syncSearchWithUrl: { type: Boolean, default: false },
        containerPath: { type: String, default: '' },
        navigateToPath: { type: Function, default: null },
        viewSelect: { type: Object, default: null },
        showPinButtons: { type: Boolean, default: false },
        pinnedItems: { type: Set, default: () => new Set() },
        showPinnedOnly: { type: Boolean, default: false },
        showSort: { type: Boolean, default: false }
    },
    emits: ['refresh', 'toggle-pin', 'row-action'],
    setup(props) {
        const search = useSearch({
            syncWithUrl: props.syncSearchWithUrl,
            navigationRegistry: NavigationRegistry,
            containerPath: props.containerPath,
            appContext: Vue.inject('appContext')
        });
        return { search };
    },
    data() {
        return {
            stickyActive: false,
            stickyLeft: 0,
            stickyWidth: 0,
            stickySpacerHeight: 0,
            selectedSortKey: null,
            selectedSortDirection: 'asc',
            isUsingDefaultSort: true,
        };
    },
    computed: {
        theme() {
            return this.resolved.theme || 'gray';
        },
        cards() {
            const r = this.resolved;
            if (r.cards?.bucketBy) {
                return bucketRowsToCards(this.data, r, {
                    bucketKeys: this.bucketKeys,
                    bucketDecorations: this.bucketDecorations,
                    bucketLabel: this.bucketLabel,
                    bucketAppData: this.bucketAppData
                });
            }
            return rowsToCards(this.data, r, { decorations: this.decorations, decorationKeys: this.decorationKeys });
        },
        // { shown, details } keys searched on member rows
        searchTiers() {
            return searchTiers(this.resolved);
        },
        hideCardsOnSearch() {
            return this.resolved.cards?.hideOnSearch !== false;
        },
        // The sort select: sortable fields, or the title for bucket cards
        sortableColumns() {
            const r = this.resolved;
            if (r.cards?.bucketBy) return [{ key: 'title', label: r.fieldMap.get(r.cards.bucketBy)?.label || 'Title', type: 'string' }];
            return r.fields.filter(f => f.sortable).map(f => ({ key: f.key, label: f.label ?? f.key, type: f.type || null }));
        },
        sortableSignature() {
            return this.sortableColumns.map(c => c.key).join('|');
        },
        defaultSortSignature() {
            return JSON.stringify(this.resolved.sort || []);
        },
        shouldShowEmpty() {
            return !this.isLoading && !this.isAnalyzing && this.cards && this.cards.length === 0;
        },
        shouldShowCards() {
            return this.cards && this.cards.length > 0;
        },
        effectiveAction() {
            return this.action || { kind: 'none', trigger: 'button' };
        },
        cardIsTrigger() {
            const a = this.effectiveAction;
            return a.kind !== 'none' && a.trigger === 'row';
        },
        hasActionButton() {
            const a = this.effectiveAction;
            return a.kind !== 'none' && a.trigger === 'button';
        },
        // Member rows searched (for bucket cards the members, not the buckets), with their card index
        memberIndex() {
            const rows = [];
            const owner = [];
            (this.cards || []).forEach((card, ci) => {
                for (const r of (card.rows || (card.row ? [card.row] : []))) {
                    rows.push(r);
                    owner.push(ci);
                }
            });
            return { rows, owner };
        },
        searchResult() {
            return matchRows(this.memberIndex.rows, this.searchTiers, this.search.searchWords.value);
        },
        searchActive() {
            return this.searchResult.active && !this.searchResult.aborted;
        },
        // card index → { matched, shownMatch, matchedFields[] }
        cardMatches() {
            const map = new Map();
            if (!this.searchActive) return map;
            const words = this.search.searchWords.value;
            const { rows, owner } = this.memberIndex;
            this.searchResult.results.forEach((r, i) => {
                if (!r) return;
                const ci = owner[i];
                const entry = map.get(ci) || { matched: true, shownMatch: false, matchedFields: [] };
                if (r.shownMatch) entry.shownMatch = true;
                if (entry.matchedFields.length < MAX_MATCHED_FIELDS) {
                    const row = rows[i];
                    const keys = [...this.searchTiers.shown, ...this.searchTiers.details];
                    for (const k of keys) {
                        if (entry.matchedFields.length >= MAX_MATCHED_FIELDS) break;
                        if (words.some(w => valueContains(row[k], w))) {
                            entry.matchedFields.push({ fieldName: this.resolved.fieldMap.get(k)?.label || k, value: formatText(row[k], { key: k }) });
                        }
                    }
                }
                map.set(ci, entry);
            });
            // A bucket's title matches on its own (e.g. a category name with no member match)
            (this.cards || []).forEach((card, ci) => {
                if (map.has(ci) || !card.bucket) return;
                const title = String(card.title || '').toLowerCase();
                if (words.every(w => title.includes(w))) map.set(ci, { matched: true, shownMatch: true, matchedFields: [] });
            });
            return map;
        },
        visibleCards() {
            if (!Array.isArray(this.cards)) return [];
            let list = this.cards.map((card, ci) => ({ card, ci })).filter(({ card }) => card);
            if (this.searchActive && this.hideCardsOnSearch) {
                list = list.filter(({ ci }) => this.cardMatches.has(ci));
            }
            const sortCriteria = this.isUsingDefaultSort ? this.getDefaultSortCriteria() : this.getCurrentSortCriteria();
            if (sortCriteria.length > 0) {
                list = [...list].sort((a, b) => {
                    for (const criterion of sortCriteria) {
                        const comparison = this.compareCardsByColumn(a.card, b.card, criterion.column, criterion.direction);
                        if (comparison !== 0) return comparison;
                    }
                    return 0;
                });
            }
            return list;
        },
        // Navigate mode (!hideCardsOnSearch): position in visibleCards → 0-based match index
        searchMatchedCardIndices() {
            const map = new Map();
            if (!this.searchActive || this.hideCardsOnSearch) return map;
            let m = 0;
            this.visibleCards.forEach(({ ci }, idx) => { if (this.cardMatches.has(ci)) map.set(idx, m++); });
            return map;
        },
        searchMatchCount() {
            if (this.searchResult.aborted) return Infinity;
            return this.hideCardsOnSearch ? this.cardMatches.size : this.searchMatchedCardIndices.size;
        },
        activeSearchIndex() { return this.search.searchIndex.value; }
    },
    watch: {
        sortableSignature() {
            const selectedColumnStillExists = this.sortableColumns.some(col => col.key === this.selectedSortKey);
            if (!selectedColumnStillExists) {
                this.applyDefaultSortColumn({ force: true });
            }
        },
        // The view's sort changed (view switch, patch): apply it
        defaultSortSignature() {
            this.applyDefaultSortColumn({ force: true });
        },
        activeSearchIndex(newIndex) {
            if (newIndex == null) return;
            scrollToActiveResult(this, this.activeSearchIndex, this.searchMatchedCardIndices.size);
        },
        searchMatchedCardIndices(newMap) {
            if (this.activeSearchIndex != null && newMap.size > 0) {
                scrollToActiveResult(this, this.activeSearchIndex, newMap.size);
            }
        },
        // Parameter-only changes on the same route don't remount: recalculate the sticky header
        'appContext.currentPath'(newPath, oldPath) {
            if (!newPath || !oldPath || newPath === oldPath) return;
            if (oldPath.split('?')[0] === newPath.split('?')[0] && this._stickyHeader) {
                this._stickyHeader.reset();
                this.$nextTick(() => this._stickyHeader.update());
            }
        }
    },
    mounted() {
        this.search.initializeFromUrl();
        this.search.setupUrlWatcher();
        this.applyDefaultSortColumn();

        this._stickyHeader = useStickyHeader({
            getStickyEl: () => this.$refs.stickyWrapperEl,
            getAnchorEl: () => this.$refs.stickySpacerEl,
            getContainerEl: () => [
                this.$refs.cardsGridEl,
                this.$refs.stickySpacerEl?.closest('.container'),
            ].filter(Boolean),
            getIsActive: () => this.stickyActive,
            onActivate: () => {
                const wrapper = this.$refs.stickyWrapperEl;
                if (!this.stickyActive) {
                    this.stickySpacerHeight = wrapper ? wrapper.offsetHeight : 0;
                }
                const rect = wrapper ? wrapper.getBoundingClientRect() : null;
                this.stickyActive = true;
                this.stickyLeft = rect ? rect.left : 0;
                this.stickyWidth = rect ? rect.width : 0;
            },
            onDeactivate: () => {
                this.stickyActive = false;
            },
        });
        this.$nextTick(() => {
            requestAnimationFrame(() => {
                if (this._stickyHeader) this._stickyHeader.setup();
            });
        });
    },
    beforeUnmount() {
        this._stickyHeader?.teardown();
    },
    methods: {
        highlightText(text) {
            return this.searchActive ? this.search.highlightRawText(text) : escapeHtml(text);
        },
        highlightHtml(htmlContent) {
            return this.searchActive ? this.search.highlightHtmlContent(htmlContent) : (htmlContent || '');
        },
        matchFor(ci) {
            return this.cardMatches.get(ci) || null;
        },
        // Fields to list on the card: matches not visible on the card itself
        matchedFieldsFor(ci) {
            const m = this.matchFor(ci);
            if (!m || m.shownMatch) return [];
            return m.matchedFields;
        },
        isDetailsOnlyMatch(ci) {
            const m = this.matchFor(ci);
            return !!(m && !m.shownMatch);
        },
        isActionDisabled(card) {
            const fn = this.effectiveAction.disabled;
            try { return typeof fn === 'function' ? !!fn(card.row) : false; } catch { return false; }
        },
        selectSearchResultFor(visibleIdx) {
            if (!this.searchActive || this.hideCardsOnSearch) return;
            const matchIdx = this.searchMatchedCardIndices.get(visibleIdx);
            if (matchIdx !== undefined) this.search.setSearchIndex(matchIdx + 1);
        },
        performAction(card) {
            const a = this.effectiveAction;
            if (a.kind === 'none' || this.isActionDisabled(card)) return;
            const ctx = { searchTerm: (this.search.searchValue.value || '').trim() };
            if (typeof a.perform === 'function') a.perform(card.row, ctx);
            else this.$emit('row-action', card.row, ctx);
        },
        handleCardClick(card, visibleIdx, event) {
            if (event?.target?.closest?.('button, a, input, select, textarea, .column-button')) return;
            this.selectSearchResultFor(visibleIdx);
            if (this.cardIsTrigger) this.performAction(card);
        },
        handleKeyDown(event, card, visibleIdx) {
            if (event.target !== event.currentTarget) return;
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.selectSearchResultFor(visibleIdx);
                this.performAction(card);
            }
        },
        handleRefresh() {
            this.$emit('refresh');
        },
        // The view's sort (resolveView normalizes it to [{ key, direction }])
        getDefaultSortCriteria() {
            return (this.resolved.sort || []).map(({ key, direction }) => ({
                column: this.sortableColumns.find(col => col.key === key) || { key, type: null },
                direction
            }));
        },
        getCurrentSortCriteria() {
            if (!this.selectedSortKey) return [];
            const column = this.sortableColumns.find(col => col.key === this.selectedSortKey);
            if (!column) return [];
            return [{ column, direction: this.selectedSortDirection }];
        },
        applyDefaultSortColumn(options = {}) {
            const { force = false } = options;
            const defaultSortCriteria = this.getDefaultSortCriteria();
            if (defaultSortCriteria.length === 0) return;
            const currentSortColumn = this.sortableColumns.find(col => col.key === this.selectedSortKey);
            const hasValidCurrentSort = !!(this.selectedSortKey && currentSortColumn);
            if (!force && hasValidCurrentSort) return;
            this.selectedSortKey = defaultSortCriteria[0].column.key;
            this.selectedSortDirection = defaultSortCriteria[0].direction;
            this.isUsingDefaultSort = true;
        },
        cardValue(card, key) {
            if (card?.row && Object.prototype.hasOwnProperty.call(card.row, key)) return card.row[key];
            return card?.[key];
        },
        compareCardsByColumn(aCard, bCard, column, direction) {
            const aValue = this.cardValue(aCard, column.key);
            const bValue = this.cardValue(bCard, column.key);

            const aMissing = aValue === null || aValue === undefined || aValue === '';
            const bMissing = bValue === null || bValue === undefined || bValue === '';
            if (aMissing && bMissing) return 0;
            if (aMissing) return 1;
            if (bMissing) return -1;

            const columnType = String(column.type || '').toLowerCase();
            if (columnType === 'item') {
                const comparison = compareItemLikeValues(aValue, bValue);
                return direction === 'desc' ? -comparison : comparison;
            }

            const aDate = parseDate(aValue);
            const bDate = parseDate(bValue);
            if ((columnType === 'date' || columnType === '') && aDate && bDate) {
                const comparison = aDate.getTime() - bDate.getTime();
                return direction === 'desc' ? -comparison : comparison;
            }

            const aNum = parseFloat(aValue);
            const bNum = parseFloat(bValue);
            const isANum = !isNaN(aNum);
            const isBNum = !isNaN(bNum);

            let comparison = 0;
            if (columnType === 'number' && isANum && isBNum) {
                comparison = aNum - bNum;
            } else if (isANum && isBNum && columnType !== 'string') {
                comparison = aNum - bNum;
            } else {
                comparison = String(aValue).localeCompare(String(bValue), undefined, { numeric: true, sensitivity: 'base' });
            }
            return direction === 'desc' ? -comparison : comparison;
        },
        handleSortSelectionChange() {
            if (!this.selectedSortKey) {
                this.applyDefaultSortColumn({ force: true });
                return;
            }
            this.selectedSortDirection = 'asc';
            this.isUsingDefaultSort = false;
        },
        isCardAnalyzing(card) {
            return !!(card && card.AppData && card.AppData._analyzing === true);
        },
        handlePinClick(event, card) {
            event.stopPropagation();
            this.$emit('toggle-pin', card.title || card.id);
        },
        isPinned(card) {
            return this.pinnedItems.has(card.title || card.id);
        }
    },
    template: html`
        <div style="width: 100%;">
            <template v-if="showHeader">
            <div ref="stickySpacerEl" class="sticky-header-spacer" :style="stickyActive ? { height: stickySpacerHeight + 'px', marginBottom: 'var(--padding-md)' } : { height: '0', marginBottom: '0' }"></div>
            <div ref="stickyWrapperEl" class="sticky-header-wrapper" :style="stickyActive ? { position: 'fixed', left: stickyLeft + 'px', width: stickyWidth + 'px', zIndex: '1000' } : { marginBottom: 'var(--padding-md)' }">
                <ContentHeaderComponent
                    :theme="theme"
                    :search="search"
                    :show-search="showSearch"
                    :match-count="searchMatchCount"
                    :show-navigate="!hideCardsOnSearch"
                    :show-refresh="showRefresh"
                    :is-loading="isLoading"
                    :view-select="viewSelect"
                    :embedded-loading="true"
                    :is-analyzing="isAnalyzing"
                    :loading-progress="loadingProgress"
                    @refresh="handleRefresh"
                >
                    <template #header-area><slot name="header-area"></slot></template>
                    <template #actions>
                        <select v-if="showSort && sortableColumns.length > 0" v-model="selectedSortKey" @change="handleSortSelectionChange" class="search-input" title="Sort cards">
                            <option v-if="!selectedSortKey" value="">Default sort</option>
                            <option v-for="col in sortableColumns" :key="col.key" :value="col.key">Sort by: {{ col.label }}</option>
                        </select>
                    </template>
                </ContentHeaderComponent>
            </div>
            </template>

            <!-- Cards Grid (shows during analysis with progressive updates) -->
            <div ref="cardsGridEl" v-if="shouldShowCards" class="cards-grid">
                <div
                    v-for="({ card, ci }, idx) in visibleCards"
                    :key="(card.id ?? card.title) + '_' + ci"
                    :data-search-match-idx="searchMatchedCardIndices.get(idx)"
                    :class="['card', { 'clickable': cardIsTrigger, 'analyzing': isCardAnalyzing(card), 'search-active-result': !hideCardsOnSearch && searchMatchedCardIndices.get(idx) === search.searchIndex.value - 1, 'details-match': cardIsTrigger && isDetailsOnlyMatch(ci) }, card.cardClass || theme]"
                    :tabindex="cardIsTrigger ? 0 : null"
                    @click="handleCardClick(card, idx, $event)"
                    @keydown="handleKeyDown($event, card, idx)"
                    :title="card.title"
                    :aria-label="card.title"
                >
                    <div class="content-header">
                        <h3 v-html="highlightText(card.title)"></h3>
                        <button
                            v-if="showPinButtons"
                            @click="handlePinClick($event, card)"
                            :class="['column-button', { 'active': isPinned(card) }]"
                            :title="isPinned(card) ? 'Unpin' : 'Pin'"
                        >
                            <span class="material-symbols-outlined">{{ isPinned(card) ? 'keep' : 'keep_off' }}</span>
                        </button>
                    </div>
                    <div class="content" v-if="card.content">
                        <div v-html="highlightHtml(card.content)"></div>
                    </div>
                    <!-- Matched fields not visible on the card (details fields, bucket member fields) -->
                    <div v-if="matchedFieldsFor(ci).length > 0" class="content hidden-matches">
                        <div v-for="field in matchedFieldsFor(ci)" :key="field.fieldName + '_' + field.value" class="match-indicator">
                            <strong>{{ field.fieldName }}:</strong>
                            <span v-html="highlightText(field.value)"></span>
                        </div>
                    </div>
                    <div class="content-footer" v-if="card.contentFooter || (card.footerActions && card.footerActions.length) || hasActionButton">
                        <div v-if="card.contentFooter" v-html="highlightHtml(card.contentFooter)"></div>
                        <div v-if="(card.footerActions && card.footerActions.length) || hasActionButton" class="button-bar">
                            <button
                                v-for="action in (card.footerActions || [])"
                                :key="action.label"
                                :class="['card', action.class || 'red']"
                                :disabled="!action.onClick"
                                :title="action.title || null"
                                @click.stop="action.onClick && action.onClick()"
                                v-html="action.label"
                            ></button>
                            <!-- Primary action button (button trigger) -->
                            <button
                                v-if="hasActionButton"
                                :class="['button-symbol', theme, 'card-action-button', isDetailsOnlyMatch(ci) ? 'search-match' : '']"
                                :disabled="isActionDisabled(card)"
                                :title="effectiveAction.label || 'Details'"
                                @click.stop="performAction(card)"
                            >{{ effectiveAction.label || effectiveAction.icon || '☷' }}</button>
                        </div>
                    </div>
                </div>

                <!-- "Showing x of y" when a search filters cards -->
                <div v-if="searchActive && hideCardsOnSearch && visibleCards.length !== cards.length" class="card" style="align-self: start; height: auto; gap:var(--padding-md);">
                    <p>
                        Showing {{ visibleCards.length }} of {{ cards.length }} cards.
                    </p>
                    <button
                        @click="search.clearSearch"
                        title="Clear filter"
                        class="yellow"
                    >
                        Show all
                    </button>
                </div>
            </div>

            <!-- Loading / empty -->
            <div v-if="isLoading || isAnalyzing" class="loading-message">
                <img v-if="!showHeader && !shouldShowCards" src="assets/loading.gif" alt="Loading..."/>
                <p>{{ loadingMessage || 'Loading...' }}</p>
            </div>
            <p v-else-if="shouldShowEmpty" class="empty-message">{{ emptyMessage }}</p>
        </div>
    `
};
