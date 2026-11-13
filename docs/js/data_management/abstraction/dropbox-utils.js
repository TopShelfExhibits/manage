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
     * One Dropbox folder's listing (cached for LISTING_LIFETIME_MS).
     * @param {Object} deps
     * @param {string} path - '' (the company folder) or '/CLIENT/...'
     * @param {boolean} [recursive] - every file and folder below it
     * @returns {Promise<{ entries: Array<{ name, path, folder, size?, modified? }>, missing?: boolean }>}
     */
    static async listFolder(deps, path, recursive = false) {
        return await DropboxFiles.listFolder(path, { recursive });
    }

    /**
     * A show's project folders: CLIENT / YEAR / SHOW folders whose client and show names resolve,
     * through the Clients and Shows index (computeIdentifier), to the show's identifier. A client
     * folder named by an abbreviation matches. Usually one; a show filed under two client folders
     * gives both.
     * @returns {Promise<Array<{ client: string, year: string, show: string, path: string }>>}
     */
    static async findProjectFolders(deps, show, client, year) {
        const yearText = String(parseInt(year, 10) || '');
        const identifier = yearText ? await deps.call(ProductionUtils.computeIdentifier, show, client, yearText) : '';
        if (!identifier) return [];
        const target = normalizeMatchKey(identifier);
        const resolvesToShow = async (showName, clientName) =>
            normalizeMatchKey(await deps.call(ProductionUtils.computeIdentifier, showName, clientName, yearText)) === target;

        const clientFolders = [];
        for (const folder of _subfolders(await deps.call(DropboxUtils.listFolder, ''))) {
            if (await resolvesToShow(show, folder.name)) clientFolders.push(folder);
        }
        const clientListings = await Promise.all(clientFolders.map(folder => deps.call(DropboxUtils.listFolder, folder.path)));
        const yearFolders = clientListings.flatMap((listing, i) => _subfolders(listing)
            .filter(folder => folder.name.trim() === yearText)
            .map(folder => ({ client: clientFolders[i].name, path: folder.path })));
        const yearListings = await Promise.all(yearFolders.map(folder => deps.call(DropboxUtils.listFolder, folder.path)));

        const projects = [];
        for (let i = 0; i < yearFolders.length; i++) {
            for (const folder of _subfolders(yearListings[i])) {
                if (await resolvesToShow(folder.name, client)) {
                    projects.push({ client: yearFolders[i].client, year: yearText, show: folder.name, path: folder.path });
                }
            }
        }
        return projects;
    }

    /**
     * A show's output PDFs, per project folder, grouped by OUTPUT subfolder.
     * available is false when the app has no Dropbox (no sign-in service, or Dropbox not connected to it).
     * @returns {Promise<{ available: boolean, projects: Array<{ client, year, show, path, groups: Array<{ name: string, files: Array<{ name, path, size, modified }> }> }> }>}
     */
    static async getShowOutputFiles(deps, show, client, year) {
        if (!DropboxFiles.isAvailable()) return { available: false, projects: [] };
        let projects;
        try {
            projects = await deps.call(DropboxUtils.findProjectFolders, show, client, year);
        } catch (error) {
            if (error.code === 'DROPBOX_NOT_CONNECTED') return { available: false, projects: [] };
            throw error;
        }
        const outputPaths = projects.map(project => `${project.path}/${OUTPUT_FOLDER}`);
        const outputs = await Promise.all(outputPaths.map(path => deps.call(DropboxUtils.listFolder, path, true)));
        return {
            available: true,
            projects: projects.map((project, i) => ({ ...project, groups: _groupOutputPdfs(outputs[i], outputPaths[i]) }))
        };
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
    ['getFileUrl'], // Uncached: links expire
    [],
    { listFolder: LISTING_LIFETIME_MS }
);
