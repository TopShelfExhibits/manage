import { EditHistoryUtils, DEFAULT_INVENTORY_NOTE_MAX_LENGTH } from './metadata-utils.js';

/**
 * Inventory proposals: proposed inventory changes kept apart from real inventory until committed.
 * Plan: docs/notes/inventory-proposals-plan.md
 *
 * Stored one row per proposed item change in the CACHE tab below. Nothing else reads this tab and
 * it has no EditHistory column, so proposals never reach edit history, pending changes or reports.
 */

/** CACHE tab holding all proposals */
export const PROPOSALS_TAB_NAME = 'InventoryProposals';

/** Row object key → sheet header */
export const PROPOSAL_MAPPING = {
    proposal: 'Proposal',
    category: 'Category',
    itemNumber: 'ItemNumber',
    changes: 'Changes',
    updatedBy: 'UpdatedBy',
    updated: 'Updated',
    committedBy: 'CommittedBy',
    committed: 'Committed'
};

/** Inventory fields a proposal can change. Quantity is stored as a signed delta, others as the new value. */
export const PROPOSAL_FIELDS = ['quantity', 'description', 'notes'];

/** Lock namespace for editing a proposal (lock key: INVENTORY_PROPOSALS:<name>) */
export const PROPOSAL_LOCK_NAMESPACE = 'INVENTORY_PROPOSALS';

const PROPOSAL_NOTE_PREFIX = 'proposal: ';

const toNumber = (value) => {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
};
const formatDelta = (delta) => (delta > 0 ? `+${delta}` : String(delta));
const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const itemKey = (entry) => `${entry.category}\u0000${entry.itemNumber}`;
const newEntry = (proposal, category, itemNumber, changes, user, now) => ({
    proposal, category, itemNumber, changes: [...changes], updatedBy: user, updated: now, committedBy: '', committed: 0
});

export class ProposalUtils {
    /** URL segment for a proposal name: lowercase, non-alphanumerics as '-' */
    static slugify(name) {
        return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }

    /**
     * Longest proposal name: names fit the default commit note "proposal: <name>" within the
     * InventoryNoteMaxLength preference (25 → 15 characters).
     * @param {number} [noteMaxLength] - InventoryNoteMaxLength preference
     */
    static nameMaxLength(noteMaxLength = DEFAULT_INVENTORY_NOTE_MAX_LENGTH) {
        return Math.max(1, noteMaxLength - PROPOSAL_NOTE_PREFIX.length);
    }

    /**
     * Default commit note, e.g. "proposal: Spring buy"
     * @param {number} [noteMaxLength] - InventoryNoteMaxLength preference
     */
    static commitNote(name, noteMaxLength = DEFAULT_INVENTORY_NOTE_MAX_LENGTH) {
        return `${PROPOSAL_NOTE_PREFIX}${name}`.slice(0, noteMaxLength);
    }

    /** Signed text for a quantity change, e.g. "+8", "-2", "" for none */
    static formatQuantityChange(value) {
        const delta = toNumber(value);
        return delta === 0 ? '' : formatDelta(delta);
    }

    /**
     * Validate a name for a new proposal.
     * @param {string} name
     * @param {Array<string>} existingNames - Every proposal name, active and committed
     * @param {number} [noteMaxLength] - InventoryNoteMaxLength preference
     * @returns {string|null} Error message, or null when valid
     */
    static validateName(name, existingNames = [], noteMaxLength = DEFAULT_INVENTORY_NOTE_MAX_LENGTH) {
        const trimmed = String(name || '').trim();
        const maxLength = this.nameMaxLength(noteMaxLength);
        if (!trimmed) return 'Enter a proposal name';
        if (trimmed.length > maxLength) return `Use at most ${maxLength} characters`;
        const slug = this.slugify(trimmed);
        if (!slug) return 'Use at least one letter or number';
        if (existingNames.some(existing => this.slugify(existing) === slug)) return 'A proposal with this name already exists';
        return null;
    }

    /**
     * Parse sheet rows (PROPOSAL_MAPPING keys) into entries.
     * @returns {Array<{proposal, category, itemNumber, changes: Array<{n, ne}>, updatedBy, updated, committedBy, committed}>}
     */
    static parseRows(rows) {
        return (rows || [])
            .filter(row => row && row.proposal && row.category && row.itemNumber)
            .map(row => {
                let changes = [];
                try { changes = JSON.parse(row.changes || '[]'); } catch { /* unreadable row: no changes */ }
                return {
                    proposal: String(row.proposal),
                    category: String(row.category),
                    itemNumber: String(row.itemNumber),
                    changes: Array.isArray(changes) ? changes.filter(ch => ch && PROPOSAL_FIELDS.includes(ch.n)) : [],
                    updatedBy: row.updatedBy || '',
                    updated: Number(row.updated) || 0,
                    committedBy: row.committedBy || '',
                    committed: Number(row.committed) || 0
                };
            });
    }

    /** Entries back to sheet rows (PROPOSAL_MAPPING keys) */
    static toRows(entries) {
        return entries.map(entry => ({
            proposal: entry.proposal,
            category: entry.category,
            itemNumber: entry.itemNumber,
            changes: JSON.stringify(entry.changes),
            updatedBy: entry.updatedBy || '',
            updated: entry.updated ? String(entry.updated) : '',
            committedBy: entry.committedBy || '',
            committed: entry.committed ? String(entry.committed) : ''
        }));
    }

    /** Entries of one proposal (names match ignoring case) */
    static entriesOf(entries, name) {
        return (entries || []).filter(entry => sameName(entry.proposal, name));
    }

    /** A proposal is committed when it has rows and every one of them is committed */
    static isCommitted(proposalEntries) {
        return proposalEntries.length > 0 && proposalEntries.every(entry => entry.committed);
    }

    /**
     * Group entries into proposals: active first (most recently updated first), then committed.
     * @returns {Array<{name, slug, entries, categories, itemCount, updatedBy, updated, committed, committedBy}>}
     */
    static groupProposals(entries) {
        const byName = new Map();
        for (const entry of entries || []) {
            const key = entry.proposal.toLowerCase();
            if (!byName.has(key)) byName.set(key, { name: entry.proposal, slug: this.slugify(entry.proposal), entries: [] });
            byName.get(key).entries.push(entry);
        }
        return [...byName.values()]
            .map(proposal => {
                const newest = proposal.entries.reduce((a, b) => (b.updated > a.updated ? b : a));
                const lastCommit = this.isCommitted(proposal.entries)
                    ? proposal.entries.reduce((a, b) => (b.committed > a.committed ? b : a))
                    : null;
                return {
                    ...proposal,
                    categories: [...new Set(proposal.entries.map(entry => entry.category))],
                    itemCount: proposal.entries.length,
                    updatedBy: newest.updatedBy,
                    updated: newest.updated,
                    committed: lastCommit ? lastCommit.committed : 0,
                    committedBy: lastCommit ? lastCommit.committedBy : ''
                };
            })
            .sort((a, b) => (!!a.committed - !!b.committed)
                || (a.committed ? b.committed - a.committed : b.updated - a.updated));
    }

    /** Active (uncommitted) entries, optionally only those of one proposal */
    static activeEntries(entries, name = null) {
        return (name === null ? (entries || []) : this.entriesOf(entries, name)).filter(entry => !entry.committed);
    }

    /**
     * Proposal changes from a saved inventory row to an edited one.
     * @returns {Array<{n, ne}>} quantity as a signed delta ("+8"), other fields as the new value
     */
    static diffRow(savedRow, editedRow) {
        const changes = [];
        for (const field of PROPOSAL_FIELDS) {
            const before = savedRow?.[field] ?? '';
            const after = editedRow?.[field] ?? '';
            if (String(before) === String(after)) continue;
            if (field === 'quantity') {
                const delta = toNumber(after) - toNumber(before);
                if (delta !== 0) changes.push({ n: field, ne: formatDelta(delta) });
            } else {
                changes.push({ n: field, ne: String(after) });
            }
        }
        return changes;
    }

    /**
     * Merge item changes into a proposal. A listed field overwrites the item's previous change for
     * that field; other fields and other items are kept. Committed rows are never modified.
     * @param {Array} entries - All entries (every proposal)
     * @param {string} name - Proposal name (an existing proposal's stored casing wins)
     * @param {string} category - Inventory tab
     * @param {Array<{itemNumber, changes}>} updates
     * @param {string} user - Short user name
     * @param {number} now - Deciseconds since epoch
     * @returns {Array} New entries array
     */
    static mergeIntoProposal(entries, name, category, updates, user, now) {
        const result = entries.map(entry => ({ ...entry, changes: [...entry.changes] }));
        const storedName = this.entriesOf(result, name)[0]?.proposal || String(name).trim();
        const active = new Map(this.activeEntries(result, storedName).map(entry => [itemKey(entry), entry]));
        for (const { itemNumber, changes } of updates) {
            if (!changes?.length) continue;
            const existing = active.get(itemKey({ category, itemNumber }));
            if (existing) {
                const replaced = new Set(changes.map(ch => ch.n));
                existing.changes = [...existing.changes.filter(ch => !replaced.has(ch.n)), ...changes];
                existing.updatedBy = user;
                existing.updated = now;
            } else {
                result.push(newEntry(storedName, category, itemNumber, changes, user, now));
            }
        }
        return result;
    }

    /**
     * Replace a proposal's active entries with the changes in proposal page rows (save from the
     * proposal page). Rows without changes are dropped; an entry whose changes did not change keeps
     * its UpdatedBy/Updated. Other proposals and committed rows are kept.
     * @throws {Error} When the proposal is committed
     */
    static replaceActiveEntries(entries, name, rows, user, now) {
        const own = this.entriesOf(entries, name);
        if (this.isCommitted(own)) throw new Error(`Proposal "${name}" is committed and can no longer be edited`);
        const storedName = own[0]?.proposal || String(name).trim();
        const previous = new Map(this.activeEntries(own).map(entry => [itemKey(entry), entry]));
        const replacements = [];
        for (const row of rows || []) {
            const changes = this.changesFromTableRow(row);
            if (changes.length === 0) continue;
            const before = previous.get(itemKey(row));
            const entry = newEntry(storedName, row.category, row.itemNumber, changes, user, now);
            if (before && JSON.stringify(before.changes) === JSON.stringify(changes)) {
                entry.updatedBy = before.updatedBy;
                entry.updated = before.updated;
            }
            replacements.push(entry);
        }
        return [...entries.filter(entry => entry.committed || !sameName(entry.proposal, name)), ...replacements];
    }

    /** Mark a proposal's active rows in the given categories as committed */
    static markCommitted(entries, name, categories, user, now) {
        const committedTabs = new Set(categories);
        return entries.map(entry => (
            !entry.committed && committedTabs.has(entry.category) && sameName(entry.proposal, name)
                ? { ...entry, committedBy: user, committed: now }
                : entry
        ));
    }

    /**
     * Apply proposal changes to an inventory row (returns a new row). Only quantity is a delta;
     * text fields are set as-is, so a description like "-5 ft pole" is never read as a number.
     */
    static applyChanges(row, changes) {
        const next = { ...row };
        for (const ch of changes || []) {
            next[ch.n] = ch.n === 'quantity'
                ? EditHistoryUtils.applyNeValue(row?.quantity ?? '', ch.ne)
                : String(ch.ne ?? '');
        }
        return next;
    }

    /**
     * Proposal page row: the entry joined with the item's current inventory values.
     * Description and notes hold the proposed value (the current value when unchanged).
     */
    static toTableRow(entry, inventoryRow) {
        const change = (field) => entry.changes.find(ch => ch.n === field);
        const currentDescription = inventoryRow?.description ?? '';
        const currentNotes = inventoryRow?.notes ?? '';
        return {
            category: entry.category,
            itemNumber: entry.itemNumber,
            currentQuantity: inventoryRow?.quantity ?? '',
            quantityChange: String(toNumber(change('quantity')?.ne)),
            description: change('description') ? String(change('description').ne) : currentDescription,
            notes: change('notes') ? String(change('notes').ne) : currentNotes,
            currentDescription,
            currentNotes,
            edithistory: inventoryRow?.edithistory ?? '',
            missing: !inventoryRow
        };
    }

    /** Changes described by a proposal page row (inverse of toTableRow) */
    static changesFromTableRow(row) {
        const changes = [];
        const delta = toNumber(row.quantityChange);
        if (delta !== 0) changes.push({ n: 'quantity', ne: formatDelta(delta) });
        if (String(row.description ?? '') !== String(row.currentDescription ?? '')) {
            changes.push({ n: 'description', ne: String(row.description ?? '') });
        }
        if (String(row.notes ?? '') !== String(row.currentNotes ?? '')) {
            changes.push({ n: 'notes', ne: String(row.notes ?? '') });
        }
        return changes;
    }

    /**
     * Projected owned quantity on a date: current quantity, plus scheduled changes due by that
     * date, plus the proposal's change. Owned total, not availability (show usage not subtracted).
     * @param {Object} row - Proposal page row
     * @param {number} referenceDeciseconds - Projection date
     */
    static projectQuantity(row, referenceDeciseconds) {
        const { updatedItems } = EditHistoryUtils.applyPendingChangesToData(
            [{ quantity: row.currentQuantity, edithistory: row.edithistory }],
            referenceDeciseconds
        );
        return toNumber(updatedItems[0]?.quantity) + toNumber(row.quantityChange);
    }
}
