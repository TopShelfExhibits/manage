import { html } from '../../utils/template-helpers.js';
import { NavigationRegistry } from '../../index.js';

/**
 * ViewSelectComponent — switches between the views of a page view registry (§4.11).
 *
 * - 2 views: an icon toggle showing the other view's icon.
 * - 3+ views: a named menu (select).
 * Switching writes `?view=<id>` (the default view removes the parameter) and clears the legacy
 * `layout` parameter. On the dashboard it rewrites the card's stored path instead of navigating,
 * so the card remembers its last view (R3.3).
 */
export const ViewSelectComponent = {
    name: 'ViewSelectComponent',
    inject: ['appContext'],
    props: {
        views: { type: Array, required: true },          // [{ id, name, icon }]
        currentId: { type: String, required: true },
        defaultId: { type: String, default: null },
        containerPath: { type: String, required: true },
        navigateToPath: { type: Function, default: null }
    },
    computed: {
        otherView() {
            if (this.views.length !== 2) return null;
            return this.views.find(v => v.id !== this.currentId) || this.views[0];
        }
    },
    methods: {
        select(id) {
            if (!id || id === this.currentId) return;
            const cleanPath = this.containerPath.split('?')[0];
            const isOnDashboard = this.appContext?.currentPath?.split('?')[0].split('/')[0] === 'dashboard';
            const newPath = NavigationRegistry.buildPathWithCurrentParams(cleanPath, this.appContext?.currentPath, {
                view: id === this.defaultId ? undefined : id,
                layout: undefined
            });
            if (isOnDashboard) {
                NavigationRegistry.dashboardRegistry.updatePath(cleanPath, newPath);
            } else if (this.navigateToPath) {
                this.navigateToPath(newPath);
            }
        }
    },
    template: html`
        <button
            v-if="otherView"
            class="white button-symbol view-select"
            :title="'Switch to ' + (otherView.name || otherView.id)"
            @click="select(otherView.id)"
        >
            <span class="material-symbols-outlined">{{ otherView.icon || 'visibility' }}</span>
        </button>
        <select
            v-else-if="views.length > 2"
            class="search-input view-select"
            title="Change view"
            :value="currentId"
            @change="select($event.target.value)"
        >
            <option v-for="v in views" :key="v.id" :value="v.id">{{ v.name || v.id }}</option>
        </select>
    `
};
