import { SignInService } from '../auth/SignInService.js';
import { requestError } from '../auth/authStatus.js';
import { GoogleSheetsService } from './GoogleSheetsData.js';

/**
 * Read-only access to the company's Dropbox project folder, through the sign-in service
 * (SignInService; apps-script/auth-broker, "Dropbox"). The service holds the only Dropbox token;
 * each request carries the user's Google access token, which the service checks with Google. No
 * Dropbox window, no Dropbox token in the browser. Paths are inside the shared folder: '' is the
 * folder itself.
 *
 * Requests go through GoogleSheetsService.withExponentialBackoff, so they take the session's
 * token, are timed, reported to the connection monitor, renew a rejected token once, and retry
 * when they get no answer.
 */

const MAX_PATHS = 25;   // the service lists at most this many folders per request
const BLOB_URL_LIFETIME_MS = 10 * 60 * 1000;   // an opened file's tab has loaded it long before

// Refusals that retrying won't change: returned to the caller, which throws them
const FINAL_REFUSALS = ['NOT_FOUND', 'DROPBOX_NOT_CONNECTED', 'BAD_REQUEST'];
const MESSAGES = {
    NOT_FOUND: 'That file is no longer in Dropbox.',
    DROPBOX_NOT_CONNECTED: 'Dropbox is not connected to the app yet.',
    BAD_REQUEST: 'The file service refused the request.'
};

export class DropboxFiles {
    static _queue = [];
    static _flushScheduled = false;

    /** Whether the app can reach Dropbox at all (the sign-in service is configured) */
    static isAvailable() {
        return SignInService.isConfigured();
    }

    /**
     * One folder's listing. Calls made in the same moment go out together, up to 25 folders a
     * request (the service lists them in parallel).
     * @param {string} path - '' or '/CLIENT/YEAR/...'
     * @param {{ recursive?: boolean }} [options] - recursive: every file and folder below it
     * @returns {Promise<{ entries: Array<{ name, path, folder, size?, modified? }>, missing?: boolean, truncated?: boolean }>}
     */
    static listFolder(path, { recursive = false } = {}) {
        return new Promise((resolve, reject) => {
            this._queue.push({ path, recursive: !!recursive, resolve, reject });
            if (!this._flushScheduled) {
                this._flushScheduled = true;
                setTimeout(() => this._flush(), 0);
            }
        });
    }

    static _flush() {
        this._flushScheduled = false;
        const queue = this._queue;
        this._queue = [];
        for (const recursive of [false, true]) {
            const waiting = queue.filter(item => item.recursive === recursive);
            const paths = [...new Set(waiting.map(item => item.path))];
            for (let i = 0; i < paths.length; i += MAX_PATHS) {
                const chunk = paths.slice(i, i + MAX_PATHS);
                const mine = waiting.filter(item => chunk.includes(item.path));
                this._request({ action: 'dropbox_list', paths: chunk, recursive }).then(
                    answer => mine.forEach(item => item.resolve(answer.folders[item.path])),
                    error => mine.forEach(item => item.reject(error))
                );
            }
        }
    }

    /**
     * An address the browser shows the file at. The file comes from a fresh temporary link (four
     * hours) into a local blob: URL typed by its extension, so a PDF opens in the browser's viewer
     * even when Dropbox sends it as a download. When the download can't be read here, the link.
     * @param {string} path
     * @returns {Promise<string>}
     */
    static async getFileUrl(path) {
        const link = (await this._request({ action: 'dropbox_link', path })).link;
        try {
            const response = await fetch(link);
            if (!response.ok) return link;
            const blob = await response.blob();
            const url = URL.createObjectURL(new Blob([blob], { type: /\.pdf$/i.test(path) ? 'application/pdf' : blob.type }));
            setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_LIFETIME_MS);
            return url;
        } catch {
            return link;
        }
    }

    static async _request(body) {
        if (!SignInService.isConfigured()) throw Object.assign(new Error(MESSAGES.DROPBOX_NOT_CONNECTED), { code: 'DROPBOX_NOT_CONNECTED' });
        const answer = await GoogleSheetsService.withExponentialBackoff(async (token) => {
            const reply = await SignInService.post({ ...body, token });
            if (reply.ok || FINAL_REFUSALS.includes(reply.error)) return reply;
            if (reply.error === 'TOKEN_REJECTED') throw requestError('Google did not accept the sign-in token.', 401);
            if (reply.error === 'ACCOUNT_NOT_ALLOWED') throw requestError('This account may not read the company Dropbox.', 403);
            throw requestError('The file service failed.', 503);   // retried with backoff
        });
        if (!answer.ok) throw Object.assign(new Error(MESSAGES[answer.error]), { code: answer.error });
        return answer;
    }
}
