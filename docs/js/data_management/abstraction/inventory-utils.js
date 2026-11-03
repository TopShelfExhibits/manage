import { Database, ProductionUtils, PackListUtils, wrapMethods, parseDate, toISODateString, searchFilter, todayISOString, ApplicationUtils, invalidateCache, EditHistoryUtils, DEFAULT_INVENTORY_NOTE_MAX_LENGTH } from '../index.js';

/** Normalize an identifier for loose matching (strips spaces, case, non-alphanumeric) */
function _normalizeId(v) { return String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''); }

/** Parse a MetaData JSON string from the inventory INDEX into an object */
function _parseMetadata(str) {
    if (!str) return {};
    try { return JSON.parse(str); } catch { return {}; }
}

/** Fields reconstructed for the item timeline (contract: "Reconstructing past row states") */
const TIMELINE_FIELDS = ['itemNumber', 'quantity', 'description', 'notes'];

/**
 * Human-readable labels for one history entry, e.g. ['quantity: +2', 'description: "a" → "b"'].
 * @param {Object} entry - h entry
 * @param {Object} before - State before the entry
 * @param {Object} after - State after the entry
 * @returns {Array<string>}
 */
function _historyChangeLabels(entry, before, after) {
    return (Array.isArray(entry.c) ? entry.c : [])
        .filter(ch => ch?.n !== undefined)
        .map(ch => {
            if (ch.n === 'quantity') {
                const delta = (parseInt(after.quantity, 10) || 0) - (parseInt(before.quantity, 10) || 0);
                return `quantity: ${delta >= 0 ? '+' + delta : delta}`;
            }
            if (ch.n in after) {
                return `${ch.n}: "${before[ch.n] ?? ''}" → "${after[ch.n] ?? ''}"`;
            }
            return `${ch.n} changed`;
        });
}

/** Inventory tab row key → sheet header (the wrapped InventoryUtils does not expose static fields) */
export const DEFAULT_INVENTORY_MAPPING = {
    itemNumber: 'ITEM#',
    quantity: 'QTY',
    description: 'Description',
    notes: 'NOTES',
    edithistory: 'EditHistory'
};

/**
 * Utility functions for inventory operations
 */
class inventoryUtils_uncached {
    static DEFAULT_INVENTORY_MAPPING = DEFAULT_INVENTORY_MAPPING;

    static INDEX_MAPPING = {
        prefix: 'PREFIX',
        tab: 'INVENTORY',
        folder: 'FOLDER',
        metadata: 'MetaData'
    };

    /**
     * Fetch and parse the inventory INDEX with full metadata.
     * Returns an array of { prefix, tab, folder, metadata } where metadata is parsed JSON.
     */
    static async getInventoryIndex(deps) {
        const rows = await deps.call(Database.getData, 'CACHE', 'Inventory', inventoryUtils_uncached.INDEX_MAPPING);
        return rows.map(row => ({
            ...row,
            metadata: _parseMetadata(row.metadata)
        }));
    }

    static async getTabNameForItem(deps, itemName) {
        const indexData = await deps.call(InventoryUtils.getInventoryIndex);
        const prefixToTab = {};
        indexData.forEach(row => {
            if (row.prefix && row.tab) {
                prefixToTab[row.prefix] = row.tab;
            }
        });
        
        let [prefix] = itemName.split('-');
        let tab = prefixToTab[prefix];
        if (!tab && prefix?.length > 0) {
            prefix = prefix[0];
            tab = prefixToTab[prefix];
        }
        
        // If prefix lookup failed, check tabs listed in InventoryCustomItemNumbers preference
        if (!tab) {
            const prefs = await deps.call(Database.getData, 'CACHE', 'Preferences', { id: 'ID', value: 'Value' });
            const prefValue = prefs?.find(p => p.id === 'InventoryCustomItemNumbers')?.value || '[]';
            let customTabs = [];
            try { customTabs = JSON.parse(prefValue); } catch {}
            for (const customTab of customTabs) {
                try {
                    const tabData = await deps.call(Database.getData, 'INVENTORY', customTab, inventoryUtils_uncached.DEFAULT_INVENTORY_MAPPING);
                    if (tabData.find(item => item.itemNumber === itemName)) return customTab;
                } catch (error) {
                    console.error(`Error checking custom-item-number tab ${customTab}:`, error);
                }
            }
        }
        
        return tab || null;
    }

    static async getItemInfo(deps, itemName, fields, referenceDate) {
        const itemNames = Array.isArray(itemName) ? itemName : [itemName];
        const infoFields = Array.isArray(fields) ? fields : [fields];
        const itemsByTab = {};
        const unmappedItems = [];
        for (const item of itemNames) {
            if (!item) continue;
            const tab = await deps.call(InventoryUtils.getTabNameForItem, item);
            if (!tab) {
                unmappedItems.push(item);
                continue;
            }
            if (!itemsByTab[tab]) itemsByTab[tab] = [];
            itemsByTab[tab].push(item);
        };
        const refDeciseconds = referenceDate ? Math.floor(parseDate(referenceDate).getTime() / 100) : null;
        const results = [];
        for (const [tab, items] of Object.entries(itemsByTab)) {
            try {
                let tabData = await deps.call(Database.getData, 'INVENTORY', tab, inventoryUtils_uncached.DEFAULT_INVENTORY_MAPPING);
                if (refDeciseconds) {
                    const { updatedItems } = EditHistoryUtils.applyPendingChangesToData(tabData, refDeciseconds);
                    tabData = updatedItems;
                }
                items.forEach(item => {
                    const originalItem = item;
                    let foundObj = null;
                    if (item.includes('-')) {
                        const itemNumber = item.split('-')[1];
                        foundObj = tabData.find(obj => obj.itemNumber === itemNumber);
                        if (!foundObj) {
                            foundObj = tabData.find(obj => obj.itemNumber === originalItem);
                        }
                    } else {
                        foundObj = tabData.find(obj => obj.itemNumber === item);
                    }
                    const obj = { itemName: originalItem };
                    if (foundObj) {
                        infoFields.forEach(field => {
                            obj[field] = foundObj[field] ?? null;
                        });
                    } else {
                        infoFields.forEach(field => obj[field] = null);
                    }
                    results.push(obj);
                });
            } catch (error) {
                items.forEach(item => {
                    const obj = { itemName: item };
                    infoFields.forEach(field => obj[field] = null);
                    results.push(obj);
                });
            }
        }
        unmappedItems.forEach(item => {
            const obj = { itemName: item };
            infoFields.forEach(field => obj[field] = null);
            results.push(obj);
        });
        
        // if no items were found, throw an error instead of returning anything
        if (results.every(r => r[infoFields[0]] === null)) {
            return null;
        }
        return results;
    }

    static async getInventoryTabData(deps, tabOrItemName, mapping = inventoryUtils_uncached.DEFAULT_INVENTORY_MAPPING, filters = null, referenceDate) {

        // Get all tabs on the inventory sheet
        const allTabs = await deps.call(Database.getTabs, 'INVENTORY');

        // Check if the tab exists
        const tabExists = allTabs.some(tab => tab.title === tabOrItemName);
        let resolvedTabName = tabOrItemName;

        if (!tabExists) {
            const foundTab = await deps.call(InventoryUtils.getTabNameForItem, tabOrItemName);
            if (!foundTab) throw new Error(`Inventory tab for "${tabOrItemName}" not found and could not be resolved from INDEX.`);
            resolvedTabName = foundTab;
        }

        // Get tab data as JS objects (mapping transforms 2D array to objects)
        let tabData = await deps.call(Database.getData, 'INVENTORY', resolvedTabName, mapping);

        // If a referenceDate is provided, project the data to that date by applying
        // any pending changes due on or before that date (in-memory, no save).
        if (referenceDate) {
            const refDeciseconds = Math.floor(parseDate(referenceDate).getTime() / 100);
            const { updatedItems } = EditHistoryUtils.applyPendingChangesToData(tabData, refDeciseconds);
            tabData = updatedItems;
        }

        // Apply search filter if filters are provided (after transformation to objects)
        if (filters) {
            tabData = searchFilter(tabData, filters);
        }

        return tabData;
    }

    static async saveInventoryTabData(mappedData, tabOrItemName, mapping = inventoryUtils_uncached.DEFAULT_INVENTORY_MAPPING, filters = null, username = null, options = {}) {
        const { source = 'web', scheduledDate = null, noteMaxLength = DEFAULT_INVENTORY_NOTE_MAX_LENGTH } = options;
        // Notes are capped by the InventoryNoteMaxLength preference (resolved by the API layer)
        const note = String(options.note || '').slice(0, noteMaxLength);

        const allTabs = await Database.getTabs('INVENTORY');
        const tabExists = allTabs.some(tab => tab.title === tabOrItemName);
        let resolvedTabName = tabOrItemName;

        if (!tabExists) {
            const foundTab = await InventoryUtils.getTabNameForItem(tabOrItemName);
            if (!foundTab) throw new Error(`Inventory tab for "${tabOrItemName}" not found and could not be resolved from INDEX.`);
            resolvedTabName = foundTab;
        }
        
        // CRITICAL: Check lock status before saving to prevent conflicts
        const lockInfo = await ApplicationUtils.getSheetLock('INVENTORY', resolvedTabName, username);
        if (lockInfo && lockInfo.user !== username) {
            const errorMsg = `Cannot save: inventory category is locked by ${lockInfo.user}`;
            console.warn(`[InventoryUtils.saveInventoryTabData] ${errorMsg}`);
            throw new Error(errorMsg);
        }
        
        // Lock management is now handled by components via watchers on global locks store
        // Components acquire locks on edit mode entry and release on save completion

        // If a future scheduledDate is provided, store changes as pending instead of applying
        const todayISO = todayISOString();
        const effectiveDate = scheduledDate || todayISO;
        const isFuture = effectiveDate > todayISO;

        if (isFuture) {
            // Compute diff against existing data and create pending entries
            const existingData = await Database.getData('INVENTORY', resolvedTabName, mapping);
            const shortUser = username ? username.split('@')[0] : 'unknown';
            const effectiveDeciseconds = Math.floor(parseDate(effectiveDate).getTime() / 100);

            // For a new row (no match in existing data), build a bare version:
            // item number is saved immediately with all content fields zeroed/empty,
            // and any non-default content is added as a pending scheduled change.
            const buildBareRow = (item) => {
                const bare = {};
                for (const key of Object.keys(item)) {
                    if (['AppData', 'metadata'].includes(key)) continue;
                    if (key === 'itemNumber' || key === 'edithistory') {
                        bare[key] = item[key];
                    } else {
                        // Numeric fields → 0, string fields → ''
                        const num = parseFloat(item[key]);
                        bare[key] = (!isNaN(num) && String(item[key]).trim() !== '') ? 0 : '';
                    }
                }
                return bare;
            };

            const updatedRows = (Array.isArray(mappedData) ? mappedData : Array.from(mappedData)).map(item => {
                const existingItem = existingData.find(row => row.itemNumber === item.itemNumber);
                // Use existing row as base, or a bare new row for new items
                const baseItem = existingItem || buildBareRow(item);

                const changes = [];
                for (const key of Object.keys(item)) {
                    if (['edithistory', 'AppData', 'metadata'].includes(key)) continue;
                    if (String(item[key]) !== String(baseItem[key] ?? '')) {
                        const existingNum = parseFloat(baseItem[key]);
                        const newNum = parseFloat(item[key]);
                        const bothNumeric = !isNaN(existingNum) && !isNaN(newNum)
                            && String(baseItem[key]).trim() !== ''
                            && String(item[key]).trim() !== '';
                        let ne = item[key];
                        if (bothNumeric) {
                            const delta = newNum - existingNum;
                            ne = delta >= 0 ? `+${delta}` : `${delta}`;
                        }
                        changes.push({ n: key, ne });
                    }
                }

                if (changes.length === 0) return baseItem;

                const pendingEntry = EditHistoryUtils.createPendingEntry(shortUser, changes, effectiveDeciseconds, note, noteMaxLength);
                const updatedEH = EditHistoryUtils.appendToPendingChanges(baseItem.edithistory, pendingEntry);
                return { ...baseItem, edithistory: updatedEH };
            });

            return await Database.setData('INVENTORY', resolvedTabName, updatedRows, mapping, {
                username,
                source: note || 'scheduled',
                skipMetadata: true
            });
        }

        // Inventory history stores the save note in `s`; without a note `s` is omitted
        // (readers treat a missing `s` as 'web'). Non-web sources such as 'cad' are kept.
        const historySource = note || (source === 'web' ? null : source);

        let saveResult;
        try {
            if (filters) {
                // Fetch existing data from the tab
                const existingData = await Database.getData('INVENTORY', resolvedTabName, mapping);

                // Prepare batch updates
                const updates = mappedData.filter(item => {
                    const existingItem = existingData.find(row => row.itemNumber === item.itemNumber);
                    return existingItem && JSON.stringify(existingItem) !== JSON.stringify(item);
                });

                // Send updates one by one with username
                for (const update of updates) {
                    await Database.updateRow('INVENTORY', resolvedTabName, update, mapping, { username, source: historySource });
                }

                saveResult = true;
            } else {
                if (mappedData && typeof mappedData === 'object' && mappedData.__v_isReactive) {
                    mappedData = Array.from(mappedData);
                }

                // Save JS objects using mapping with edithistory options
                saveResult = await Database.setData('INVENTORY', resolvedTabName, mappedData, mapping, {
                    username,
                    source: historySource
                });
            }
        } finally {
            // Lock management is handled by components
            // No lock release needed here
        }

        return saveResult;
    }


    /**
     * Get inventory description for a specific item
     * @param {Object} deps - Dependency decorator for tracking calls
     * @param {string} itemNumber - The item number to look up
     * @returns {Promise<string|null>} Item description or null if not found
     */
    static async getItemDescription(deps, itemNumber, referenceDate) {
        if (!itemNumber) return null;
        
        try {
            const itemInfo = await deps.call(InventoryUtils.getItemInfo, itemNumber, ['description'], referenceDate);
            return itemInfo?.[0]?.description || null;
        } catch (error) {
            console.error(`Failed to get description for item ${itemNumber}:`, error);
            return null;
        }
    }



    /**
     * Returns inventory rows that have a pending entry matching the given
     * effective date (deciseconds). Used to populate the change history editor.
     * @param {Object} deps
     * @param {string} tabOrItemName
     * @param {number} effectiveDateDeciseconds
     * @param {Object} [mapping]
     * @returns {Promise<Array<Object>>}
     */
    static async getInventoryRowsForPendingEntry(deps, tabOrItemName, effectiveDateDeciseconds, mapping = inventoryUtils_uncached.DEFAULT_INVENTORY_MAPPING) {
        const allTabs = await deps.call(Database.getTabs, 'INVENTORY');
        const tabExists = allTabs.some(tab => tab.title === tabOrItemName);
        let resolvedTabName = tabOrItemName;
        if (!tabExists) {
            const foundTab = await deps.call(InventoryUtils.getTabNameForItem, tabOrItemName);
            if (!foundTab) throw new Error(`Inventory tab for "${tabOrItemName}" not found.`);
            resolvedTabName = foundTab;
        }
        const rows = await deps.call(Database.getData, 'INVENTORY', resolvedTabName, mapping);
        return rows.filter(row => {
            const pending = EditHistoryUtils.getPendingEntries(row.edithistory);
            return pending.some(e => e.t === effectiveDateDeciseconds);
        });
    }

    /**
     * Check and apply any pending changes due today or earlier for a given tab.
     * Mutation — uncached. Saves the tab once if any changes were applied.
     * @param {string} tabOrItemName
     * @param {string} [username]
     * @param {Object} [mapping]
     * @returns {Promise<{ applied: boolean }>}
     */
    static async checkAndApplyPendingChanges(tabOrItemName, username = null, mapping = inventoryUtils_uncached.DEFAULT_INVENTORY_MAPPING) {
        //console.log(`[InventoryUtils] Checking for pending changes to apply for "${tabOrItemName}"...`);
        
        const allTabs = await Database.getTabs('INVENTORY');
        const tabExists = allTabs.some(tab => tab.title === tabOrItemName);
        let resolvedTabName = tabOrItemName;
        if (!tabExists) {
            const foundTab = await InventoryUtils.getTabNameForItem(tabOrItemName);
            if (!foundTab) return { applied: false };
            resolvedTabName = foundTab;
        }

        const rows = await Database.getData('INVENTORY', resolvedTabName, mapping);
        const todayDeciseconds = Math.floor(new Date().setHours(0, 0, 0, 0) / 100);
        const { updatedItems, hasChanges } = EditHistoryUtils.applyPendingChangesToData(rows, todayDeciseconds);

        if (!hasChanges) return { applied: false };

        await Database.setData('INVENTORY', resolvedTabName, updatedItems, mapping, {
            username,
            skipMetadata: true
        });
        return { applied: true };
    }

    /**
     * Update the pending change entry matching effectiveDateDeciseconds on each
     * of the provided rows. Only the EditHistory column is written back.
     * Mutation — uncached.
     * @param {string} tabOrItemName
     * @param {Array<Object>} originalRows - Original rows before edits (current field values)
     * @param {Array<Object>} editedRows - Rows as edited in the modal (future field values)
     * @param {number} effectiveDateDeciseconds
     * @param {string} [note] - Updated note (truncated to noteMaxLength)
     * @param {string} [username]
     * @param {Object} [mapping]
     * @param {number} [noteMaxLength] - InventoryNoteMaxLength preference
     * @returns {Promise<boolean>}
     */
    static async savePendingChangeEntry(tabOrItemName, originalRows, editedRows, effectiveDateDeciseconds, note = null, username = null, mapping = inventoryUtils_uncached.DEFAULT_INVENTORY_MAPPING, noteMaxLength = DEFAULT_INVENTORY_NOTE_MAX_LENGTH) {
        //console.log(`[InventoryUtils] Saving pending change entry for "${tabOrItemName}"...`);
        
        const allTabs = await Database.getTabs('INVENTORY');
        const tabExists = allTabs.some(tab => tab.title === tabOrItemName);
        let resolvedTabName = tabOrItemName;
        if (!tabExists) {
            const foundTab = await InventoryUtils.getTabNameForItem(tabOrItemName);
            if (!foundTab) throw new Error(`Inventory tab for "${tabOrItemName}" not found.`);
            resolvedTabName = foundTab;
        }

        const updatedRows = originalRows.map(origRow => {
            const editedRow = editedRows.find(r => r.itemNumber === origRow.itemNumber);
            if (!editedRow) return origRow;

            const parsed = EditHistoryUtils.parseEditHistory(origRow.edithistory) || {};
            if (!Array.isArray(parsed.p)) return origRow;

            parsed.p = parsed.p.map(entry => {
                if (entry.t !== effectiveDateDeciseconds) return entry;
                // Rebuild c from diff between original and edited rows
                const newChanges = entry.c.map(ch => {
                    const editedVal = editedRow[ch.n];
                    return { n: ch.n, ne: editedVal !== undefined ? editedVal : ch.ne };
                });
                return {
                    ...entry,
                    c: newChanges,
                    s: note !== null ? String(note).slice(0, noteMaxLength) : entry.s
                };
            });

            return { ...origRow, edithistory: JSON.stringify(parsed) };
        });

        return await Database.setData('INVENTORY', resolvedTabName, updatedRows, mapping, {
            username,
            skipMetadata: true
        });
    }

    /**
     * Build a full item timeline for a given item within a date window.
     * Returns an array of events sorted chronologically:
     *   - Inventory changes (from edithistory.h) with event "Inv. Change"
     *   - Scheduled pending changes (from edithistory.p) with event "Scheduled"
     *   - Show ship events (event "Ships", note = project identifier)
     *   - Show return events (event "Returns", note = project identifier)
     *
     * Quantity column reflects the inventory state after each event.
     *
     * @param {Object} deps
     * @param {string} itemId - Item identifier (e.g. "F-101")
     * @param {string} startDate - ISO date string for window start (inclusive)
     * @param {string} endDate - ISO date string for window end (inclusive)
     * @returns {Promise<Array<{date: string, event: string, note: string, change: string, quantity: number|null}>>}
     */
    static async getItemTimeline(deps, itemId, startDate, endDate) {
        if (!itemId) return [];

        // Resolve tab and raw row
        const tab = await deps.call(InventoryUtils.getTabNameForItem, itemId);
        if (!tab) return [];

        const tabData = await deps.call(Database.getData, 'INVENTORY', tab, inventoryUtils_uncached.DEFAULT_INVENTORY_MAPPING);

        // Normalise item lookup (strip tab prefix if present)
        let lookupId = itemId;
        if (itemId.includes('-')) {
            const suffix = itemId.split('-')[1];
            const found = tabData.find(r => r.itemNumber === suffix) ? suffix : itemId;
            lookupId = found;
        }
        const row = tabData.find(r => r.itemNumber === lookupId) || tabData.find(r => r.itemNumber === itemId);
        if (!row) return [];

        const parsed = EditHistoryUtils.parseEditHistory(row.edithistory) || {};
        const history = Array.isArray(parsed.h) ? parsed.h : [];
        const pending = Array.isArray(parsed.p) ? parsed.p : [];
        // Past states, newest first (same reconstruction as the Edit History page):
        // states[k] is the state after history[k]; states[k + 1] is the state before it
        const states = EditHistoryUtils.getHistoryStates(row, TIMELINE_FIELDS);
        const qtyOf = (state) => parseInt(state?.quantity ?? 0, 10) || 0;

        const startParsed = startDate ? parseDate(startDate) : null;
        const endParsed   = endDate   ? parseDate(endDate)   : null;
        const startDs = startParsed ? Math.floor(startParsed.getTime() / 100) : null;
        const endDs   = endParsed   ? Math.floor(new Date(endParsed.getTime()).setHours(23, 59, 59, 999) / 100) : null;

        // All events carry internal _delta (relative) or _absoluteQty (anchor) for the forward pass.
        const events = [];

        // ── Phase 2: Inventory history entries ──
        // Opening balance: the quantity after the newest entry strictly BEFORE startDate.
        // Strict less-than keeps entries ON startDate inside the window (no double count).
        // If no entry precedes startDate, it is the oldest known quantity.
        let startQty = qtyOf(states[states.length - 1].state);
        const firstBeforeStart = startDs === null ? -1 : history.findIndex(entry => entry.t < startDs);
        if (firstBeforeStart !== -1) {
            startQty = qtyOf(states[firstBeforeStart].state);
        }

        history.forEach((entry, k) => {
            const ds = entry.t;
            const inWindow = (!startDs || ds >= startDs) && (!endDs || ds <= endDs);
            if (!inWindow) return;

            const after = states[k].state;
            const before = states[k + 1]?.state ?? after;
            const delta = qtyOf(after) - qtyOf(before);
            const isCreated = Array.isArray(entry.c) && entry.c.length === 0;
            const entryNote = EditHistoryUtils.entryNote(entry);
            events.push({
                date: toISODateString(new Date(ds * 100)),
                event: isCreated ? 'Created' : 'Inv. Change',
                note: entry.u ? (entryNote ? `${entry.u}: ${entryNote}` : entry.u) : entryNote,
                change: _historyChangeLabels(entry, before, after).join(', '),
                quantity: null,
                _delta: delta
            });
        });

        // NOTE: Balance row is pushed AFTER Phase 4 so pre-window ship adjustments are
        // captured in startQty before the anchor row is written.

        // ── Phase 3: Pending (scheduled) entries ──
        for (const entry of pending) {
            const ds = entry.t;
            const date = toISODateString(new Date(ds * 100));
            const inWindow = (!startDs || ds >= startDs) && (!endDs || ds <= endDs);
            if (!inWindow) continue;

            const changeLabels = [];
            let qtyDelta = 0;
            if (Array.isArray(entry.c)) {
                for (const ch of entry.c) {
                    const ne = ch.ne;
                    // Deltas already carry their sign ('+2', '-1'); absolute values are shown as-is
                    changeLabels.push(`${ch.n}: ${ne}`);
                    // Accumulate quantity delta so the forward pass stacks entries correctly.
                    // ne is always a delta string (e.g. '+2', '-1') for numeric fields.
                    if ((ch.n === 'quantity' || ch.n === 'QTY') && typeof ne === 'string' && /^[+\-]\d/.test(ne)) {
                        qtyDelta += parseFloat(ne);
                    }
                }
            }

            const scheduledNote = entry.u ? (entry.s ? `${entry.u}: ${entry.s}` : entry.u) : (entry.s || '');
            events.push({
                date,
                event: 'Scheduled',
                note: scheduledNote,
                change: changeLabels.join(', '),
                quantity: null,
                _delta: qtyDelta
            });
        }

        // ── Phase 4: Show ship / return events ──
        if (startDate || endDate) {
            try {
                // A show overlaps the window if it returns after startDate AND ships before endDate.
                // Omit either bound when the corresponding date is not provided (open-ended window).
                const overlapFilters = [];
                if (endDate)   overlapFilters.push({ column: 'Ship',   value: endDate,   type: 'before' });
                if (startDate) overlapFilters.push({ column: 'Return', value: startDate, type: 'after'  });
                const overlapping = await deps.call(ProductionUtils.getOverlappingShows, {
                    dateFilters: overlapFilters
                });

                // Deduplicate to prevent double-counting items when a show has multiple booths
                const deduplicated = await deps.call(ProductionUtils.deduplicateScheduleByShow, overlapping);

                for (const showRow of deduplicated) {
                    // Canonical schedule identifier — ScheduleOverrides stores canonical ids, not packlist tab titles
                    const scheduleId = await deps.call(ProductionUtils.getCanonicalIdentifierForScheduleRow, showRow);
                    if (!scheduleId) continue;

                    // Transship destinations are skipped — validated direction ensures only later shows are destinations
                    const transshipSource = await deps.call(ProductionUtils.getTransshipSourceForShow, scheduleId);
                    if (transshipSource) continue;

                    let packedQty = 0;
                    try {
                        // extractChainItemsForIdentifier handles NameOverride resolution internally
                        const chainItems = await deps.call(PackListUtils.extractChainItemsForIdentifier, scheduleId);
                        packedQty = chainItems[itemId] || 0;
                        if (!packedQty) continue;
                    } catch (_) {
                        continue;
                    }

                    const shipDate = await deps.call(ProductionUtils.getProjectShipDate, scheduleId);
                    const returnDate = await deps.call(ProductionUtils.getProjectReturnDate, scheduleId);

                    // Walk chain to find intermediate nodes and the final returning show
                    const chainIds = [scheduleId];
                    let walkCurrent = scheduleId;
                    const walkVisited = new Set([scheduleId.toLowerCase()]);
                    while (true) {
                        const next = await deps.call(ProductionUtils.getTransshipDestinationsForShow, walkCurrent);
                        if (!next || walkVisited.has(next.toLowerCase())) break;
                        walkVisited.add(next.toLowerCase());
                        chainIds.push(next);
                        walkCurrent = next;
                    }
                    const lastId = chainIds[chainIds.length - 1];

                    if (shipDate) {
                        const shipDs = Math.floor(parseDate(shipDate).getTime() / 100);
                        const shipInWindow = (!startDs || shipDs >= startDs) && (!endDs || shipDs <= endDs);
                        if (shipInWindow) {
                            events.push({ date: shipDate, event: 'Ships', note: scheduleId, change: `quantity: -${packedQty}`, quantity: null, _delta: -packedQty });
                        } else if (startDs && shipDs < startDs) {
                            startQty -= packedQty;
                        }
                    }

                    // Transship handoff events at each intermediate node's own return date (zero-delta)
                    for (let i = 0; i < chainIds.length - 1; i++) {
                        const nodeRow = await deps.call(ProductionUtils.getShowDetails, chainIds[i]);
                        const nodeRawReturn = await deps.call(ProductionUtils.getProjectReturnDateFromRow, nodeRow);
                        if (nodeRawReturn) {
                            const nodeRetDs = Math.floor(parseDate(nodeRawReturn).getTime() / 100);
                            if ((!startDs || nodeRetDs >= startDs) && (!endDs || nodeRetDs <= endDs)) {
                                events.push({ date: nodeRawReturn, event: 'Transship', note: chainIds[i + 1], change: '', quantity: null, _delta: 0 });
                            }
                        }
                    }

                    if (returnDate) {
                        const retDs = Math.floor(parseDate(returnDate).getTime() / 100);
                        const retInWindow = (!startDs || retDs >= startDs) && (!endDs || retDs <= endDs);
                        if (retInWindow) {
                            events.push({ date: returnDate, event: 'Returns', note: lastId, change: `quantity: +${packedQty}`, quantity: null, _delta: packedQty });
                        }
                    }
                }
            } catch (err) {
                console.error('[timeline] error in show events phase:', err);
            }
        }

        // Opening balance row — pushed after Phase 4 so pre-window ship adjustments are included.
        if (startDate) {
            events.push({ date: startDate, event: 'Balance', note: '', change: '', quantity: startQty, _done: true });
        }

        // ── Phase 5: Sort ──
        const eventOrder = { 'Balance': -1, 'Created': 0, 'Returns': 0, 'Inv. Change': 1, 'Scheduled': 2, 'Ships': 3 };
        events.sort((a, b) => {
            if (a.date !== b.date) return a.date < b.date ? -1 : 1;
            return (eventOrder[a.event] ?? 9) - (eventOrder[b.event] ?? 9);
        });

        // ── Phase 6: Forward pass — accumulate running quantity ──
        let fwdQty = startQty;
        for (const event of events) {
            if (event._done) {
                // Balance row: already has qty; reset accumulator
                fwdQty = event.quantity;
            } else {
                fwdQty += (event._delta ?? 0);
                event.quantity = fwdQty;
            }
            delete event._delta;
            delete event._done;
        }

        return events;
    }

    /**
     * Compute a per-item inventory report summary across a set of shows.
     * Returns start/end date range, inventory quantity, and the worst-case
     * (minimum) remaining quantity across all simultaneous show demand.
     *
     * Uses getItemTimeline via getItemMinQuantityInRange to properly account
     * for all inventory changes (historical and pending) combined with show demands.
     *
     * @param {Object} deps
     * @param {string} itemId - Item identifier (e.g. "F-101")
     * @param {Object} shows - Map of { showIdentifier: qty } for this item
     * @returns {Promise<{startDate: string|null, endDate: string|null, inventoryQty: number|null, minQty: number|null}>}
     */
    static async getItemReportSummary(deps, rowData) {
        const { itemId, shows } = rowData || {};
        if (!itemId || !shows || Object.keys(shows).length === 0) {
            return { startDate: null, endDate: null, inventoryQty: null, minQty: null };
        }

        const showIds = Object.keys(shows).filter(id => (shows[id] || 0) > 0);
        if (showIds.length === 0) {
            return { startDate: null, endDate: null, inventoryQty: null, minQty: null };
        }

        // Fetch ship and return dates for all shows
        const showDates = await Promise.all(
            showIds.map(async (showId) => {
                const [shipDate, returnDate] = await Promise.all([
                    deps.call(ProductionUtils.getProjectShipDate, showId).catch(() => null),
                    deps.call(ProductionUtils.getProjectReturnDate, showId).catch(() => null)
                ]);
                return { showId, qty: shows[showId] || 0, shipDate, returnDate };
            })
        );

        // Determine date range
        const shipDates = showDates.map(s => s.shipDate).filter(Boolean).sort();
        const returnDates = showDates.map(s => s.returnDate).filter(Boolean).sort();
        const startDate = shipDates[0] || null;
        const endDate = returnDates[returnDates.length - 1] || startDate;

        // Get inventory qty as of the earliest ship date
        const refDate = startDate || todayISOString();
        const inventoryQty = await deps.call(PackListUtils.getItemInventoryQuantity, itemId, refDate);

        if (inventoryQty === null) {
            return { startDate, endDate, inventoryQty: null, minQty: null };
        }

        // Use the timeline-backed minimum helper directly and do not post-process
        // quantities after loading.
        const minQty = await deps.call(InventoryUtils.getItemMinQuantityInRange, itemId, startDate, endDate);

        return { startDate, endDate, inventoryQty, minQty };
    }

    /**
     * Get the minimum inventory quantity for an item over a date range.
     * Delegates to getItemTimeline and returns the lowest quantity value seen.
     * @param {Object} deps
     * @param {string} itemId
     * @param {string|null} startDate - ISO date string (YYYY-MM-DD)
     * @param {string|null} endDate - ISO date string (YYYY-MM-DD)
     * @returns {Promise<number|null>} Minimum quantity in the range, or null if no data
     */
    static async getItemMinQuantityInRange(deps, itemId, startDate, endDate) {
        if (!itemId) return null;
        // getItemTimeline only includes show ship/return events when both dates are provided.
        // Use a 2-year fallback so the full demand window is always evaluated.
        let effectiveEnd = endDate;
        if (!effectiveEnd) {
            const d = new Date();
            d.setFullYear(d.getFullYear() + 2);
            effectiveEnd = toISODateString(d);
        }
        const events = await deps.call(InventoryUtils.getItemTimeline, itemId, startDate, effectiveEnd);
        const quantities = events.map(e => e.quantity).filter(q => q !== null && q !== undefined && !isNaN(q));
        const result = quantities.length > 0 ? Math.min(...quantities) : null;
        //console.log(`[minQty] ${itemId} [${startDate} → ${effectiveEnd}]: min=${result} (from ${quantities.length} qty points)`);
        return result;
    }

    /**
     * Remove a pending change entry by effectiveDateDeciseconds from matching rows
     * and save the updated EditHistory back. Mutation — uncached.
     * @param {string} tabOrItemName
     * @param {number} effectiveDateDeciseconds
     * @param {string} [username]
     * @param {Object} [mapping]
     * @returns {Promise<boolean>}
     */
    static async deletePendingChangeEntry(tabOrItemName, effectiveDateDeciseconds, username = null, mapping = inventoryUtils_uncached.DEFAULT_INVENTORY_MAPPING) {
        const allTabs = await Database.getTabs('INVENTORY');
        const tabExists = allTabs.some(tab => tab.title === tabOrItemName);
        let resolvedTabName = tabOrItemName;
        if (!tabExists) {
            const foundTab = await InventoryUtils.getTabNameForItem(tabOrItemName);
            if (!foundTab) throw new Error(`Inventory tab for "${tabOrItemName}" not found.`);
            resolvedTabName = foundTab;
        }

        const rows = await Database.getData('INVENTORY', resolvedTabName, mapping);
        const updatedRows = rows.map(row => {
            const parsed = EditHistoryUtils.parseEditHistory(row.edithistory);
            if (!parsed || !Array.isArray(parsed.p)) return row;
            const filtered = parsed.p.filter(e => e.t !== effectiveDateDeciseconds);
            if (filtered.length === parsed.p.length) return row;
            return { ...row, edithistory: JSON.stringify({ ...parsed, p: filtered }) };
        });

        return await Database.setData('INVENTORY', resolvedTabName, updatedRows, mapping, {
            username,
            skipMetadata: true
        });
    }

    /**
     * Get hidden search data (item numbers, descriptions, notes) for a category.
     * Used for card grid searching. Low-priority, optional analysis step.
     * @param {Object} deps - Dependencies object
     * @param {string} categoryTitle - Category/tab name (uppercase)
     * @returns {Promise<Array>} Array of { fieldName, value } objects
     */
    static async getHiddenSearchDataForCategory(deps, categoryTitle) {
        if (!categoryTitle) return [];
        
        try {
            // Fetch inventory data for this category
            const itemData = await deps.call(
                InventoryUtils.getInventoryTabData,
                categoryTitle,
                inventoryUtils_uncached.DEFAULT_INVENTORY_MAPPING
            );
            
            if (!Array.isArray(itemData) || itemData.length === 0) {
                return [];
            }
            
            // Extract searchable fields from all items
            const hiddenFields = [];
            const seenValues = new Set(); // Deduplicate identical values
            
            itemData.forEach(item => {
                // Add item number if present and unique
                if (item.itemNumber && !seenValues.has(`itemNumber:${item.itemNumber}`)) {
                    hiddenFields.push({ 
                        fieldName: 'Item#', 
                        value: item.itemNumber 
                    });
                    seenValues.add(`itemNumber:${item.itemNumber}`);
                }
                
                // Add description if present and unique
                if (item.description && !seenValues.has(`description:${item.description}`)) {
                    hiddenFields.push({ 
                        fieldName: 'Description', 
                        value: item.description 
                    });
                    seenValues.add(`description:${item.description}`);
                }
                
                // Add notes if present and unique
                if (item.notes && !seenValues.has(`notes:${item.notes}`)) {
                    hiddenFields.push({ 
                        fieldName: 'Notes', 
                        value: item.notes 
                    });
                    seenValues.add(`notes:${item.notes}`);
                }
            });
            
            return hiddenFields;
        } catch (error) {
            // Silently fail - this is low priority and optional
            console.warn(`[InventoryUtils] Failed to load hidden search data for ${categoryTitle}:`, error);
            return [];
        }
    }

}

export const InventoryUtils = wrapMethods(inventoryUtils_uncached, 'inventory_utils', [
    'saveInventoryTabData',
    'checkAndApplyPendingChanges',
    'savePendingChangeEntry',
    'deletePendingChangeEntry',
    'getHiddenSearchDataForCategory'
]);