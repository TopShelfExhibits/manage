import { html, Requests, getReactiveStore, modalManager, authState, EditHistoryUtils } from '../../index.js';

// Shared store for all page notes — loaded once, reused across all container instances
function getNotesStore() {
    return getReactiveStore(
        Requests.getPageNotes,
        Requests.savePageNotes,
        []
    );
}

// Modal component rendered inside the ModalManager for editing/adding a note
const PageNoteEditModal = {
    props: {
        existingNote: { type: Object, default: null },
        containerPath: { type: String, required: true },
        onSaved: { type: Function, required: true },
        onRemoved: { type: Function, required: true }
    },
    data() {
        return {
            noteText: '',
            noteColor: '',
            noteSize: 'Normal',
            isLockedByOther: false,
            lockOwner: null,
            isSaving: false,
            lockAcquired: false,
            colorOptions: [
                { value: '', label: 'Normal' },
                { value: 'blue', label: 'Blue' },
                { value: 'green', label: 'Green' },
                { value: 'yellow', label: 'Yellow' },
                { value: 'orange', label: 'Orange' },
                { value: 'red', label: 'Red' },
                { value: 'purple', label: 'Purple' }
            ],
            sizeOptions: [
                { value: 'Normal', label: 'Normal' },
                { value: 'Medium', label: 'Medium' },
                { value: 'Large', label: 'Large' }
            ]
        };
    },
    async mounted() {
        this.noteText = this.existingNote?.Note || '';
        this.noteColor = this.existingNote?.Color || '';
        this.noteSize = this.existingNote?.Size || 'Normal';
        await this.acquireLock();
    },
    beforeUnmount() {
        if (this.lockAcquired) {
            this.releaseLock();
        }
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
                const existing = await Requests.getSheetLock('CACHE', 'Notes');
                if (existing && existing.user !== user) {
                    this.isLockedByOther = true;
                    this.lockOwner = existing.user;
                    return;
                }
                await Requests.lockSheet('CACHE', 'Notes', user);
                this.lockAcquired = true;
            } catch (e) {
                console.warn('[PageNoteEditModal] Failed to acquire lock:', e);
            }
        },
        async releaseLock() {
            const user = authState.user?.email;
            if (!user) return;
            this.lockAcquired = false;
            try {
                await Requests.unlockSheet('CACHE', 'Notes', user);
            } catch (e) {
                console.warn('[PageNoteEditModal] Failed to release lock:', e);
            }
        },
        async save() {
            if (!this.canEdit) return;
            this.isSaving = true;
            try {
                await this.onSaved(this.noteText.trim(), this.noteColor, this.noteSize);
                this.lockAcquired = false;
                await this.releaseLock();
                this.$emit('close-modal');
            } catch (e) {
                modalManager.error(e?.message || 'Failed to save page note.', 'Save Failed');
            } finally {
                this.isSaving = false;
            }
        },
        async remove() {
            if (!this.canEdit) return;
            this.isSaving = true;
            try {
                await this.onRemoved();
                this.lockAcquired = false;
                await this.releaseLock();
                this.$emit('close-modal');
            } catch (e) {
                modalManager.error(e?.message || 'Failed to remove page note.', 'Remove Failed');
            } finally {
                this.isSaving = false;
            }
        },
        cancel() {
            this.$emit('close-modal');
        }
    },
    template: html`
      <div class="page-note-edit-menu">
        <div v-if="isLockedByOther" class="card red">
            <p>Notes are currently being edited by <strong>{{ lockOwnerDisplay }}</strong>.</p>
        </div>
        <template v-else>
            <div class="page-note-edit-field">
                <label>Note</label>
                <textarea v-model="noteText"
                            :disabled="isSaving"
                            class="page-note-textarea"
                            placeholder="Enter a note for this page..."></textarea>
            </div>
            <div class="button-bar">
                <div class="page-note-edit-field">
                    <label for="note-color">Color</label>
                    <select id="note-color" v-model="noteColor" :disabled="isSaving">
                        <option v-for="color in colorOptions" :key="color.value" :value="color.value">
                            {{ color.label }}
                        </option>
                    </select>
                </div>
                <div class="page-note-edit-field">
                    <label for="note-size">Size</label>
                    <select id="note-size" v-model="noteSize" :disabled="isSaving">
                        <option v-for="size in sizeOptions" :key="size.value" :value="size.value">
                            {{ size.label }}
                        </option>
                    </select>
                </div>
            </div>
        </template>
        <div class="button-bar">
            <button :disabled="!canEdit" @click="save">Save</button>
            <button v-if="existingNote && !isLockedByOther"
                    :disabled="!canEdit"
                    class="gray"
                    @click="remove">Remove Note</button>
            <button class="gray" @click="cancel">Cancel</button>
        </div>
      </div>
    `
};

// Menu component for hamburger menu integration
export const PageNoteMenuComponent = {
    props: {
        containerPath: { type: String, required: true }
    },
    computed: {
        notesStore() {
            return getNotesStore();
        },
        cleanPath() {
            return this.containerPath ? this.containerPath.split('?')[0] : '';
        },
        currentNote() {
            if (!Array.isArray(this.notesStore.data) || !this.cleanPath) return null;
            return this.notesStore.data.find(n => n.Path === this.cleanPath) || null;
        }
    },
    methods: {
        openEditModal() {
            modalManager.custom(
                PageNoteEditModal,
                {
                    existingNote: this.currentNote,
                    size: 'card',
                    containerPath: this.cleanPath,
                    onSaved: (text, color, size) => this.saveNote(text, color, size),
                    onRemoved: () => this.removeNote()
                },
                this.currentNote ? 'Modify Page Note' : 'Add Page Note'
            );
        },
        async saveNote(text, color, size) {
            const user = authState.user?.email || 'unknown';
            const store = this.notesStore;
            const existingIndex = store.data.findIndex(n => n.Path === this.cleanPath);
            const oldNote = existingIndex >= 0 ? store.data[existingIndex].Note : '';

            const entry = EditHistoryUtils.createEditHistoryEntry(user, [{ column: 'Note', old: oldNote }]);
            const newHistory = EditHistoryUtils.appendToEditHistory(
                existingIndex >= 0 ? store.data[existingIndex].EditHistory : '',
                entry
            );

            if (existingIndex >= 0) {
                store.data[existingIndex].Note = text;
                store.data[existingIndex].Color = color;
                store.data[existingIndex].Size = size;
                store.data[existingIndex].EditHistory = newHistory;
            } else {
                store.addRow({ Path: this.cleanPath, Note: text, Color: color, Size: size, EditHistory: newHistory });
            }
            const saved = await store.save('Saving note...');
            if (!saved) {
                throw new Error(store.error || 'Page note could not be saved.');
            }
        },
        async removeNote() {
            const store = this.notesStore;
            const existingIndex = store.data.findIndex(n => n.Path === this.cleanPath);
            if (existingIndex >= 0) {
                store.markRowForDeletion(existingIndex);
            }
            const saved = await store.save('Removing note...');
            if (!saved) {
                throw new Error(store.error || 'Page note could not be removed.');
            }
        }
    },
    template: html`
        <div class="page-note-menu-item">
            <button @click="openEditModal">
                {{ currentNote ? 'Modify Page Note' : 'Add Page Note' }}
            </button>
        </div>
    `
};

export const PageNoteComponent = {
    props: {
        containerPath: { type: String, required: true }
    },
    computed: {
        notesStore() {
            return getNotesStore();
        },
        // Strip query params for matching
        cleanPath() {
            return this.containerPath ? this.containerPath.split('?')[0] : '';
        },
        currentNote() {
            if (!Array.isArray(this.notesStore.data) || !this.cleanPath) return null;
            return this.notesStore.data.find(n => n.Path === this.cleanPath) || null;
        }
    },

    template: html`
        <transition name="expand">
            <div v-if="!notesStore.isLoading && currentNote" class="content">
                <p v-if="currentNote.Size === 'Normal' || !currentNote.Size" :class="currentNote.Color || ''">{{ currentNote.Note }}</p>
                <h3 v-else-if="currentNote.Size === 'Medium'" :class="currentNote.Color || ''">{{ currentNote.Note }}</h3>
                <h2 v-else-if="currentNote.Size === 'Large'" :class="currentNote.Color || ''">{{ currentNote.Note }}</h2>
            </div>
        </transition>
    `
};
