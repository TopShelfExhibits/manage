import { html, Requests, isNetworkError } from '../../index.js';

/**
 * A show's output PDFs from the company Dropbox (CLIENT / YEAR / SHOW / OUTPUT), one detail item
 * per OUTPUT subfolder, each PDF a button that opens it in a new tab. Renders nothing when the app
 * has no Dropbox. Used in the schedule's show details.
 */
export const ShowOutputFiles = {
    name: 'ShowOutputFiles',
    props: {
        show: { type: String, default: '' },
        client: { type: String, default: '' },
        year: { type: [String, Number], default: '' }
    },
    data() {
        return { result: null, error: null, loading: false, opening: null };
    },
    computed: {
        showKey() {
            return [this.show, this.client, this.year].join('|');
        },
        groups() {
            const projects = this.result?.projects || [];
            return projects.flatMap(project => project.groups.map(group => ({
                key: `${project.path}/${group.name}`,
                // Two project folders (a show filed under two client folders): say whose
                label: [projects.length > 1 ? project.client : '', group.name || 'OUTPUT'].filter(Boolean).join(' · '),
                files: group.files
            })));
        },
        message() {
            if (this.loading) return 'Looking in Dropbox…';
            if (this.error) return this.error;
            if (!this.result?.projects.length) return 'No Dropbox project folder found for this show.';
            if (!this.groups.length) return 'No PDFs in OUTPUT yet.';
            return '';
        }
    },
    watch: {
        showKey: { immediate: true, handler() { this.load(); } }
    },
    methods: {
        async load() {
            const key = this.showKey;
            this.loading = true;
            this.error = null;
            try {
                const result = await Requests.getShowOutputFiles(this.show, this.client, this.year);
                if (key === this.showKey) this.result = result;
            } catch (error) {
                if (key !== this.showKey) return;
                console.warn('[ShowOutputFiles] Reading Dropbox failed:', error);
                this.error = isNetworkError(error) ? "Couldn't reach Dropbox." : `Couldn't read Dropbox: ${error.message}`;
            } finally {
                if (key === this.showKey) this.loading = false;
            }
        },
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
        <div v-if="result?.available !== false" class="details-grid">
            <div v-if="message" class="detail-item">
                <label>Dropbox Output</label>
                <span>
                    {{ message }}
                    <button v-if="error && !loading" class="white small" @click="load">Try again</button>
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
