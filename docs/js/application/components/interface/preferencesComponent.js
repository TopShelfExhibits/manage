import { html, Requests, getPreferencesStore, modalManager, authState } from '../../index.js';

// Returns true if containerPath satisfies a Page pattern (supports * wildcard suffix)
function matchesPagePattern(containerPath, pattern) {
    const clean = (containerPath || '').split('?')[0];
    if (!pattern) return false;
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) return clean.startsWith(pattern.slice(0, -1));
    return clean === pattern;
}

function parseValue(value, type) {
    if (type === 'integer') return parseInt(value, 10) || 0;
    if (type === 'double') return parseFloat(value) || 0;
    if (type === 'boolean') return value === 'true' || value === true;
    return value ?? '';
}

function serializeValue(value, type) {
    if (type === 'boolean') return String(value);
    return String(value ?? '');
}

const PreferencesEditModal = {
    name: 'PreferencesEditModal',
    props: {
        preferences: { type: Array, required: true },
        onSaved: { type: Function, required: true }
    },
    data() {
        const editValues = {};
        this.preferences.forEach(p => {
            editValues[p.id] = parseValue(p.value, p.type);
        });
        return {
            editValues,
            isLockedByOther: false,
            lockOwner: null,
            isSaving: false,
            lockAcquired: false,
            jsonErrors: {}
        };
    },
    async mounted() {
        await this.acquireLock();
    },
    beforeUnmount() {
        if (this.lockAcquired) this.releaseLock();
    },
    computed: {
        lockOwnerDisplay() {
            return this.lockOwner?.split('@')[0] || 'another user';
        },
        canEdit() {
            return !this.isLockedByOther && !this.isSaving;
        }
    },
    methods: {
        async acquireLock() {
            const user = authState.user?.email;
            if (!user) return;
            try {
                const existing = await Requests.getSheetLock('CACHE', 'Preferences');
                if (existing && existing.user !== user) {
                    this.isLockedByOther = true;
                    this.lockOwner = existing.user;
                    return;
                }
                await Requests.lockSheet('CACHE', 'Preferences', user);
                this.lockAcquired = true;
            } catch (e) {
                console.warn('[PreferencesEditModal] Failed to acquire lock:', e);
            }
        },
        async releaseLock() {
            const user = authState.user?.email;
            if (!user) return;
            this.lockAcquired = false;
            try {
                await Requests.unlockSheet('CACHE', 'Preferences', user);
            } catch (e) {
                console.warn('[PreferencesEditModal] Failed to release lock:', e);
            }
        },
        validateJson(id, value) {
            try {
                JSON.parse(value);
                this.jsonErrors[id] = null;
            } catch (e) {
                this.jsonErrors[id] = e.message;
            }
        },
        async save() {
            if (!this.canEdit) return;
            for (const pref of this.preferences) {
                if (pref.type === 'json') {
                    this.validateJson(pref.id, this.editValues[pref.id]);
                    if (this.jsonErrors[pref.id]) {
                        modalManager.error(`Invalid JSON for "${pref.name}": ${this.jsonErrors[pref.id]}`, 'Validation Error');
                        return;
                    }
                }
            }
            this.isSaving = true;
            try {
                await this.onSaved(this.editValues);
                this.lockAcquired = false;
                await this.releaseLock();
                this.$emit('close-modal');
            } catch (e) {
                modalManager.error(e?.message || 'Failed to save global parameters.', 'Save Failed');
            } finally {
                this.isSaving = false;
            }
        },
        cancel() {
            this.$emit('close-modal');
        }
    },
    template: html`
        <div v-if="isLockedByOther" class="card red">
            <p>Global parameters are being edited by <strong>{{ lockOwnerDisplay }}</strong>.</p>
            <div class="button-bar">
                <button @click="cancel" class="gray">Close</button>
            </div>
        </div>
        <div v-else class="cards-grid">
            <div v-for="pref in preferences" :key="pref.id" class="card">
                <h5>{{ pref.name }}</h5>
                <!-- <div class="form-group"> -->
                    <label v-if="pref.description">{{ pref.description }}</label>
                    <input v-if="pref.type === 'integer'"
                        type="number" step="1"
                        v-model.number="editValues[pref.id]"
                        :disabled="isSaving" />
                    <input v-else-if="pref.type === 'double'"
                        type="number" step="any"
                        v-model.number="editValues[pref.id]"
                        :disabled="isSaving" />
                    <input v-else-if="pref.type === 'boolean'"
                        type="checkbox"
                        v-model="editValues[pref.id]"
                        :disabled="isSaving" />
                    <div v-else-if="pref.type === 'json'">
                        <textarea v-model="editValues[pref.id]"
                                :disabled="isSaving"
                                @input="validateJson(pref.id, editValues[pref.id])"
                                rows="3"></textarea>
                        <small v-if="jsonErrors[pref.id]" class="red">{{ jsonErrors[pref.id] }}</small>
                    </div>
                    <input v-else
                        type="text"
                        v-model="editValues[pref.id]"
                        :disabled="isSaving" />
                <!-- </div> -->
            </div>
            <div class="button-bar">
                <button @click="save" :disabled="!canEdit">Save</button>
                <button @click="cancel" class="gray">Cancel</button>
            </div>
        </div>
    `
};

export const PreferencesMenuComponent = {
    name: 'PreferencesMenuComponent',
    props: {
        containerPath: { type: String, required: true }
    },
    computed: {
        prefsStore() {
            return getPreferencesStore();
        },
        matchingPreferences() {
            if (!Array.isArray(this.prefsStore.data)) return [];
            return this.prefsStore.data.filter(p => matchesPagePattern(this.containerPath, p.page));
        }
    },
    methods: {
        openEditModal() {
            modalManager.custom(
                PreferencesEditModal,
                {
                    preferences: this.matchingPreferences,
                    size: 'card',
                    onSaved: (editValues) => this.savePreferences(editValues)
                },
                'Edit Global Parameters'
            );
        },
        async savePreferences(editValues) {
            const store = this.prefsStore;
            for (const pref of this.matchingPreferences) {
                const idx = store.data.findIndex(p => p.id === pref.id);
                if (idx !== -1) store.data[idx].value = serializeValue(editValues[pref.id], pref.type);
            }
            const saved = await store.save('Saving global parameters...');
            if (!saved) throw new Error(store.error || 'Global parameters could not be saved.');
        }
    },
    template: html`
        <div v-if="matchingPreferences.length > 0" class="preferences-menu-section">
            <button @click="openEditModal">Edit Global Parameters</button>
            <div class="card details-grid" style="--details-grid-min-column-width: 140px;">
                <div v-for="pref in matchingPreferences" :key="pref.id" class="detail-item">
                    <label class="pref-label">{{ pref.name }}:</label>
                    <span class="pref-value" :title="pref.value">{{ pref.value }}</span>
                </div>
            </div>
        </div>
    `
};
