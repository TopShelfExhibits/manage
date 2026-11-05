/**
 * One-time admin migration: deduplicate the Drive thumbnails folder.
 * Never imported by the app. Delete this file once the migration is done.
 *
 * Run in the browser console on the live site while signed in:
 *
 *   const m = await import(new URL('js/data_management/migrations/dedup-thumbnails.js', document.baseURI));
 *   await m.dedupThumbnails();                    // dry run: report only
 *   await m.dedupThumbnails({ dryRun: false });   // write and delete
 *
 * Three phases (all skipped in a dry run):
 *
 *   Phase 1 — Reprocess originals
 *     Each _ORIGINAL backup was kept when its image exceeded the old upload cap. This phase
 *     re-uploads the original at the current MAX_UPLOAD_DIM limit, updates every cell that referenced the
 *     old thumbnail, and deletes both the stale thumbnail and the _ORIGINAL. If a current-quality
 *     file with the same source bytes already exists elsewhere in the folder, that file is reused
 *     instead of uploading again (cross-item dedup).
 *
 *   Phase 2 — Merge sha256 duplicates
 *     Files with the same sha256 appProperty were uploaded from the same source image. The largest
 *     file in each group is kept as canonical; all others are deleted and every cell referencing
 *     a deleted file is updated to the canonical. Files that were uploaded before sha256 tracking
 *     was added are downloaded, hashed by content, and deduplicated the same way; the survivor in
 *     each group has sha256 patched onto it so future uploads will deduplicate against it.
 *
 *   Phase 3 — Orphan cleanup
 *     Any Drive file in the folder that is not referenced by any Thumbnail cell (including
 *     _ORIGINAL files still remaining after Phase 1 errors) is deleted.
 *
 * Safeguards:
 *   - Remapped cells keep each image's note and crop (only the file ID changes).
 *   - A file named anywhere else is never deleted: edit history (EditHistory cells and the
 *     _EditHistory archives), pending inventory proposals, and autosave backups (UserData tabs)
 *     can still write it back to a cell. The report lists these as kept.
 *   - A live run refuses to start while an inventory table or the proposals table is locked for
 *     editing: saving those unsaved edits would write the old file IDs back.
 */

import { Database, ApplicationUtils, MAX_UPLOAD_DIM, ARCHIVE_TAB_NAME, PROPOSALS_TAB_NAME, PROPOSAL_LOCK_NAMESPACE, parseThumbnails, parseThumbnailEntries, serializeThumbnailEntries, normalizeHeaderName, isLocalhost } from '../index.js';
import { GoogleSheetsService } from '../../google_sheets_services/index.js';

const THUMBNAIL_HEADER = 'Thumbnail';

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {Promise<{dryRun, reprocess, merged, patched, orphans, errors}>}
 */
export async function dedupThumbnails({ dryRun = true } = {}) {
    if (isLocalhost()) throw new Error('dedupThumbnails must run on the live site (uses real Drive API)');
    const folderId = window.ENDPOINT_IDS?.THUMBNAILS;
    if (!folderId) throw new Error('window.ENDPOINT_IDS.THUMBNAILS is not set');

    console.log(`[dedupThumbnails] ${dryRun ? 'DRY RUN — nothing written or deleted' : 'LIVE RUN'}`);

    // Unsaved edits in an open table would save the old file IDs back over the remapped cells
    const locks = await _activeEditLocks();
    if (locks.length) {
        const list = locks.map(lock => `${lock.spreadsheet}/${lock.tab} (${lock.user})`).join(', ');
        if (!dryRun) throw new Error(`[dedupThumbnails] Tables are open for editing; save and close them first: ${list}`);
        console.warn(`[dedupThumbnails] A live run would refuse to start: tables open for editing: ${list}`);
    }

    console.log('[dedupThumbnails] Cataloging…');

    // ─── Catalog ─────────────────────────────────────────────────────────────
    // fileMap: id → { id, name, size (bytes), appProperties }
    const fileMap = await _listFolderFiles(folderId);
    console.log(`  ${fileMap.size} files in Drive folder`);

    const tabData = await _readAllThumbnailCells();
    // refs: fileId → [ {table, tab, rowNumber, columnNumber} ]
    const refs = _buildRefMap(tabData);
    console.log(`  ${refs.size} unique file IDs referenced in cells`);

    // Files named outside the current Thumbnail cells (history, proposals, backups): never deleted
    const held = _idsNamedIn(fileMap, [..._otherCellTexts(tabData), ...await _readOtherReferenceTexts()]);
    console.log(`  ${held.size} files named in history, proposals or autosave backups`);

    // Accumulated remaps (old fileId → final fileId) and deletions
    const remaps = new Map();
    const toDelete = new Set();

    const report = { dryRun, reprocess: [], merged: [], patched: [], orphans: [], kept: [], errors: [] };

    // ─── Phase 1: reprocess _ORIGINAL pairs ──────────────────────────────────
    await _phaseReprocessOriginals({ fileMap, refs, remaps, toDelete, folderId, dryRun, report });

    // ─── Phase 2: merge sha256 duplicates ────────────────────────────────────
    await _phaseMergeDuplicates({ fileMap, refs, remaps, toDelete, folderId, dryRun, report });

    // ─── Apply cell updates (batch after both phases) ─────────────────────────
    if (!dryRun && remaps.size) {
        await _applyRemaps(tabData, remaps);
    }

    // ─── Phase 3: orphan cleanup ──────────────────────────────────────────────
    await _phaseOrphanCleanup({ fileMap, refs, remaps, toDelete, held, dryRun, report });

    // Files history, proposals or backups still name stay (their cells are remapped all the same)
    for (const fileId of [...toDelete]) {
        if (!held.has(fileId)) continue;
        toDelete.delete(fileId);
        report.kept.push({ fileId, fileName: fileMap.get(fileId)?.name || '' });
    }

    // ─── Apply deletions ──────────────────────────────────────────────────────
    if (!dryRun && toDelete.size) {
        let deleted = 0;
        for (const fileId of toDelete) {
            if (await GoogleSheetsService.deleteDriveFile(fileId)) deleted++;
        }
        console.log(`[dedupThumbnails] Deleted ${deleted}/${toDelete.size} files`);
    }

    _printReport(report);
    return report;
}

// ─── Phases ───────────────────────────────────────────────────────────────────

async function _phaseReprocessOriginals({ fileMap, refs, remaps, toDelete, folderId, dryRun, report }) {
    console.log('[dedupThumbnails] Phase 1: reprocess _ORIGINAL pairs…');

    // Group files by their ITEM#_timestamp prefix
    const pairs = new Map(); // prefix → { itemNumber, resized?, original? }
    for (const file of fileMap.values()) {
        const parsed = _parseFileName(file.name);
        if (!parsed) continue;
        const key = `${parsed.itemNumber}_${parsed.timestamp}`;
        if (!pairs.has(key)) pairs.set(key, { itemNumber: parsed.itemNumber });
        if (parsed.isOriginal) pairs.get(key).original = file;
        else pairs.get(key).resized = file;
    }

    for (const [, pair] of pairs) {
        if (!pair.original) continue;

        if (!pair.resized) {
            // _ORIGINAL with no resized sibling: the upload failed at the time.
            // Leave it to Phase 3 (it's unreferenced, so it'll be an orphan).
            report.errors.push({ file: pair.original.name, reason: 'no resized pair (failed upload) — will be orphan-deleted in Phase 3' });
            continue;
        }

        // If the old resized file has no cell references, skip re-uploading.
        // Phase 3 will delete both as orphans.
        if (!(refs.get(pair.resized.id)?.length)) {
            report.errors.push({ file: pair.original.name, reason: 'resized pair is unreferenced — both will be orphan-deleted in Phase 3' });
            continue;
        }

        try {
            const originalBlob = await Database.getDriveFileBlob(pair.original.id);
            if (!originalBlob) throw new Error('could not download _ORIGINAL');

            const sha256 = await _sha256Hex(originalBlob);
            let newFileId = null;
            let reused = false;

            // Check for an existing current-quality file from the same source bytes,
            // but not the stale resized file itself (which we're about to delete).
            if (sha256) {
                const existing = await GoogleSheetsService.findDriveFileByAppProperty(folderId, 'sha256', sha256);
                if (existing?.id && existing.id !== pair.resized.id && !toDelete.has(existing.id)) {
                    newFileId = existing.id;
                    reused = true;
                }
            }

            if (!newFileId && !dryRun) {
                const ext = pair.original.name.split('.').pop().toLowerCase();
                const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
                const resizedBlob = await _resizeBlob(originalBlob, mimeType);
                const fileName = `${pair.itemNumber}_${Date.now()}.${ext}`;
                const uploaded = await GoogleSheetsService.uploadDriveFile(
                    new File([resizedBlob], fileName, { type: mimeType }),
                    fileName, folderId, sha256 ? { sha256 } : null
                );
                if (!uploaded?.id) throw new Error('upload returned no ID');
                newFileId = uploaded.id;
                // Register the new file so Phase 2 can see it
                fileMap.set(newFileId, {
                    id: newFileId, name: fileName,
                    size: resizedBlob.size,
                    appProperties: sha256 ? { sha256 } : {}
                });
            } else if (!newFileId) {
                newFileId = `(new-upload-for:${pair.resized.id})`;
            }

            remaps.set(pair.resized.id, newFileId);
            toDelete.add(pair.resized.id);
            toDelete.add(pair.original.id);

            report.reprocess.push({
                original: pair.original.name,
                resized: pair.resized.name,
                newFileId,
                reused,
                cellsUpdated: refs.get(pair.resized.id)?.length ?? 0
            });
        } catch (err) {
            report.errors.push({ file: pair.original.name, reason: String(err?.message || err) });
        }
    }

    console.log(`  ${report.reprocess.length} pairs reprocessed`);
}

async function _phaseMergeDuplicates({ fileMap, refs, remaps, toDelete, folderId, dryRun, report }) {
    console.log('[dedupThumbnails] Phase 2: merge sha256 duplicates…');

    const activeFiles = [...fileMap.values()].filter(f => !toDelete.has(f.id));

    // ── 2a: group files that already carry a sha256 appProperty ──────────────
    const bySha = new Map(); // sha256 → [file]
    const noSha = [];
    for (const f of activeFiles) {
        const sha = f.appProperties?.sha256;
        if (sha) {
            if (!bySha.has(sha)) bySha.set(sha, []);
            bySha.get(sha).push(f);
        } else {
            noSha.push(f);
        }
    }
    for (const [, group] of bySha) {
        if (group.length > 1) _mergeGroup(group, refs, remaps, toDelete, report);
    }

    // ── 2b: hash files without sha256, merge byte-identical ones ─────────────
    console.log(`  Hashing ${noSha.length} files without sha256 appProperty…`);
    const byContentHash = new Map(); // contentHash → [file]
    for (const f of noSha) {
        if (toDelete.has(f.id)) continue;
        try {
            const blob = await Database.getDriveFileBlob(f.id);
            if (!blob) continue;
            const hash = await _sha256Hex(blob);
            if (!hash) continue;
            f._contentHash = hash;
            if (!byContentHash.has(hash)) byContentHash.set(hash, []);
            byContentHash.get(hash).push(f);
        } catch (err) {
            report.errors.push({ file: f.name, reason: `hash failed: ${err?.message || err}` });
        }
    }
    for (const [, group] of byContentHash) {
        const active = group.filter(f => !toDelete.has(f.id));
        if (active.length > 1) _mergeGroup(active, refs, remaps, toDelete, report);
        // Patch sha256 onto the survivor so future uploads deduplicate against it
        const survivor = active.find(f => !toDelete.has(f.id));
        if (survivor?._contentHash) {
            if (!dryRun) {
                try {
                    await _patchAppProperty(survivor.id, 'sha256', survivor._contentHash);
                } catch (err) {
                    report.errors.push({ file: survivor.name, reason: `patch failed: ${err?.message || err}` });
                }
            }
            report.patched.push({ fileId: survivor.id, fileName: survivor.name });
        }
    }

    console.log(`  ${report.merged.length} files merged, ${report.patched.length} patched with sha256`);
}

async function _phaseOrphanCleanup({ fileMap, refs, remaps, toDelete, held, dryRun, report }) {
    console.log('[dedupThumbnails] Phase 3: orphan cleanup…');

    // Resolve every cell reference through all accumulated remaps → the live file ID set
    const live = new Set([...refs.keys()].map(id => _resolve(id, remaps)));

    for (const [fileId, file] of fileMap) {
        if (toDelete.has(fileId) || live.has(fileId)) continue;
        if (held.has(fileId)) {
            report.kept.push({ fileId, fileName: file.name });
        } else {
            report.orphans.push({ fileId, fileName: file.name });
            toDelete.add(fileId);
        }
    }

    console.log(`  ${report.orphans.length} orphans found`);
}

// ─── Cell updates ─────────────────────────────────────────────────────────────

/**
 * Apply accumulated remaps to every Thumbnail cell across all tabs, batched per tab. Only file IDs
 * change: each image keeps its note and crop (crops are fractions, so they fit a re-upload).
 * Calls Database.setCellValues which stamps the data change and invalidates caches.
 */
async function _applyRemaps(tabData, remaps) {
    for (const { table, tab, rows, thumbColIdx, thumbColNum } of tabData) {
        const cells = [];
        for (let i = 1; i < rows.length; i++) {
            const entries = parseThumbnailEntries(rows[i][thumbColIdx]);
            if (!entries.length) continue;
            const remapped = entries.map(entry => ({ ...entry, id: _resolve(entry.id, remaps) }));
            if (remapped.some((entry, j) => entry.id !== entries[j].id)) {
                cells.push({ rowNumber: i + 1, columnNumber: thumbColNum, value: serializeThumbnailEntries(remapped) });
            }
        }
        if (cells.length) {
            console.log(`  Updating ${cells.length} cell(s) in ${table}/${tab}`);
            await Database.setCellValues(table, tab, cells);
        }
    }
}

// ─── Drive helpers ────────────────────────────────────────────────────────────

/** Paginated listing of a Drive folder. Returns Map<id, {id, name, size, appProperties}>. */
async function _listFolderFiles(folderId) {
    const map = new Map();
    let pageToken = null;
    do {
        const response = await gapi.client.request({
            path: 'https://www.googleapis.com/drive/v3/files',
            method: 'GET',
            params: {
                q: `'${folderId}' in parents and trashed=false`,
                fields: 'files(id,name,size,appProperties), nextPageToken',
                pageSize: 100,
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
                ...(pageToken ? { pageToken } : {})
            }
        });
        for (const f of response.result?.files || []) {
            map.set(f.id, {
                id: f.id,
                name: f.name,
                size: parseInt(f.size || '0', 10),
                appProperties: f.appProperties || {}
            });
        }
        pageToken = response.result?.nextPageToken || null;
    } while (pageToken);
    return map;
}

/** PATCH a single appProperty onto a Drive file without disturbing the others. */
async function _patchAppProperty(fileId, key, value) {
    await gapi.client.request({
        path: `https://www.googleapis.com/drive/v3/files/${fileId}`,
        method: 'PATCH',
        params: { supportsAllDrives: true },
        body: JSON.stringify({ appProperties: { [key]: value } })
    });
}

// ─── Sheet helpers ────────────────────────────────────────────────────────────

/**
 * Read every Thumbnail cell from all inventory tabs and CACHE/Inventory.
 * @returns {Array<{table, tab, rows, thumbColIdx, thumbColNum}>}
 */
async function _readAllThumbnailCells() {
    const result = [];
    const invTabs = (await Database.getTabs('INVENTORY')).map(t => t.title).filter(t => !t.startsWith('_'));
    for (const tab of invTabs) {
        const rows = await Database.readFresh('INVENTORY', tab);
        const headers = (rows?.[0] || []).map(normalizeHeaderName);
        const idx = headers.indexOf(THUMBNAIL_HEADER);
        if (idx !== -1) result.push({ table: 'INVENTORY', tab, rows, thumbColIdx: idx, thumbColNum: idx + 1 });
    }
    try {
        const rows = await Database.readFresh('CACHE', 'Inventory');
        const headers = (rows?.[0] || []).map(normalizeHeaderName);
        const idx = headers.indexOf(THUMBNAIL_HEADER);
        if (idx !== -1) result.push({ table: 'CACHE', tab: 'Inventory', rows, thumbColIdx: idx, thumbColNum: idx + 1 });
    } catch { /* CACHE/Inventory absence is not an error */ }
    return result;
}

/** The other cells of the thumbnail tabs' rows (EditHistory records earlier thumbnail values). */
function _otherCellTexts(tabData) {
    return tabData.map(({ rows, thumbColIdx }) =>
        rows.map(row => (row || []).filter((_, c) => c !== thumbColIdx).join('\t')).join('\n'));
}

/**
 * Every other place a file ID can come back from: the _EditHistory archives (deleted rows), pending
 * inventory proposals, and autosave backups of unsaved edits (UserData tabs).
 * @returns {Promise<string[]>} the tabs' text
 */
async function _readOtherReferenceTexts() {
    const texts = [];
    const read = async (table, tab) => {
        const rows = await Database.readFresh(table, tab);
        texts.push((rows || []).map(row => (row || []).join('\t')).join('\n'));
    };
    const invTabs = (await Database.getTabs('INVENTORY')).map(t => t.title);
    if (invTabs.includes(ARCHIVE_TAB_NAME)) await read('INVENTORY', ARCHIVE_TAB_NAME);
    const cacheTabs = (await Database.getTabs('CACHE')).map(t => t.title);
    for (const tab of cacheTabs) {
        if (tab === ARCHIVE_TAB_NAME || tab === PROPOSALS_TAB_NAME || tab.startsWith('UserData_')) await read('CACHE', tab);
    }
    return texts;
}

/** The folder's file IDs that appear anywhere in the texts (IDs are tokens of 20+ ID characters). */
function _idsNamedIn(fileMap, texts) {
    const tokens = new Set();
    for (const text of texts) {
        for (const token of text.match(/[A-Za-z0-9_-]{20,}/g) || []) tokens.add(token);
    }
    return new Set([...fileMap.keys()].filter(id => tokens.has(id)));
}

/** Active locks on inventory tabs, CACHE/Inventory and the proposals table (open with edits). */
async function _activeEditLocks() {
    const { locks } = await ApplicationUtils.getLocksData();
    return (locks || []).filter(lock => {
        const active = lock.timestamp && lock.timestamp !== '0';
        const editsThumbnails = lock.spreadsheet === 'INVENTORY' || lock.spreadsheet === PROPOSAL_LOCK_NAMESPACE ||
            (lock.spreadsheet === 'CACHE' && lock.tab === 'Inventory');
        return active && editsThumbnails;
    });
}

/** Build fileId → [{table, tab, rowNumber, columnNumber}] reverse map. */
function _buildRefMap(tabData) {
    const map = new Map();
    for (const { table, tab, rows, thumbColIdx, thumbColNum } of tabData) {
        for (let i = 1; i < rows.length; i++) {
            for (const fileId of parseThumbnails(rows[i][thumbColIdx])) {
                if (!map.has(fileId)) map.set(fileId, []);
                map.get(fileId).push({ table, tab, rowNumber: i + 1, columnNumber: thumbColNum });
            }
        }
    }
    return map;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Largest by byte size wins; stable when equal (preserves input order). */
function _canonical(group) {
    return group.reduce((best, f) => f.size > best.size ? f : best);
}

/** Add all non-canonical files in a group to remaps and toDelete. */
function _mergeGroup(group, refs, remaps, toDelete, report) {
    const canon = _canonical(group);
    for (const f of group) {
        if (f.id === canon.id || toDelete.has(f.id)) continue;
        remaps.set(f.id, canon.id);
        toDelete.add(f.id);
        report.merged.push({
            canonical: canon.name,
            deleted: f.name,
            cellsUpdated: refs.get(f.id)?.length ?? 0
        });
    }
}

/**
 * Follow the remap chain to the final target, guarding against cycles.
 * @param {string} id
 * @param {Map<string,string>} remaps
 */
function _resolve(id, remaps) {
    let cur = id;
    const seen = new Set();
    while (remaps.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        cur = remaps.get(cur);
    }
    return cur;
}

/**
 * Parse a Drive thumbnail file name into its parts.
 * Expected formats: "ITEM#_timestamp.ext" and "ITEM#_timestamp_ORIGINAL.ext"
 * @returns {{ itemNumber: string, timestamp: string, isOriginal: boolean } | null}
 */
function _parseFileName(name) {
    const base = name.replace(/\.[^.]+$/, '');
    const isOriginal = base.endsWith('_ORIGINAL');
    const prefix = isOriginal ? base.slice(0, -'_ORIGINAL'.length) : base;
    const lastUnderscore = prefix.lastIndexOf('_');
    if (lastUnderscore === -1) return null;
    const timestamp = prefix.slice(lastUnderscore + 1);
    if (!/^\d{10,}$/.test(timestamp)) return null;
    return { itemNumber: prefix.slice(0, lastUnderscore), timestamp, isOriginal };
}

/** SHA-256 of a Blob's bytes as hex, or null if Web Crypto is unavailable. */
async function _sha256Hex(blob) {
    try {
        const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
        return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    } catch { return null; }
}

/** Resize a Blob to fit within MAX_UPLOAD_DIM, returning a (possibly identical) Blob. */
function _resizeBlob(blob, mimeType) {
    return new Promise(resolve => {
        const img = new Image();
        const url = URL.createObjectURL(blob);
        img.onload = () => {
            URL.revokeObjectURL(url);
            if (img.width <= MAX_UPLOAD_DIM && img.height <= MAX_UPLOAD_DIM) {
                resolve(blob);
                return;
            }
            const scale = Math.min(MAX_UPLOAD_DIM / img.width, MAX_UPLOAD_DIM / img.height);
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.width * scale));
            canvas.height = Math.max(1, Math.round(img.height * scale));
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(b => resolve(b ?? blob), mimeType, 0.92);
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(blob); };
        img.src = url;
    });
}

/** Print a summary to the console. */
function _printReport(report) {
    console.log(`\n[dedupThumbnails] ${report.dryRun ? 'DRY RUN results (no changes made)' : 'Migration complete'}`);
    console.table([
        { phase: 'Phase 1 — pairs reprocessed from _ORIGINAL', count: report.reprocess.length },
        { phase: 'Phase 2 — files merged (sha256 duplicates)',  count: report.merged.length },
        { phase: 'Phase 2 — old files patched with sha256',     count: report.patched.length },
        { phase: 'Phase 3 — orphans deleted',                   count: report.orphans.length },
        { phase: 'Kept — named in history, proposals or backups', count: report.kept.length },
        { phase: 'Errors',                                       count: report.errors.length }
    ]);
    if (report.reprocess.length) {
        console.log('Phase 1 — reprocessed:');
        console.table(report.reprocess);
    }
    if (report.merged.length) {
        console.log('Phase 2 — merged:');
        console.table(report.merged);
    }
    if (report.orphans.length) {
        console.log('Phase 3 — orphans:');
        console.table(report.orphans);
    }
    if (report.kept.length) {
        console.log('Kept (still named in history, proposals or backups):');
        console.table(report.kept);
    }
    if (report.errors.length) {
        console.warn('[dedupThumbnails] Errors:');
        console.table(report.errors);
    }
}
