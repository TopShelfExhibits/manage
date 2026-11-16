// The company Dropbox folder, read only (DropboxFiles: the sign-in service's Dropbox actions)
import { DropboxFiles } from '../services.js';
import { wrapMethods, ProductionUtils, normalizeMatchKey } from '../index.js';

/**
 * Project folders are CLIENT / YEAR / SHOW; a show's finished documents sit in its OUTPUT folder,
 * loose or in subfolders (CONCEPT A, ELEVATIONS, CONTROL, SETUP, ...).
 */
const OUTPUT_FOLDER = 'OUTPUT';

// Dropbox has no change stamps for the poller to watch (unlike the sheets), so a listing is read
// again once it is this old. Offline, the cache keeps serving it.
const LISTING_LIFETIME_MS = 5 * 60 * 1000;

const _subfolders = (listing) => (listing?.entries || []).filter(entry => entry.folder);

/**
 * The PDFs of a recursive OUTPUT listing, grouped by the OUTPUT subfolder they sit in ('' for
 * OUTPUT itself, listed first). Deeper files keep their path below the group in their name.
 */
function _groupOutputPdfs(listing, outputPath) {
    const groups = new Map();
    for (const entry of listing?.entries || []) {
        if (entry.folder || !/\.pdf$/i.test(entry.name)) continue;
        const below = entry.path.slice(outputPath.length + 1).split('/');
        const group = below.length > 1 ? below[0] : '';
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push({ name: below.slice(group ? 1 : 0).join('/'), path: entry.path, size: entry.size, modified: entry.modified });
    }
    const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    return [...groups.entries()]
        .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : byName(a, b)))
        .map(([name, files]) => ({ name, files: files.sort((a, b) => byName(a.name, b.name)) }));
}

class dropboxUtils_uncached {
    /**
     * One Dropbox folder's listing (cached for LISTING_LIFETIME_MS). A folder that isn't there
     * lists as { entries: [], missing: true }.
     * @param {Object} deps
     * @param {string} path - '' (the company folder) or '/CLIENT/...'
     * @param {boolean} [recursive] - every file and folder below it
     * @returns {Promise<{ entries: Array<{ name, path, folder, size?, modified? }>, missing?: boolean }>}
     */
    static async listFolder(deps, path, recursive = false) {
        return await DropboxFiles.listFolder(path, { recursive });
    }

    /**
     * Start listing folders ahead of code that reads them (as Database.prefetch does for tabs): the
     * listings land in their own cache entries, and the first read joins the one running. Records no
     * dependency. NOT cached.
     * @param {string[]} paths
     */
    static prefetch(paths) {
        for (const path of new Set(paths || [])) {
            // A failure reaches the caller's own read of the folder
            DropboxUtils.listFolder(path).catch(() => {});
        }
    }

    /**
     * A show's project folders: CLIENT / YEAR / SHOW. The schedule row resolves through the Clients
     * and Shows index as its identifier does (resolveIdentifierParts); folder names resolve strictly
     * (resolveIndexName: the index name or an abbreviation, never a near name), so a client folder
     * named by an abbreviation matches and an unrelated folder never does. The year folder is named
     * exactly the year, and is read by its path. Usually one; a show filed under two client folders
     * gives both.
     * @returns {Promise<Array<{ client: string, year: string, show: string, path: string }>>}
     */
    static async findProjectFolders(deps, show, client, year) {
        const target = await deps.call(ProductionUtils.resolveIdentifierParts, show, client, year);
        if (!target?.year) return [];
        const named = async (folders, kind, wanted) => {
            const names = await Promise.all(folders.map(folder => deps.call(ProductionUtils.resolveIndexName, kind, folder.name)));
            return folders.filter((folder, i) => normalizeMatchKey(names[i]) === normalizeMatchKey(wanted));
        };

        const clientFolders = await named(_subfolders(await deps.call(DropboxUtils.listFolder, '')), 'client', target.client);
        const yearListings = await Promise.all(clientFolders.map(folder => deps.call(DropboxUtils.listFolder, `${folder.path}/${target.year}`)));
        const projects = [];
        for (let i = 0; i < clientFolders.length; i++) {
            for (const folder of await named(_subfolders(yearListings[i]), 'show', target.show)) {
                projects.push({ client: clientFolders[i].name, year: target.year, show: folder.name, path: folder.path });
            }
        }
        return projects;
    }

    /**
     * A show's output PDFs, per project folder, grouped by OUTPUT subfolder. Throws
     * DROPBOX_NOT_CONNECTED when the sign-in service has no Dropbox connected.
     * @returns {Promise<Array<{ client, year, show, path, groups: Array<{ name: string, files: Array<{ name, path, size, modified }> }> }>>}
     */
    static async getShowOutputFiles(deps, show, client, year) {
        const projects = await deps.call(DropboxUtils.findProjectFolders, show, client, year);
        const outputPaths = projects.map(project => `${project.path}/${OUTPUT_FOLDER}`);
        const outputs = await Promise.all(outputPaths.map(path => deps.call(DropboxUtils.listFolder, path, true)));
        return projects.map((project, i) => ({ ...project, groups: _groupOutputPdfs(outputs[i], outputPaths[i]) }));
    }

    /**
     * An address the browser shows one file at (DropboxFiles.getFileUrl). Never cached: each open
     * asks for a fresh link.
     * @param {string} path
     * @returns {Promise<string>}
     */
    static async getFileUrl(path) {
        return await DropboxFiles.getFileUrl(path);
    }
}

export const DropboxUtils = wrapMethods(
    dropboxUtils_uncached,
    'dropbox',
    ['getFileUrl', 'prefetch'], // Uncached: links expire; prefetch only starts reads
    [],
    { listFolder: LISTING_LIFETIME_MS }
);
