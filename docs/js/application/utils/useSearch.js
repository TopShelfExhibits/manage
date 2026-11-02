import {html} from '../index.js';
import { searchWords as toSearchWords, makeHighlighter } from './views/searchMatch.js';

/**
 * useSearch - Vue 3 Composable for Search Functionality
 *
 * Provides the search box state for one renderer: the debounced term and its effective words
 * (searchMatch.searchWords), highlighting through the shared highlighter, the active result
 * index, and URL parameter synchronization. Matching itself is searchMatch.matchRows.
 *
 * @example
 * const search = useSearch({
 *     syncWithUrl: true,
 *     navigationRegistry: NavigationRegistry,
 *     containerPath: '/inventory',
 *     appContext: { currentPath: '/inventory?tab=items' }
 * });
 *
 * // In template
 * <input v-model="search.searchValue.value" />
 * <span v-html="search.highlightRawText(text)"></span>
 */

/** Delay between the last keystroke and the search being applied to rows */
export const SEARCH_DEBOUNCE_MS = 150;

function getFocusedSearchInput() {
    const active = document.activeElement;
    return (active instanceof HTMLInputElement && active.classList.contains('search-input')) ? active : null;
}

function captureSearchInputFocusState() {
    const input = getFocusedSearchInput();
    if (!input) return null;
    return {
        input,
        value: input.value,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd
    };
}

function restoreSearchInputFocusState(state) {
    if (!state) return;

    let target = null;
    if (state.input && document.contains(state.input)) {
        target = state.input;
    } else {
        const candidates = Array.from(document.querySelectorAll('input.search-input'));
        target = candidates.find(el => el.value === state.value && el.offsetParent !== null) || candidates[0] || null;
    }

    if (!target) return;
    target.focus({ preventScroll: true });
    if (typeof state.selectionStart === 'number' && typeof state.selectionEnd === 'number') {
        try { target.setSelectionRange(state.selectionStart, state.selectionEnd); } catch (_) {}
    }
}

function restoreSearchInputFocusStateWithRetry(state) {
    if (!state) return;
    restoreSearchInputFocusState(state);
    requestAnimationFrame(() => restoreSearchInputFocusState(state));
}

/**
 * Create a search composable
 * @param {Object} options - Configuration options
 * @param {Boolean} options.syncWithUrl - Enable URL parameter synchronization
 * @param {Object} options.navigationRegistry - Navigation registry for URL sync
 * @param {String} options.containerPath - Container path for URL sync
 * @param {Object} options.appContext - App context with currentPath
 * @returns {Object} Search state and methods
 */
export function useSearch(options = {}) {
    const {
        syncWithUrl = false,
        navigationRegistry = null,
        containerPath = null,
        appContext = null
    } = options;

    // State
    // searchValue is bound to the input and synced to the URL; matching and highlighting follow
    // debouncedValue, which trails typing by SEARCH_DEBOUNCE_MS (clearing applies at once).
    const searchValue = Vue.ref('');
    const debouncedValue = Vue.ref('');
    const _clearingSearch = Vue.ref(false);
    let debounceTimer = null;
    function applyNow(value) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
        debouncedValue.value = value;
    }
    Vue.watch(searchValue, (value) => {
        if (!value || !value.trim()) { applyNow(value); return; }
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => applyNow(searchValue.value), SEARCH_DEBOUNCE_MS);
    });

    // Computed
    // Words shorter than SEARCH_LIMITS.minTermLength are dropped before matching and highlighting (§4.5).
    // searchKey is the effective search as a string: keystrokes that don't change the effective words
    // (a trailing space, a one-letter word) leave it equal, so nothing downstream recomputes.
    const searchKey = Vue.computed(() => toSearchWords(debouncedValue.value).join(' '));
    const searchWords = Vue.computed(() => {
        return searchKey.value ? searchKey.value.split(' ') : [];
    });

    // A search with no remaining words is inactive: no filtering, highlighting or glow
    const hasActiveSearch = Vue.computed(() => {
        return searchWords.value.length > 0;
    });

    const searchIndex = Vue.ref(null); // 1-based index of active search result, null = nothing selected

    // The shared highlighter (searchMatch.makeHighlighter), rebuilt only when the words change
    const highlighter = Vue.computed(() => makeHighlighter(searchWords.value));

    /**
     * Highlight search terms in plain text
     * @param {String} text - The text to highlight
     * @returns {String} Escaped HTML with highlighted matches
     */
    function highlightRawText(text) {
        return highlighter.value(text);
    }

    /**
     * Highlight search terms in HTML content
     * Strips HTML tags, highlights matches, preserves line breaks
     * @param {String} htmlContent - HTML content to highlight
     * @returns {String} HTML with highlighted matches (preserves <br> tags)
     */
    function highlightHtmlContent(htmlContent) {
        if (!hasActiveSearch.value || !htmlContent) {
            return htmlContent || '';
        }
        // Line breaks become newlines before the tags are stripped, and <br> again afterwards
        const processedContent = String(htmlContent)
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n')
            .replace(/<\/div>/gi, '\n')
            .replace(/<\/li>/gi, '\n');
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = processedContent;
        const plainText = tempDiv.textContent || tempDiv.innerText || '';
        return highlighter.value(plainText).replace(/\n/g, '<br>');
    }

    /**
     * Clear the search field and optionally update URL
     */
    function clearSearch() {
        const focusedSearchInputState = captureSearchInputFocusState();
        _clearingSearch.value = true;
        searchValue.value = '';
        searchIndex.value = null;
        if (syncWithUrl && navigationRegistry && containerPath) {
            const appContent = document.getElementById('app-content');
            const savedTop = appContent ? appContent.scrollTop : window.scrollY;
            const savedLeft = appContent ? appContent.scrollLeft : window.scrollX;
            navigationRegistry.updatePathParametersSilently(
                containerPath.split('?')[0],
                appContext?.currentPath,
                { searchTerm: undefined, searchIndex: undefined }
            );
            requestAnimationFrame(() => {
                if (appContent) {
                    appContent.scrollTo({ top: savedTop, left: savedLeft, behavior: 'auto' });
                } else {
                    window.scrollTo({ top: savedTop, left: savedLeft, behavior: 'auto' });
                }
                restoreSearchInputFocusStateWithRetry(focusedSearchInputState);
            });
        } else if (focusedSearchInputState) {
            requestAnimationFrame(() => restoreSearchInputFocusStateWithRetry(focusedSearchInputState));
        }
        setTimeout(() => {
            _clearingSearch.value = false;
        }, 100);
    }

    function setSearchIndex(n) {
        const focusedSearchInputState = captureSearchInputFocusState();
        searchIndex.value = n;
        if (syncWithUrl && navigationRegistry && containerPath) {
            // Include searchTerm in the same update to avoid the blur-delay race condition
            navigationRegistry.updatePathParametersSilently(
                containerPath.split('?')[0],
                appContext?.currentPath,
                {
                    searchIndex: (n != null) ? String(n) : undefined,
                    searchTerm: (searchValue.value && searchValue.value.trim()) ? searchValue.value : undefined
                }
            );
            if (focusedSearchInputState) {
                requestAnimationFrame(() => restoreSearchInputFocusStateWithRetry(focusedSearchInputState));
            }
        }
    }

    /**
     * Update URL parameter with search term
     * @param {String} value - Search value to set in URL
     */
    function updateUrlParameter(value) {
        if (!syncWithUrl || !navigationRegistry || !containerPath) {
            return;
        }
        
        // Use silent parameter update to avoid triggering full navigation
        navigationRegistry.updatePathParametersSilently(
            containerPath.split('?')[0],
            appContext?.currentPath,
            {
                searchTerm: (value && value.trim()) ? value : undefined
            }
        );
    }

    /**
     * Handle search input blur event
     * Defers URL sync to allow navigation to complete, then checks if still in same section
     */
    function handleBlur() {
        if (!syncWithUrl || _clearingSearch.value) return;
        
        // Capture the current path at blur time
        const pathAtBlur = appContext?.currentPath;
        if (!pathAtBlur) return;
        
        // Extract top-level section from path (e.g., "/inventory/furniture" → "inventory")
        const getTopLevelSection = (path) => {
            const cleanPath = path.split('?')[0]; // Remove query params
            const segments = cleanPath.split('/').filter(s => s.length > 0);
            return segments[0] || '';
        };
        
        const sectionAtBlur = getTopLevelSection(pathAtBlur);
        
        // Defer URL update asynchronously to allow navigation to complete
        setTimeout(() => {
            const currentPath = appContext?.currentPath;
            if (!currentPath) return;
            
            const currentSection = getTopLevelSection(currentPath);
            
            // Only sync if we're still in the same top-level section
            if (currentSection === sectionAtBlur && navigationRegistry) {
                // Update parameters on the CURRENT path, not the original containerPath
                const currentBasePath = currentPath.split('?')[0];
                navigationRegistry.updatePathParametersSilently(
                    currentBasePath,
                    currentPath,
                    {
                        searchTerm: (searchValue.value && searchValue.value.trim()) ? searchValue.value : undefined
                    }
                );
            }
            // If we've navigated to a different section, skip the sync
        }, 100); // Brief pause to ensure navigation completes
    }

    /**
     * Initialize search value from URL parameters
     */
    function initializeFromUrl() {
        if (!syncWithUrl || !navigationRegistry || !containerPath || !appContext?.currentPath) {
            return;
        }
        
        const params = navigationRegistry.getParametersForContainer(
            containerPath,
            appContext.currentPath
        );
        if (params?.searchTerm) {
            searchValue.value = params.searchTerm;
            applyNow(params.searchTerm); // a shared link opens with its search applied, not debounced
        }
        if (params?.searchIndex) {
            searchIndex.value = parseInt(params.searchIndex) || null;
        }
    }

    /**
     * Watch for URL parameter changes when syncWithUrl is enabled
     */
    function setupUrlWatcher() {
        if (!syncWithUrl || !appContext) return null;
        
        return Vue.watch(
            () => appContext.currentPath,
            (newPath, oldPath) => {
                if (!oldPath || !navigationRegistry || !containerPath) return;
                
                // Get parameters from both paths
                const newParams = navigationRegistry.getParametersForContainer(
                    containerPath,
                    newPath
                );
                const oldParams = navigationRegistry.getParametersForContainer(
                    containerPath,
                    oldPath
                );
                
                if (newParams?.searchTerm !== oldParams?.searchTerm) {
                    searchValue.value = newParams?.searchTerm || '';
                    applyNow(searchValue.value);
                }
                if (newParams?.searchIndex !== oldParams?.searchIndex) {
                    searchIndex.value = newParams?.searchIndex ? (parseInt(newParams.searchIndex) || null) : null;
                }
            }
        );
    }

    return {
        // State
        searchValue,
        debouncedValue,
        searchKey,
        searchWords,
        hasActiveSearch,
        searchIndex,

        // Methods
        highlightRawText,
        highlightHtmlContent,
        clearSearch,
        setSearchIndex,
        handleBlur,
        updateUrlParameter,
        initializeFromUrl,
        setupUrlWatcher
    };
}

// Scrolls #app-content so the element is centered below the component's sticky header.
export function scrollToSearchResult(el, componentEl) {
    if (!el) return;

    // Manage row-level search-active-result for nested tables where Vue bindings can't reach
    if (componentEl) {
        componentEl.querySelectorAll('tr.search-active-result').forEach(r => r.classList.remove('search-active-result'));
    }
    if (el.tagName === 'TR') {
        el.classList.add('search-active-result');
    }

    const container = document.getElementById('app-content');
    
    if (!container) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
    }

    // Try native scrollIntoView first (simplest approach)
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Also try custom calculation for better sticky header awareness
    try {
        const stickyEl = componentEl?.querySelector('.sticky-header-wrapper');
        const stickyH = (stickyEl && window.getComputedStyle(stickyEl).position === 'fixed')
            ? stickyEl.offsetHeight : 0;

        const containerRect = container.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const elTop = elRect.top - containerRect.top + container.scrollTop;
        const visibleH = container.clientHeight - stickyH;
        const target = elTop - stickyH - visibleH / 2 + el.offsetHeight / 2;

        if (Math.abs(container.scrollTop - target) > 5) {
            container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
        }
    } catch (_) {}
}

// Shared scroll implementation for components whose results use [data-search-match-idx] on a flat element.
export function scrollToActiveResult(component, index, matchCount) {
    component.$nextTick(() => {
        if (index == null) return;
        if (!(component.$el instanceof Element)) return;
        const el = component.$el.querySelector(`[data-search-match-idx="${index - 1}"]`);
        if (!el && matchCount === 0) return;
        scrollToSearchResult(el, component.$el);
    });
}

export const SearchBoxComponent = {
    name: 'SearchBoxComponent',
    props: {
        search:          { type: Object,  required: true },
        matchCount:      { type: Number,  default: 0 },
        showNavigate:    { type: Boolean, default: true },
        showHideToggle:  { type: Boolean, default: false },
        hideRows:        { type: Boolean, default: false }
    },
    emits: ['update:hideRows'],
    watch: {
        matchCount(newCount) {
            // Auto-select first result when results appear and no result is currently selected.
            if (this.showNavigate && this.search.hasActiveSearch.value && newCount > 0 && Number.isFinite(newCount) && !this.search.searchIndex.value) {
                this.search.setSearchIndex(1);
            }
        }
    },
    computed: {
        // Broad search aborted (§4.5): the renderer passes matchCount = Infinity
        isBroad() {
            return this.matchCount === Infinity;
        }
    },
    methods: {
        navigate(direction) {
            if (!this.matchCount || !Number.isFinite(this.matchCount)) return;
            const current = this.search.searchIndex.value || 0;
            let next = current + direction;
            if (next < 1) next = this.matchCount;
            if (next > this.matchCount) next = 1;
            this.search.setSearchIndex(next);
        }
    },
    template: html`
        <div class="input-container">
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
                @mousedown.prevent="search.clearSearch"
                class="column-button"
                title="Clear filter"
            ><span class="material-symbols-outlined">backspace</span></button>
            <button
                v-if="showHideToggle"
                @mousedown.prevent="$emit('update:hideRows', !hideRows)"
                class="column-button"
                :title="hideRows ? 'Show all rows' : 'Hide non-matching rows'"
            ><span class="material-symbols-outlined">{{ hideRows ? 'visibility' : 'visibility_off' }}</span></button>
        </div>
        <div v-if="showNavigate" class="card search-nav-card white">
            <!-- No search: blank card -->
            <template v-if="!search.hasActiveSearch.value"></template>
            <!-- Broad search aborted: show infinity without navigation -->
            <template v-else-if="isBroad">
                <span class="search-nav-display">∞</span>
            </template>
            <!-- Hide-rows mode: show count without navigation buttons -->
            <template v-else-if="showHideToggle && hideRows">
                <span class="search-nav-display">{{ matchCount }}</span>
            </template>
            <!-- Search active but no results: show 0/0 without buttons -->
            <template v-else-if="matchCount === 0">
                <span class="search-nav-display">0 / 0</span>
            </template>
            <!-- Search active with results: show full navigation -->
            <template v-else>
                <button
                    @mousedown.prevent="navigate(-1)"
                    class="column-button"
                    style="margin:0; left: -2px; top: calc(50% - 10px); border: none; background: none; box-shadow: none; opacity: 0.7; pointer-events: auto;"
                    :disabled="!matchCount"
                    title="Previous result"
                ><span class="material-symbols-outlined">chevron_left</span></button>
                <span :class="'search-nav-display ' + (matchCount>=10 ? 'font-narrow' : '')">{{ search.searchIndex.value || '?' }}{{ matchCount < 100 ? ' ' : '' }}/{{ matchCount < 100 ? ' ' : '' }}{{ matchCount }}</span>
                <button
                    @mousedown.prevent="navigate(1)"
                    class="column-button"
                    style="margin:0; right: -2px;  top: calc(50% - 10px); border: none; background: none; box-shadow: none; opacity: 0.7; pointer-events: auto;"
                    :disabled="!matchCount"
                    title="Next result"
                ><span class="material-symbols-outlined">chevron_right</span></button>
            </template>
        </div>
    `
};
