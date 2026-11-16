import { html, Requests, getReactiveStore } from '../../index.js';

/**
 * A show's output PDFs from the company Dropbox (CLIENT / YEAR / SHOW / OUTPUT), one detail item
 * per OUTPUT subfolder, each PDF a button that opens it in a new tab. Read through a reactive store,
 * so the list follows Dropbox changes. Used in the schedule's show details.
 */
export const ShowOutputFiles = {
    name: 'ShowOutputFiles',
    props: {
        show: { type: String, default: '' },
        client: { type: String, default: '' },
        year: { type: [String, Number], default: '' }
    },
    data() {
        return { store: null, opening: null };
    },
    computed: {
        showKey() {
            return [this.show, this.client, this.year].join('|');
        },
        groups() {
            const projects = this.store?.data || [];
            return projects.flatMap(project => project.groups.map(group => ({
                key: `${project.path}/${group.name}`,
                // Two project folders (a show filed under two client folders): say whose
                label: [projects.length > 1 ? project.client : '', group.name || 'OUTPUT'].filter(Boolean).join(' · '),
                files: group.files
            })));
        },
        message() {
            if (!this.store || this.store.isLoading) return 'Looking in Dropbox…';
            if (this.store.error) return this.store.error;
            if (!this.store.data.length) return 'No Dropbox project folder found for this show.';
            if (!this.groups.length) return 'No PDFs in OUTPUT yet.';
            return '';
        }
    },
    watch: {
        showKey: {
            immediate: true,
            handler() {
                this.store = getReactiveStore(Requests.getShowOutputFiles, null, [this.show, this.client, String(this.year)]);
            }
        }
    },
    methods: {
        async open(file) {
            // The tab opens inside the click: one opened after waiting for the file would be blocked
            const tab = window.open('', '_blank');
            if (!tab) {
                this.$modal.alert('The browser blocked the new tab. Allow pop-ups for this site, then try again.', 'Tab blocked', false);
                return;
            }
            try {
                tab.document.title = file.name;
                tab.document.body.textContent = `Opening ${file.name}…`;
            } catch { /* the tab is already elsewhere */ }
            this.opening = file.path;
            try {
                tab.location.href = await Requests.getDropboxFileUrl(file.path);
            } catch (error) {
                tab.close();
                this.$modal.error(`Couldn't open ${file.name}: ${error.message}`, 'Dropbox');
            } finally {
                this.opening = null;
            }
        }
    },
    template: html`
        <div class="details-grid">
            <div v-if="message" class="detail-item">
                <label>Dropbox Output</label>
                <span>
                    {{ message }}
                    <button v-if="store?.error && !store.isLoading" class="white small" @click="store.load('Looking in Dropbox…')">Try again</button>
                </span>
            </div>
            <div v-for="group in groups" :key="group.key" class="detail-item">
                <label>{{ group.label }}</label>
                <span class="cell-button-list">
                    <button
                        v-for="file in group.files"
                        :key="file.path"
                        class="white small"
                        :title="file.name"
                        :disabled="opening === file.path"
                        @click="open(file)"
                    >{{ opening === file.path ? 'Opening…' : file.name }}</button>
                </span>
            </div>
        </div>
    `
};
