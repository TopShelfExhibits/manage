import { html } from '../../utils/template-helpers.js';
import { NavigationRegistry } from '../../index.js';

/**
 * A URL toggle's value from the container's parameters: the parameter when set, else its default.
 * Pages read their toggles with this, from NavigationRegistry.getParametersForContainer.
 * @param {Object} params - The container's parameters
 * @param {{ param: string, default?: boolean }} toggle
 * @returns {boolean}
 */
export function paramToggleValue(params, toggle) {
    const value = params?.[toggle.param];
    return value === undefined ? toggle.default !== false : value === true;
}

/**
 * ParamToggles — a button bar of on/off toggles kept in the container's URL parameters, so a link
 * or a dashboard card keeps them. A toggle at its default leaves the URL (no parameter).
 * Writes go through NavigationRegistry.updateContainerParams, as view switches do.
 *
 * toggles: [{ param, label, title?, default?: boolean (true when omitted) }]
 */
export const ParamToggles = {
    name: 'ParamToggles',
    inject: ['appContext'],
    props: {
        toggles: { type: Array, required: true },
        containerPath: { type: String, required: true },
        navigateToPath: { type: Function, default: null }
    },
    computed: {
        params() {
            return NavigationRegistry.getParametersForContainer(this.containerPath, this.appContext?.currentPath);
        }
    },
    methods: {
        isOn(toggle) {
            return paramToggleValue(this.params, toggle);
        },
        flip(toggle) {
            const value = !this.isOn(toggle);
            NavigationRegistry.updateContainerParams(this.containerPath, this.appContext?.currentPath, {
                [toggle.param]: value === (toggle.default !== false) ? undefined : value
            }, this.navigateToPath);
        }
    },
    template: html`
        <div class="button-bar">
            <button
                v-for="toggle in toggles"
                :key="toggle.param"
                :class="isOn(toggle) ? 'purple' : 'white'"
                :aria-pressed="isOn(toggle)"
                :title="(isOn(toggle) ? 'Hide ' : 'Show ') + (toggle.title || toggle.label)"
                @click="flip(toggle)"
            >{{ toggle.label }}</button>
        </div>
    `
};
