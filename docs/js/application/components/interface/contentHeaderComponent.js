import { html } from '../../utils/template-helpers.js';
import { LoadingBarComponent } from '../../index.js';
import { SearchBoxComponent } from '../../utils/useSearch.js';
import { ViewSelectComponent } from './viewSelectComponent.js';

/**
 * ContentHeaderComponent — the shared renderer header (§4.13).
 *
 * Layout: #header-area · spacer · [ search · #actions · refresh/discard · #actions-end · view switch ] · loading bar
 * Sticky positioning stays in each renderer; this component only draws the bar.
 *
 * View switching: `viewSelect` ({ views, currentId, defaultId, containerPath, navigateToPath }) renders
 * ViewSelectComponent (the page view registry's switcher).
 */
export const ContentHeaderComponent = {
    name: 'ContentHeaderComponent',
    components: { LoadingBarComponent, SearchBoxComponent, ViewSelectComponent },
    props: {
        theme: { type: String, default: '' },
        // Search
        search: { type: Object, default: null },
        showSearch: { type: Boolean, default: false },
        matchCount: { type: Number, default: 0 },
        showNavigate: { type: Boolean, default: true },
        showHideToggle: { type: Boolean, default: false },
        hideRows: { type: Boolean, default: false },
        // Refresh / discard
        showRefresh: { type: Boolean, default: false },
        isLoading: { type: Boolean, default: false },
        dirty: { type: Boolean, default: false },
        // View switching
        viewSelect: { type: Object, default: null },
        // Embedded loading bar (calendar, cards). The table draws its own bar outside the header.
        embeddedLoading: { type: Boolean, default: false },
        isAnalyzing: { type: Boolean, default: false },
        loadingProgress: { type: Number, default: -1 },
        // Force the button bar even when nothing else needs it (keeps legacy layouts identical)
        alwaysShowButtons: { type: Boolean, default: false }
    },
    emits: ['refresh', 'update:hideRows'],
    computed: {
        showViewSelect() {
            return !!(this.viewSelect && this.viewSelect.views && this.viewSelect.views.length > 1 && this.viewSelect.containerPath);
        },
        hasButtons() {
            return this.alwaysShowButtons || this.showSearch || this.showRefresh || this.showViewSelect
                || !!this.$slots.actions || !!this.$slots['actions-end'];
        }
    },
    template: html`
        <div :class="['content-header', theme]">
            <slot name="header-area"></slot>
            <div class="spacer"></div>
            <div v-if="hasButtons" class="button-bar">
                <SearchBoxComponent
                    v-if="showSearch && search"
                    :search="search"
                    :match-count="matchCount"
                    :show-navigate="showNavigate"
                    :show-hide-toggle="showHideToggle"
                    :hide-rows="hideRows"
                    @update:hide-rows="$emit('update:hideRows', $event)"
                />
                <slot name="actions"></slot>
                <button
                    v-if="showRefresh"
                    @click="$emit('refresh')"
                    :disabled="isLoading"
                    :class="['refresh-button', dirty ? 'red' : '']"
                >{{ isLoading ? 'Loading...' : (dirty ? 'Discard' : 'Refresh') }}</button>
                <slot name="actions-end"></slot>
                <ViewSelectComponent
                    v-if="showViewSelect"
                    :views="viewSelect.views"
                    :current-id="viewSelect.currentId"
                    :default-id="viewSelect.defaultId"
                    :container-path="viewSelect.containerPath"
                    :navigate-to-path="viewSelect.navigateToPath"
                />
            </div>
            <LoadingBarComponent
                v-if="embeddedLoading"
                :is-loading="isLoading"
                :is-analyzing="isAnalyzing"
                :percent-complete="loadingProgress"
                class="embedded"
            />
        </div>
    `
};
