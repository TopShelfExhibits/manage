import { html } from '../../index.js';

/**
 * Modal component for displaying a list of overlapping shows/packlists
 * Used when there are many overlapping shows that don't fit inline (the showList cell)
 * to: the path for one show, '{value}' replaced by its identifier (default 'packlist/{value}/details')
 */
export const OverlappingShowsModal = {
    props: {
        shows: {
            type: Array,
            required: true
        },
        to: { type: String, default: '' }
    },
    inject: ['appContext'],
    methods: {
        navigateToShow(showId) {
            if (this.appContext?.navigateToPath) {
                this.appContext.navigateToPath((this.to || 'packlist/{value}/details').replace('{value}', showId));
            }
            this.$emit('close-modal');
        }
    },
    template: html`
        <div class="overlapping-shows-modal-content">
            <div class="overlapping-shows-buttons cell-button-list">
                <button v-for="showId in shows"
                        :key="showId"
                        @click="navigateToShow(showId)"
                        class="white">
                    {{ showId }}
                </button>
            </div>
        </div>
    `
};
