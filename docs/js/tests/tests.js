/**
 * Console test suite — runs automatically on localhost against FakeGoogle test data.
 * Add new tests here when building features that depend on existing behavior.
 * Each test group covers a distinct layer of the stack; cross-group tests intentionally
 * exercise multiple layers together to catch integration regressions.
 *
 * FakeGoogle test data used here lives in google_sheets_services/FakeGoogle.js.
 * The transship test shows are:
 *   Two-show chain:   CHAINCO 2026 SPRING EXPO  →  CHAINCO 2026 SUMMER SHOW
 *   Three-show chain: TRICHAIN 2026 STAGE A  →  STAGE B  →  STAGE C
 *   Overlap show:     OVERLAPCO 2026 OVERLAP TEST  (overlaps SPRING EXPO's March window)
 *
 * FakeGoogle item quantities:
 *   SPRING EXPO:  TABLE-001=2, CHAIR-002=5
 *   SUMMER SHOW:  TABLE-001=3, CHAIR-002=4    → chain max: TABLE-001=3, CHAIR-002=5
 *   STAGE A:      STOOL-001=2, COUCH-001=1
 *   STAGE B:      STOOL-001=4, COUCH-001=2
 *   STAGE C:      STOOL-001=3, COUCH-001=1    → chain max: STOOL-001=4, COUCH-001=2
 *   OVERLAPCO:    TABLE-001=1
 *
 * Additional FakeGoogle fixtures used in Groups 17-20:
 *   ATSC 2025 NAB:                  CAB-004=11 (4+4+3 across crates 4/5/6)
 *   LOCKHEED MARTIN 2025 NGAUS:     TABLE-001=2 (two unquantified refs in primary tab)
 *   LOCKHEED MARTIN 2025 NGAUS MEETING ROOM:  TABLE-001=2
 *   AUSTAL 2026 SNA packlist tab  →  AUSTAL USA 2026 SURFACE NAVY schedule row (year 2026)
 *   AUSTAL 2023 WORKBOAT           (year 2023 — must NOT be matched by AUSTAL 2026 SNA)
 *   TEST CLIENT 2025 HIMSS packlist tab — client absent from index; falls back to raw name
 */

import { Requests } from '../data_management/api.js';
import { isAppOutdated, checkAppVersion } from '../data_management/index.js';
import { FakeGoogleSheetsAuth, FakeGoogleSheetsService, FakeGoogleState, setFakeDelaysEnabled } from '../google_sheets_services/FakeGoogle.js';
import { refreshAppData } from './fakeGoogleDevTools.js';
import { isCheckedValue } from '../data_management/utils/checkbox-values.js';
import { useBatchEdits, useInstantEdits } from '../application/utils/cellEdits.js';
import { CacheInvalidationBus, ApplicationUtils, ProductionUtils, triggerCachePoll, stampDataChange, Database, DEFAULT_INVENTORY_MAPPING, EditHistoryUtils, InventoryUtils, ProposalUtils, PROPOSAL_LOCK_NAMESPACE, resolveInventoryNoteMaxLength, readRowMetadata, writeRowMetadata, checkDateRollover, clearCache, invalidateCache, resolveSheetMapping, parseThumbnails, parseThumbnailEntries, serializeThumbnailEntries, addThumbnails, removeThumbnailAt, setPrimaryThumbnail, setThumbnailNote, setThumbnailCrop, primaryThumbnailValue, thumbnailKey } from '../data_management/index.js';
import { authState } from '../application/utils/auth.js';
import { commitInventoryProposal, saveToProposal, proposalTableStore, sendEditsToProposal } from '../application/utils/inventoryProposals.js';
import { hasQuantityChanges } from '../application/components/content/InventoryTable.js';
import { balancedSplit } from '../application/components/interface/buttonBar.js';
import { resolveView, resolveAction, pickView, mergeView, matchesKeyPattern, setViewWarningHandler, withRegistryDefaults, searchTiers } from '../application/utils/views/resolveView.js';
import { SEARCH_LIMITS, searchWords, matchRow, matchRows, makeHighlighter } from '../application/utils/views/searchMatch.js';
import { formatValue, formatText } from '../application/utils/views/fieldFormat.js';
import { rowsToCards, bucketRowsToCards } from '../application/utils/views/cardsAdapter.js';
import { applyColorRule, colorFor, rowColorFor } from '../application/utils/views/viewColor.js';
import { containerTier, viewportTier, BREAKPOINTS } from '../application/utils/useContainerSize.js';
import { todayISOString, setTestToday, startOfTodayMs, resolveShortageAlertDays, shortageAlertDateFilters, INVENTORY_TAB_PREFERENCES, resolveInventoryTabList, itemVariantBase, resolveItemVariant, itemVariantFamilies, itemVariantKey, parseItemVariants, searchFilter, textFiltersToSearchParams, parseSearchParameters } from '../data_management/utils/helpers.js';
import { instantWriteEntry, identityKey, cellKey, joinKey } from '../data_management/utils/instant-write-config.js';
import { estimateShipDate } from '../data_management/utils/ship-date.js';
import { parseA1Range, gridNeeded, clipRangeToGrid, isGridLimitError } from '../google_sheets_services/gridRanges.js';
import { SEVERITY, remainingSeverity } from '../data_management/utils/severity.js';
import { severityColor, statusColor } from '../application/utils/severity.js';
import { getAutoColorClass } from '../application/utils/autoColor.js';
import { getReactiveStore, createAnalysisConfig, itemVariantCards, itemShortageCards, NavigationRegistry, isMarkedForDeletion, paramToggleValue, isTemporaryAdmin } from '../application/index.js';
import { calculateStoreDiff, applyDiffToData } from '../application/utils/reactiveStores.js';
import { checkSheetHealth } from './sheetHealth.js';
import { guessColumnType, columnTypesEntry, columnTypeMap, columnTypeOf, isOpaqueType } from '../data_management/utils/column-types.js';
import { migrateThumbnails } from '../data_management/migrations/thumbnail-column.js';
import { buildScheduleFields } from '../data_management/abstraction/scheduleFields.js';
import { withShipDate } from '../application/utils/scheduleShipping.js';

// ── Runner ────────────────────────────────────────────────────────────────────

const _tests = [];

function test(group, name, fn) {
    _tests.push({ group, name, fn });
}

function assertEqual(actual, expected, label) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) throw new Error(`${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
}

function assertContains(arr, value, label) {
    if (!Array.isArray(arr) || !arr.includes(value))
        throw new Error(`${label}\n    expected array to contain: ${JSON.stringify(value)}\n    actual: ${JSON.stringify(arr)}`);
}

function assertNotContains(arr, value, label) {
    if (Array.isArray(arr) && arr.includes(value))
        throw new Error(`${label}\n    expected array NOT to contain: ${JSON.stringify(value)}\n    actual: ${JSON.stringify(arr)}`);
}

function assertFiniteNumber(val, label) {
    if (typeof val !== 'number' || !isFinite(val))
        throw new Error(`${label}\n    expected a finite number, got: ${JSON.stringify(val)}`);
}

function assertLessThan(val, threshold, label) {
    if (!(val < threshold))
        throw new Error(`${label}\n    expected ${val} < ${threshold}`);
}

// Run fn as a logged-in user. Tests otherwise run logged out, so saves record no history entries.
async function _asUser(fn) {
    const previous = authState.user;
    authState.user = { email: 'test@example.com' };
    try { return await fn(); } finally { authState.user = previous; }
}

// ── Group 0: Authentication ──────────────────────────────────────────────────
// Tests the full FakeGoogleSheetsAuth lifecycle. This group runs first and ends
// authenticated so all subsequent API-dependent groups have a valid session.
// The tests also confirm that the auth state machine transitions correctly and
// that silent refresh resets the token clock, which the real app relies on.

test('AUTH', 'checkAuth returns false before authenticate', async () => {
    await FakeGoogleSheetsAuth.logout();
    const result = await FakeGoogleSheetsAuth.checkAuth();
    assertEqual(result, false, 'checkAuth before authenticate');
});

test('AUTH', 'authenticate completes and returns true', async () => {
    const result = await FakeGoogleSheetsAuth.authenticate();
    assertEqual(result, true, 'authenticate() return value');
});

test('AUTH', 'checkAuth returns true after authenticate', async () => {
    const result = await FakeGoogleSheetsAuth.checkAuth();
    assertEqual(result, true, 'checkAuth after authenticate');
});

test('AUTH', 'getUserEmail returns the test account email', async () => {
    const email = await FakeGoogleSheetsAuth.getUserEmail();
    assertEqual(email, 'test@example.com', 'getUserEmail');
});

test('AUTH', 'token has time remaining after authenticate', async () => {
    const remaining = FakeGoogleSheetsAuth.getTokenSecondsRemaining();
    if (remaining <= 0) throw new Error(`expected > 0 seconds remaining, got ${remaining}`);
});

test('AUTH', 'silentRefresh returns true when authenticated', async () => {
    const result = await FakeGoogleSheetsAuth.silentRefresh();
    assertEqual(result, true, 'silentRefresh when authenticated');
});

test('AUTH', 'silentRefresh resets token to near-full time', async () => {
    // Let the token age slightly, then refresh and verify it was renewed
    await new Promise(r => setTimeout(r, 200));
    await FakeGoogleSheetsAuth.silentRefresh();
    const remaining = FakeGoogleSheetsAuth.getTokenSecondsRemaining();
    if (remaining < 3499) throw new Error(`expected ~3500s after silentRefresh, got ${remaining.toFixed(1)}s`);
});

test('AUTH', 'silentRefresh returns false when not authenticated', async () => {
    await FakeGoogleSheetsAuth.logout();
    const result = await FakeGoogleSheetsAuth.silentRefresh();
    assertEqual(result, false, 'silentRefresh when not authenticated');
    // Re-authenticate so subsequent test groups have a valid session
    await FakeGoogleSheetsAuth.authenticate();
});

// ── Group 1: Identifier Resolution ───────────────────────────────────────────
// computeIdentifier fuzzy-matches raw Show/Client/Year values against the Clients
// and Shows index tables. These tests confirm the canonical output used by all
// downstream identifier-keyed lookups (ScheduleOverrides, NameOverrides, etc.).

test('IDENTIFIER RESOLUTION', 'ChainCo/Spring Expo resolves to canonical form', async () => {
    const result = await Requests.computeIdentifier('Spring Expo', 'ChainCo', '2026');
    assertEqual(result, 'CHAINCO 2026 SPRING EXPO', 'computeIdentifier("Spring Expo", "ChainCo", "2026")');
});

test('IDENTIFIER RESOLUTION', 'ATSC/NAB resolves correctly', async () => {
    const result = await Requests.computeIdentifier('NAB', 'ATSC', '2025');
    assertEqual(result, 'ATSC 2025 NAB', 'computeIdentifier("NAB", "ATSC", "2025")');
});

test('IDENTIFIER RESOLUTION', 'Allen Arms/SHOT Show resolves correctly', async () => {
    const result = await Requests.computeIdentifier('SHOT Show', 'Allen Arms', '2025');
    assertEqual(result, 'ALLEN ARMS 2025 SHOT', 'computeIdentifier("SHOT Show", "Allen Arms", "2025")');
});

test('IDENTIFIER RESOLUTION', 'blank show name returns empty string', async () => {
    const result = await Requests.computeIdentifier('', 'ATSC', '2025');
    assertEqual(result, '', 'computeIdentifier("", "ATSC", "2025")');
});

// ── Group 2: Transship Chain Links ────────────────────────────────────────────
// getTransshipSourceForShow returns the source identifier for a destination show.
// getTransshipDestinationsForShow returns the destination for a source show.
// Both validate show ordering (source must precede destination by S.Start date)
// before returning; invalid or reversed links return null.

test('TRANSSHIP LINKS', 'destination show returns its source', async () => {
    const result = await Requests.getTransshipSourceForShow('CHAINCO 2026 SUMMER SHOW');
    assertEqual(result, 'CHAINCO 2026 SPRING EXPO', 'getTransshipSourceForShow(SUMMER SHOW)');
});

test('TRANSSHIP LINKS', 'source show has no source', async () => {
    const result = await Requests.getTransshipSourceForShow('CHAINCO 2026 SPRING EXPO');
    assertEqual(result, null, 'getTransshipSourceForShow(SPRING EXPO)');
});

test('TRANSSHIP LINKS', 'source show returns its destination', async () => {
    const result = await Requests.getTransshipDestinationsForShow('CHAINCO 2026 SPRING EXPO');
    assertEqual(result, 'CHAINCO 2026 SUMMER SHOW', 'getTransshipDestinationsForShow(SPRING EXPO)');
});

test('TRANSSHIP LINKS', 'destination show has no further destination', async () => {
    const result = await Requests.getTransshipDestinationsForShow('CHAINCO 2026 SUMMER SHOW');
    assertEqual(result, null, 'getTransshipDestinationsForShow(SUMMER SHOW)');
});

test('TRANSSHIP LINKS', 'three-show chain: middle node source is Stage A', async () => {
    const result = await Requests.getTransshipSourceForShow('TRICHAIN 2026 STAGE B');
    assertEqual(result, 'TRICHAIN 2026 STAGE A', 'getTransshipSourceForShow(STAGE B)');
});

test('TRANSSHIP LINKS', 'three-show chain: middle node destination is Stage C', async () => {
    const result = await Requests.getTransshipDestinationsForShow('TRICHAIN 2026 STAGE B');
    assertEqual(result, 'TRICHAIN 2026 STAGE C', 'getTransshipDestinationsForShow(STAGE B)');
});

test('TRANSSHIP LINKS', 'end of three-show chain has no destination', async () => {
    const result = await Requests.getTransshipDestinationsForShow('TRICHAIN 2026 STAGE C');
    assertEqual(result, null, 'getTransshipDestinationsForShow(STAGE C)');
});

test('TRANSSHIP LINKS', 'unlinked show returns null', async () => {
    const result = await Requests.getTransshipSourceForShow('ATSC 2025 NAB');
    assertEqual(result, null, 'getTransshipSourceForShow(ATSC 2025 NAB)');
});

// ── Group 3: Chain-Aware Ship and Returns ────────────────────────────────
// getProjectShipDate walks the ScheduleOverrides source chain and returns the
// earliest ship date (the chain root's date). getProjectReturnDate walks the
// destination chain and returns the latest return date (the last show's date).
// This ensures items are treated as unavailable for the full duration of
// all shows in the chain, not just the individual show.

test('CHAIN DATES', 'destination show uses source ship date', async () => {
    const result = await Requests.getProjectShipDate('CHAINCO 2026 SUMMER SHOW');
    assertEqual(result, '2026-03-01', 'getProjectShipDate(SUMMER SHOW) should resolve to SPRING EXPO ship date');
});

test('CHAIN DATES', 'source show returns own ship date', async () => {
    const result = await Requests.getProjectShipDate('CHAINCO 2026 SPRING EXPO');
    assertEqual(result, '2026-03-01', 'getProjectShipDate(SPRING EXPO)');
});

test('CHAIN DATES', 'source show return extends to destination return date', async () => {
    const result = await Requests.getProjectReturnDate('CHAINCO 2026 SPRING EXPO');
    assertEqual(result, '2026-06-18', 'getProjectReturnDate(SPRING EXPO) should resolve to SUMMER SHOW return date');
});

test('CHAIN DATES', 'destination show returns own return date', async () => {
    const result = await Requests.getProjectReturnDate('CHAINCO 2026 SUMMER SHOW');
    assertEqual(result, '2026-06-18', 'getProjectReturnDate(SUMMER SHOW)');
});

test('CHAIN DATES', 'three-show chain: end show ship date resolves to Stage A', async () => {
    const result = await Requests.getProjectShipDate('TRICHAIN 2026 STAGE C');
    assertEqual(result, '2026-04-01', 'getProjectShipDate(STAGE C) should resolve to STAGE A ship date');
});

test('CHAIN DATES', 'three-show chain: root show return extends to Stage C', async () => {
    const result = await Requests.getProjectReturnDate('TRICHAIN 2026 STAGE A');
    assertEqual(result, '2026-06-26', 'getProjectReturnDate(STAGE A) should resolve to STAGE C return date');
});

// ── Group 4: Item Timeline Structure for Chain Shows ─────────────────────────
// getItemTimeline should produce exactly one Ships event per chain (from the root),
// a Transship event at each intermediate node's own return date (zero-delta), and
// a Returns event at the last node's return date. The Ships/Returns quantity is the
// chain max (highest qty across all members), not the root's own quantity alone.
// Destination shows must NOT appear as independent Ships events.

test('TIMELINE STRUCTURE', 'TABLE-001 Ships event originates from chain root', async () => {
    const events = await Requests.getItemTimeline('TABLE-001', '2026-02-15', '2026-06-30');
    const ships = events.filter(e => e.event === 'Ships' && e.note === 'CHAINCO 2026 SPRING EXPO');
    if (ships.length !== 1) throw new Error(`expected exactly 1 Ships event for SPRING EXPO, got ${ships.length}`);
});

test('TIMELINE STRUCTURE', 'TABLE-001 Ships quantity equals chain max (3, not root-only 2)', async () => {
    const events = await Requests.getItemTimeline('TABLE-001', '2026-02-15', '2026-06-30');
    const ship = events.find(e => e.event === 'Ships' && e.note === 'CHAINCO 2026 SPRING EXPO');
    if (!ship) throw new Error('Ships event for SPRING EXPO not found');
    assertEqual(ship.change, 'quantity: -3', 'Ships change should reflect chain max TABLE-001=3');
});

test('TIMELINE STRUCTURE', 'TABLE-001 has Transship event pointing to SUMMER SHOW', async () => {
    const events = await Requests.getItemTimeline('TABLE-001', '2026-02-15', '2026-06-30');
    const transship = events.find(e => e.event === 'Transship' && e.note === 'CHAINCO 2026 SUMMER SHOW');
    if (!transship) throw new Error('Transship event pointing to SUMMER SHOW not found');
    assertEqual(transship.change, '', 'Transship event must not alter quantity');
});

test('TIMELINE STRUCTURE', 'TABLE-001 Returns event notes the last show in chain', async () => {
    const events = await Requests.getItemTimeline('TABLE-001', '2026-02-15', '2026-06-30');
    const ret = events.find(e => e.event === 'Returns' && e.note === 'CHAINCO 2026 SUMMER SHOW');
    if (!ret) throw new Error('Returns event for SUMMER SHOW not found');
    assertEqual(ret.change, 'quantity: +3', 'Returns change should reflect chain max TABLE-001=3');
});

test('TIMELINE STRUCTURE', 'SUMMER SHOW does not appear as an independent Ships event', async () => {
    const events = await Requests.getItemTimeline('TABLE-001', '2026-02-15', '2026-06-30');
    const badShip = events.find(e => e.event === 'Ships' && e.note === 'CHAINCO 2026 SUMMER SHOW');
    if (badShip) throw new Error('SUMMER SHOW should not have its own Ships event — it is a transship destination');
});

test('TIMELINE STRUCTURE', 'Transship event date precedes Returns date', async () => {
    const events = await Requests.getItemTimeline('TABLE-001', '2026-02-15', '2026-06-30');
    const transship = events.find(e => e.event === 'Transship' && e.note === 'CHAINCO 2026 SUMMER SHOW');
    const ret = events.find(e => e.event === 'Returns' && e.note === 'CHAINCO 2026 SUMMER SHOW');
    if (!transship || !ret) throw new Error('Transship or Returns event not found');
    if (transship.date >= ret.date) throw new Error(`Transship date (${transship.date}) must be before Returns date (${ret.date})`);
});

test('TIMELINE STRUCTURE', 'three-show chain: STOOL-001 Ships delta equals chain max (4)', async () => {
    const events = await Requests.getItemTimeline('STOOL-001', '2026-03-15', '2026-07-01');
    const ship = events.find(e => e.event === 'Ships' && e.note === 'TRICHAIN 2026 STAGE A');
    if (!ship) throw new Error('Ships event for STAGE A not found');
    assertEqual(ship.change, 'quantity: -4', 'Ships change should reflect chain max STOOL-001=4');
});

test('TIMELINE STRUCTURE', 'three-show chain: two Transship events in order A→B, B→C', async () => {
    const events = await Requests.getItemTimeline('STOOL-001', '2026-03-15', '2026-07-01');
    const toB = events.find(e => e.event === 'Transship' && e.note === 'TRICHAIN 2026 STAGE B');
    const toC = events.find(e => e.event === 'Transship' && e.note === 'TRICHAIN 2026 STAGE C');
    if (!toB) throw new Error('Transship event pointing to STAGE B not found');
    if (!toC) throw new Error('Transship event pointing to STAGE C not found');
    if (toB.date >= toC.date) throw new Error(`Stage A→B transship (${toB.date}) must precede Stage B→C (${toC.date})`);
});

// ── Group 5: Overlap Conflict Detection ──────────────────────────────────────
// getItemOverlappingPacklists returns shows that (a) overlap the current show's
// date window AND (b) use the specified item. Transship destination shows must be
// skipped — their demand is already represented by the chain root. The chain root's
// transship source must also be excluded (it is the current show's own supply chain,
// not a competing show). All identifiers in results must be canonical schedule ids.

test('OVERLAP DETECTION', 'OVERLAPCO conflict list includes SPRING EXPO (chain root)', async () => {
    const result = await Requests.getItemOverlappingPacklists('OVERLAPCO 2026 OVERLAP TEST', 'TABLE-001');
    assertContains(result, 'CHAINCO 2026 SPRING EXPO',
        'getItemOverlappingPacklists(OVERLAPCO, TABLE-001) should include SPRING EXPO');
});

test('OVERLAP DETECTION', 'OVERLAPCO conflict list does not include SUMMER SHOW (destination)', async () => {
    const result = await Requests.getItemOverlappingPacklists('OVERLAPCO 2026 OVERLAP TEST', 'TABLE-001');
    assertNotContains(result, 'CHAINCO 2026 SUMMER SHOW',
        'SUMMER SHOW is a transship destination and must not appear as a separate conflict');
});

test('OVERLAP DETECTION', 'SPRING EXPO conflict list includes OVERLAPCO', async () => {
    const result = await Requests.getItemOverlappingPacklists('CHAINCO 2026 SPRING EXPO', 'TABLE-001');
    assertContains(result, 'OVERLAPCO 2026 OVERLAP TEST',
        'getItemOverlappingPacklists(SPRING EXPO, TABLE-001) should include OVERLAPCO');
});

test('OVERLAP DETECTION', 'SUMMER SHOW conflict list excludes SPRING EXPO (own source)', async () => {
    // The transship source of SUMMER SHOW is SPRING EXPO; it must be excluded as competing demand
    const result = await Requests.getItemOverlappingPacklists('CHAINCO 2026 SUMMER SHOW', 'TABLE-001');
    assertNotContains(result, 'CHAINCO 2026 SPRING EXPO',
        'SPRING EXPO is SUMMER SHOWs transship source — not competing demand');
});

// ── Group 6: Remaining Quantity ───────────────────────────────────────────────
// calculateRemainingQuantity uses the timeline min-quantity pathway: it finds the
// worst-case available quantity across [referenceDate, chainReturnDate]. The chain
// always accounts for all members (ship date = earliest, return = latest, qty = max).
// SPRING EXPO's chain needs 3 TABLE-001 but inventory only has 2, so remaining < 2.

test('REMAINING QUANTITY', 'returns a finite number for a chain root show', async () => {
    const result = await Requests.calculateRemainingQuantity('CHAINCO 2026 SPRING EXPO', 'TABLE-001', '2026-03-01');
    assertFiniteNumber(result, 'calculateRemainingQuantity(SPRING EXPO, TABLE-001)');
});

test('REMAINING QUANTITY', 'chain show over-demand produces negative remaining', async () => {
    // Inventory has 2 TABLE-001; chain needs 3 → worst-case remaining must be < 2
    const result = await Requests.calculateRemainingQuantity('CHAINCO 2026 SPRING EXPO', 'TABLE-001', '2026-03-01');
    assertLessThan(result, 2, 'remaining TABLE-001 for SPRING EXPO chain should be < 2 (needs 3, has 2)');
});

test('REMAINING QUANTITY', 'returns a finite number for an unlinked show', async () => {
    const result = await Requests.calculateRemainingQuantity('ATSC 2025 NAB', 'TABLE-001', '2026-01-10');
    assertFiniteNumber(result, 'calculateRemainingQuantity(ATSC 2025 NAB, TABLE-001)');
});

// ── Group 7: Inventory Data Integrity ────────────────────────────────────────
// Basic sanity checks that the inventory layer is intact and returns the correct
// quantities from FakeGoogle. These catch regressions in unrelated refactors that
// accidentally alter the inventory data path.

test('INVENTORY DATA', 'TABLE-001 quantity is 2', async () => {
    const rows = await Requests.getInventoryInfo('TABLE-001', ['quantity']);
    const row = rows?.find(r => r.itemName === 'TABLE-001');
    if (!row) throw new Error('TABLE-001 not found in inventory');
    assertEqual(row.quantity, '2', 'TABLE-001 quantity');
});

test('INVENTORY DATA', 'STOOL-001 quantity is 12', async () => {
    const rows = await Requests.getInventoryInfo('STOOL-001', ['quantity']);
    const row = rows?.find(r => r.itemName === 'STOOL-001');
    if (!row) throw new Error('STOOL-001 not found in inventory');
    assertEqual(row.quantity, '12', 'STOOL-001 quantity');
});

test('INVENTORY DATA', 'CHAIR-002 quantity is 15', async () => {
    const rows = await Requests.getInventoryInfo('CHAIR-002', ['quantity']);
    const row = rows?.find(r => r.itemName === 'CHAIR-002');
    if (!row) throw new Error('CHAIR-002 not found in inventory');
    assertEqual(row.quantity, '15', 'CHAIR-002 quantity');
});

test('INVENTORY DATA', 'COUCH-001 quantity is 2', async () => {
    const rows = await Requests.getInventoryInfo('COUCH-001', ['quantity']);
    const row = rows?.find(r => r.itemName === 'COUCH-001');
    if (!row) throw new Error('COUCH-001 not found in inventory');
    assertEqual(row.quantity, '2', 'COUCH-001 quantity');
});

// ── Group 8: Multi-Booth Override Linking ────────────────────────────────────
// When a schedule row has two associated packlist tabs — one matched naturally by name
// and one linked via NameOverride — both tabs must be included. Quantities from all
// tabs for the same show are SUMMED (not maxed), because both booths are active
// simultaneously and their items come from the same warehouse stock.
//
// FakeGoogle data: MULTIBOOTHCO 2026 MULTI BOOTH
//   Primary tab (natural match):      CHAIR-001=5
//   Secondary tab (NameOverride):     CHAIR-001=2, STOOL-002=4
//   Expected combined:                CHAIR-001=7 (5+2), STOOL-002=4

test('MULTI BOOTH', 'items from both tabs are summed in the timeline Ships event', async () => {
    // If both tabs are included, CHAIR-001 Ships change = 'quantity: -7' (5+2)
    const events = await Requests.getItemTimeline('CHAIR-001', '2026-10-01', '2026-11-01');
    const ship = events.find(e => e.event === 'Ships' && e.note === 'MULTIBOOTHCO 2026 MULTI BOOTH');
    if (!ship) throw new Error('Ships event for MULTIBOOTHCO not found');
    assertEqual(ship.change, 'quantity: -7', 'Ships change should sum both tabs: primary(5) + secondary(2) = 7');
});

test('MULTI BOOTH', 'item from override-only tab appears in the timeline', async () => {
    // STOOL-002 exists only in the NameOverride-linked secondary tab
    const events = await Requests.getItemTimeline('STOOL-002', '2026-10-01', '2026-11-01');
    const ship = events.find(e => e.event === 'Ships' && e.note === 'MULTIBOOTHCO 2026 MULTI BOOTH');
    if (!ship) throw new Error('Ships event for MULTIBOOTHCO not found for STOOL-002 — secondary tab was not included');
    assertEqual(ship.change, 'quantity: -4', 'Ships change should be -4 (from secondary tab only)');
});

test('MULTI BOOTH', 'override-linked tab does not displace the natural-match tab', async () => {
    // After adding the override, the natural-match tab MUST still be present.
    // If findPacklistTabsForScheduleRow incorrectly early-returned on the override, CHAIR-001 would be -2 not -7.
    const events = await Requests.getItemTimeline('CHAIR-001', '2026-10-01', '2026-11-01');
    const ship = events.find(e => e.event === 'Ships' && e.note === 'MULTIBOOTHCO 2026 MULTI BOOTH');
    if (!ship) throw new Error('Ships event for MULTIBOOTHCO not found');
    if (ship.change === 'quantity: -2') throw new Error(
        'Ships change is -2 — override replaced the natural tab instead of adding to it. Both tabs must be included.'
    );
});

// ── Group 9: Packlist Text Extraction ────────────────────────────────────────
// extractItemNumber / extractQuantity parse the "(qty) ITEM-NUM description" format
// used in packlist cells. These are the foundation of the full extraction pipeline;
// a regression here silently corrupts all downstream timeline and quantity results.

test('PACKLIST EXTRACTION', 'item number extracted from formatted text', async () => {
    const result = await Requests.extractItemNumber('(3) TABLE-001 conference table');
    assertEqual(result, 'TABLE-001', 'extractItemNumber("(3) TABLE-001 conference table")');
});

test('PACKLIST EXTRACTION', 'quantity extracted from formatted text', async () => {
    const result = await Requests.extractQuantity('(3) TABLE-001 conference table');
    assertEqual(result, 3, 'extractQuantity("(3) TABLE-001 conference table")');
});

test('PACKLIST EXTRACTION', 'text with no item code returns null item number', async () => {
    const result = await Requests.extractItemNumber('no item code in this text');
    assertEqual(result, null, 'extractItemNumber with no recognizable item code');
});

test('PACKLIST EXTRACTION', 'item without qty prefix defaults to quantity 1', async () => {
    const result = await Requests.extractQuantity('TABLE-001 conference table');
    assertEqual(result, 1, 'extractQuantity without qty prefix defaults to 1');
});

// ── Group 9: Packlist Structure ───────────────────────────────────────────────
// getPackList returns an array of crate objects each containing an Items array.
// The crate structure is consumed by every downstream item-extraction function.
// FakeGoogle CHAINCO 2026 SPRING EXPO has 1 crate with 2 item rows.

test('PACKLIST STRUCTURE', 'SPRING EXPO returns non-empty array', async () => {
    const result = await Requests.getPackList('CHAINCO 2026 SPRING EXPO');
    if (!Array.isArray(result) || result.length === 0)
        throw new Error(`expected non-empty array, got ${JSON.stringify(result)}`);
});

test('PACKLIST STRUCTURE', 'each crate has an Items array', async () => {
    const result = await Requests.getPackList('CHAINCO 2026 SPRING EXPO');
    const allHaveItems = Array.isArray(result) && result.every(crate => Array.isArray(crate.Items));
    if (!allHaveItems) throw new Error('one or more crates missing Items array');
});

test('PACKLIST STRUCTURE', 'SPRING EXPO has 2 item rows total', async () => {
    const result = await Requests.getPackList('CHAINCO 2026 SPRING EXPO');
    const totalItems = (result || []).reduce((n, c) => n + c.Items.length, 0);
    assertEqual(totalItems, 2, 'CHAINCO SPRING EXPO total item rows');
});

test('PACKLIST STRUCTURE', 'nonexistent packlist returns null', async () => {
    const result = await Requests.getPackList('NONEXISTENT SHOW 9999 FAKE');
    assertEqual(result, null, 'getPackList for unknown identifier');
});

// ── Group 10: Inventory Routing ───────────────────────────────────────────────
// getTabNameForItem maps item numbers to their inventory tab via the INDEX prefix table.
// A regression here silently breaks getInventoryInfo, getItemTimeline, and calculateRemainingQuantity.
// FakeGoogle index: TABLE/CHAIR/STOOL/COUCH → FURNITURE, CAB → CABINETS.

test('INVENTORY ROUTING', 'TABLE-001 resolves to FURNITURE tab', async () => {
    const result = await Requests.getTabNameForItem('TABLE-001');
    assertEqual(result, 'FURNITURE', 'getTabNameForItem("TABLE-001")');
});

test('INVENTORY ROUTING', 'CHAIR-002 resolves to FURNITURE tab', async () => {
    const result = await Requests.getTabNameForItem('CHAIR-002');
    assertEqual(result, 'FURNITURE', 'getTabNameForItem("CHAIR-002")');
});

test('INVENTORY ROUTING', 'CAB-004 resolves to CABINETS tab', async () => {
    const result = await Requests.getTabNameForItem('CAB-004');
    assertEqual(result, 'CABINETS', 'getTabNameForItem("CAB-004")');
});

test('INVENTORY ROUTING', 'unknown item returns null', async () => {
    const result = await Requests.getTabNameForItem('NONEXISTENT-999');
    assertEqual(result, null, 'getTabNameForItem for unknown prefix');
});

// ── Group 11: Schedule Attachment ─────────────────────────────────────────────
// getShowDetails (packlist id → schedule row) is the reverse direction of computeIdentifier.
// Both code paths are independent and have historically diverged. checkPacklistExists
// uses the same path and gates the "Create Packlist" button in the UI.

test('SCHEDULE ATTACHMENT', 'getShowDetails returns row for known identifier', async () => {
    const result = await Requests.getShowDetails('CHAINCO 2026 SPRING EXPO');
    if (!result) throw new Error('expected non-null show details for CHAINCO 2026 SPRING EXPO');
    if (!result.Show) throw new Error('expected Show field in result');
});

test('SCHEDULE ATTACHMENT', 'getShowDetails returns null for unknown identifier', async () => {
    const result = await Requests.getShowDetails('NONEXISTENT 9999 FAKE SHOW');
    assertEqual(result, null, 'getShowDetails for unknown identifier');
});

test('SCHEDULE ATTACHMENT', 'checkPacklistExists returns true for SPRING EXPO', async () => {
    const row = { Show: 'Spring Expo', Client: 'ChainCo', Year: '2026', Identifier: 'CHAINCO 2026 SPRING EXPO' };
    const result = await Requests.checkPacklistExists(row);
    assertEqual(result.exists, true, 'checkPacklistExists(SPRING EXPO).exists');
});

test('SCHEDULE ATTACHMENT', 'checkPacklistExists identifier matches packlist tab title', async () => {
    const row = { Show: 'Spring Expo', Client: 'ChainCo', Year: '2026', Identifier: 'CHAINCO 2026 SPRING EXPO' };
    const result = await Requests.checkPacklistExists(row);
    assertEqual(result.identifier, 'CHAINCO 2026 SPRING EXPO', 'checkPacklistExists identifier field');
});

test('SCHEDULE ATTACHMENT', 'checkPacklistExists returns false for show with no packlist', async () => {
    // Allen Arms SHOT has a schedule row but no packlist tab in FakeGoogle
    const row = { Show: 'SHOT Show', Client: 'Allen Arms', Year: '2025', Identifier: 'ALLEN ARMS 2025 SHOT' };
    const result = await Requests.checkPacklistExists(row);
    assertEqual(result.exists, false, 'checkPacklistExists(ALLEN ARMS 2025 SHOT).exists');
});

// ── Group 12: Item Min Quantity In Range ──────────────────────────────────────
// getItemMinQuantityInRange is the building block beneath calculateRemainingQuantity.
// Testing this layer separately ensures that a regression in the intermediate step
// shows up even if the top-level wrapper happens to produce the same wrong result.
// FakeGoogle: TABLE-001 inventory qty=2; SPRING EXPO chain needs 3 (min dips below 2).

test('ITEM MIN QUANTITY', 'TABLE-001 min during chain window is a finite number', async () => {
    const result = await Requests.getItemMinQuantityInRange('TABLE-001', '2026-03-01', '2026-06-18');
    assertFiniteNumber(result, 'getItemMinQuantityInRange(TABLE-001, chain window)');
});

test('ITEM MIN QUANTITY', 'TABLE-001 min during chain window drops below inventory quantity', async () => {
    // Chain needs 3 TABLE-001, inventory has 2 — min must be < 2
    const result = await Requests.getItemMinQuantityInRange('TABLE-001', '2026-03-01', '2026-06-18');
    assertLessThan(result, 2, 'TABLE-001 chain window min should be < 2');
});

test('ITEM MIN QUANTITY', 'TABLE-001 min in empty 2024 window equals inventory quantity', async () => {
    // No shows use TABLE-001 in 2024, so quantity stays at the raw inventory value
    const result = await Requests.getItemMinQuantityInRange('TABLE-001', '2024-01-01', '2024-12-31');
    assertEqual(result, 2, 'TABLE-001 min in 2024 should equal inventory qty 2');
});

// ── Group 13: Sheet Locking ────────────────────────────────────────────────────
// getSheetLock gates all save operations. FakeGoogle has a lock fixture for
// PACK_LISTS:ATSC 2025 NAB held by locked.user@example.com.

test('SHEET LOCKING', 'locked tab returns a lock object', async () => {
    const result = await Requests.getSheetLock('PACK_LISTS', 'ATSC 2025 NAB');
    if (!result) throw new Error('expected lock object, got null');
});

test('SHEET LOCKING', 'locked tab returns the correct lock owner', async () => {
    const result = await Requests.getSheetLock('PACK_LISTS', 'ATSC 2025 NAB');
    assertEqual(result?.user, 'locked.user@example.com', 'lock owner for ATSC 2025 NAB');
});

test('SHEET LOCKING', 'unlocked tab returns null', async () => {
    const result = await Requests.getSheetLock('PACK_LISTS', 'CHAINCO 2026 SPRING EXPO');
    assertEqual(result, null, 'getSheetLock for tab with no lock');
});

test('SHEET LOCKING', 'currentUser matching lock owner returns null', async () => {
    // The current user is excluded — their own lock should not block themselves
    const result = await Requests.getSheetLock('PACK_LISTS', 'ATSC 2025 NAB', 'locked.user@example.com');
    assertEqual(result, null, 'own lock is excluded when currentUser matches');
});

// ── Group 14: Production Schedule Date Filters ───────────────────────────────
// getProductionScheduleData applies Ship/Return date-filter logic including
// calculated columns and year-boundary correction. FakeGoogle has SPRING EXPO
// (ship 3/1/2026) and ALLEN ARMS 2025 SHOT (ship 1/13/2025) as contrasting fixtures.

test('SCHEDULE FILTERS', 'null filter returns all shows', async () => {
    const result = await Requests.getProductionScheduleData(null);
    if (!Array.isArray(result) || result.length === 0)
        throw new Error('expected non-empty result for null filter');
});

test('SCHEDULE FILTERS', '2026 ship-date window includes SPRING EXPO', async () => {
    const result = await Requests.getProductionScheduleData({ dateFilters: [
        { column: 'Ship', type: 'after',  value: '2026-01-01' },
        { column: 'Ship', type: 'before', value: '2026-12-31' }
    ]});
    const identifiers = result.map(r => r.Identifier);
    assertContains(identifiers, 'CHAINCO 2026 SPRING EXPO', '2026 filter must include SPRING EXPO');
});

test('SCHEDULE FILTERS', '2026 ship-date window excludes 2025 shows', async () => {
    const result = await Requests.getProductionScheduleData({ dateFilters: [
        { column: 'Ship', type: 'after',  value: '2026-01-01' },
        { column: 'Ship', type: 'before', value: '2026-12-31' }
    ]});
    const identifiers = result.map(r => r.Identifier);
    assertNotContains(identifiers, 'ALLEN ARMS 2025 SHOT', '2026 filter must exclude ALLEN ARMS 2025 SHOT');
});

// ── Group 15: CAD Source History ──────────────────────────────────────────────
// checkCadSourceHistory returns an alert when the most-recent edit is from CAD
// and a prior web edit exists (a human's work may have been overwritten).
// The ATSC 2025 NAB packlist in FakeGoogle has a known cad-over-web fixture.

test('CAD SOURCE HISTORY', 'null input returns null', async () => {
    const result = await Requests.checkCadSourceHistory(null);
    assertEqual(result, null, 'checkCadSourceHistory(null)');
});

test('CAD SOURCE HISTORY', 'empty string returns null', async () => {
    const result = await Requests.checkCadSourceHistory('');
    assertEqual(result, null, 'checkCadSourceHistory("")');
});

test('CAD SOURCE HISTORY', 'most-recent cad after prior web returns alert', async () => {
    const history = JSON.stringify({ h: [
        { u: 'cadbot', t: 17309064100, s: 'cad', c: [{ n: 'Description', o: 'old cad value' }] },
        { u: 'dan',    t: 17309064000, s: 'web', c: [{ n: 'Description', o: 'original web value' }] }
    ]});
    const result = await Requests.checkCadSourceHistory(history);
    if (!result) throw new Error('expected alert object, got null');
    assertEqual(result.type, 'cad-source-change', 'alert type for cad-over-web');
});

test('CAD SOURCE HISTORY', 'cad with no prior web returns null', async () => {
    const history = JSON.stringify({ h: [
        { u: 'cadbot', t: 17309064100, s: 'cad', c: [{ n: 'Description', o: 'cad value' }] }
    ]});
    const result = await Requests.checkCadSourceHistory(history);
    assertEqual(result, null, 'cad-only history should return null');
});

test('CAD SOURCE HISTORY', 'most-recent web returns null', async () => {
    const history = JSON.stringify({ h: [
        { u: 'dan',    t: 17309064100, s: 'web', c: [{ n: 'Description', o: 'web value' }] },
        { u: 'cadbot', t: 17309064000, s: 'cad', c: [{ n: 'Description', o: 'cad value' }] }
    ]});
    const result = await Requests.checkCadSourceHistory(history);
    assertEqual(result, null, 'most-recent-web history should return null');
});

test('CAD SOURCE HISTORY', 'FakeGoogle ATSC NAB fixture produces cad alert', async () => {
    // FakeGoogle ATSC 2025 NAB first item row has a known cad-over-web EditHistory
    const crates = await Requests.getPackList('ATSC 2025 NAB');
    const firstItem = crates?.[0]?.Items?.[0];
    if (!firstItem) throw new Error('ATSC 2025 NAB first item row not found');
    const result = await Requests.checkCadSourceHistory(firstItem.edithistory);
    if (!result) throw new Error('expected cad alert for ATSC NAB fixture item, got null');
    assertEqual(result.type, 'cad-source-change', 'ATSC NAB fixture cad alert type');
});

// ── Group 16: Deduplication ────────────────────────────────────────────────────
// getDeduplicatedShowDates collapses schedule rows with the same canonical show name
// and year into one entry (ignoring client). FakeGoogle has four rows for HIMSS year
// 2024 (Codametrix + Harmony Health + QGenda×2) that must all collapse to one entry.
// Ship-date window 2024-02-20 → 2024-03-01 isolates exactly those four rows.

test('DEDUPLICATION', 'returns an array', async () => {
    const result = await Requests.getDeduplicatedShowDates(null);
    if (!Array.isArray(result)) throw new Error('expected array from getDeduplicatedShowDates');
});

test('DEDUPLICATION', 'HIMSS 2024 four-row window collapses to one entry', async () => {
    const filter = { dateFilters: [
        { column: 'Ship', type: 'after',  value: '2024-02-20' },
        { column: 'Ship', type: 'before', value: '2024-03-01' }
    ]};
    const deduped = await Requests.getDeduplicatedShowDates(filter);
    assertEqual(deduped.length, 1, 'four HIMSS 2024 rows should deduplicate to exactly 1');
});

test('DEDUPLICATION', 'deduplicated count is less than raw schedule count', async () => {
    const raw    = await Requests.getProductionScheduleData(null);
    const deduped = await Requests.getDeduplicatedShowDates(null);
    if (deduped.length >= raw.length)
        throw new Error(`deduped (${deduped.length}) should be < raw (${raw.length})`);
});

// ── Group 17: Cross-Year Matching ─────────────────────────────────────────────
// findScheduleRowsForPacklist parses the year out of a packlist tab title and
// year-filters the schedule before matching. This prevents AUSTAL 2026 SNA from
// resolving to AUSTAL 2023 WORKBOAT despite both having similar client names.
// FakeGoogle has both shows; the 2026 match uses the 'SNA' abbreviation for
// 'SURFACE NAVY' in the Shows index.
// Production-utils comment: "IMPORTANT: Always prefer matches within the same year"

test('CROSS-YEAR MATCHING', 'AUSTAL 2026 SNA resolves to year 2026 show', async () => {
    const result = await Requests.getShowDetails('AUSTAL 2026 SNA');
    if (!result) throw new Error('expected non-null show details for AUSTAL 2026 SNA');
    assertEqual(result.Year, '2026', 'AUSTAL 2026 SNA Year field');
});

test('CROSS-YEAR MATCHING', 'AUSTAL 2026 SNA does not resolve to 2023 Workboat show', async () => {
    const result = await Requests.getShowDetails('AUSTAL 2026 SNA');
    if (result?.Year === '2023') throw new Error('AUSTAL 2026 SNA incorrectly matched 2023 Workboat row');
});

test('CROSS-YEAR MATCHING', 'AUSTAL 2026 SNA resolves to Surface Navy show name', async () => {
    const result = await Requests.getShowDetails('AUSTAL 2026 SNA');
    if (!result?.Show) throw new Error('expected Show field in result');
    // 'SNA' is an abbreviation for 'SURFACE NAVY' in the Shows index
    if (!result.Show.toUpperCase().includes('SURFACE') && !result.Show.toUpperCase().includes('NAVY'))
        throw new Error(`expected Surface Navy show, got: ${result.Show}`);
});

// ── Group 18: Unknown Client Fallback ─────────────────────────────────────────
// GetTopFuzzyMatch throws 'No good matches found' when no candidate clears the
// distance threshold. computeIdentifier catches that and substitutes the raw
// (normalized) client name so identifiers can still be formed for unindexed clients.
// FakeGoogle has 'Test Client' deliberately absent from the Clients index and a
// matching packlist tab 'TEST CLIENT 2025 HIMSS' to exercise this path.

test('UNKNOWN CLIENT FALLBACK', 'computeIdentifier with unindexed client does not throw', async () => {
    // Should complete without throwing; raw client name is the fallback
    let threw = false;
    try { await Requests.computeIdentifier('HIMSS', 'Test Client', '2025'); }
    catch (e) { threw = true; }
    if (threw) throw new Error('computeIdentifier threw for unindexed client');
});

test('UNKNOWN CLIENT FALLBACK', 'unindexed client falls back to raw name in identifier', async () => {
    // computeIdentifier does not uppercase the fallback — it uses the trimmed input as-is
    const result = await Requests.computeIdentifier('HIMSS', 'Test Client', '2025');
    assertEqual(result, 'Test Client 2025 HIMSS', 'computeIdentifier fallback for unknown client');
});

test('UNKNOWN CLIENT FALLBACK', 'packlist tab for unindexed client is found by getShowDetails', async () => {
    // The schedule row for Test Client has a blank Identifier column, so getShowDetails
    // must compute it via computeIdentifier (which falls back to raw name)
    const result = await Requests.getShowDetails('TEST CLIENT 2025 HIMSS');
    if (!result) throw new Error('expected show details for TEST CLIENT 2025 HIMSS');
});

// ── Group 19: Identifier Safety Regressions ──────────────────────────────────
// These tests guard against accidental aliasing where a non-existent show identifier
// is fuzzy-mapped onto an existing show for the same client/year (e.g. AAP -> AAO),
// and against stale Identifier fields creating duplicate analytics keys.

test('IDENTIFIER SAFETY', 'same-client/year show typo does not fuzzy-match to a different show', async () => {
    const candidates = ['LEICA 2026 AAO', 'LEICA 2026 CNS'];
    const result = await ProductionUtils.findBestProjectIdentifierMatch('LEICA 2026 AAP', candidates);
    assertEqual(result, null, 'findBestProjectIdentifierMatch should reject aliasing AAP -> AAO/CNS');
});

test('IDENTIFIER SAFETY', 'short show token does not fuzzy-alias AANS to AANA', async () => {
    const candidates = ['LEICA MICROSYSTEMS 2026 AANA'];
    const result = await ProductionUtils.findBestProjectIdentifierMatch('LEICA MICROSYSTEMS 2026 AANS', candidates);
    assertEqual(result, null, 'findBestProjectIdentifierMatch should reject AANS -> AANA short-token alias');
});

test('IDENTIFIER SAFETY', 'computeIdentifier preserves unmatched short show token instead of fuzzy-aliasing', async () => {
    const result = await Requests.computeIdentifier('AANS', 'Leica Microsystems', '2026');
    assertEqual(result, 'Leica Microsystems 2026 AANS', 'computeIdentifier should keep short unmatched show token AANS');
});

test('IDENTIFIER SAFETY', 'getShowDetails rejects non-existent same-client/year show typo', async () => {
    const result = await Requests.getShowDetails('CHAINCO 2026 SPRING EXPOO');
    assertEqual(result, null, 'getShowDetails should not map SPRING EXPOO to SPRING EXPO');
});

test('IDENTIFIER SAFETY', 'checkPacklistExists ignores stale row.Identifier and uses canonical schedule id', async () => {
    const row = {
        Show: 'Spring Expo',
        Client: 'ChainCo',
        Year: '2026',
        Identifier: 'CHAINCO 2026 SPRING EXP0'
    };
    const result = await Requests.checkPacklistExists(row);
    assertEqual(result.exists, true, 'checkPacklistExists should still find canonical packlist');
    assertEqual(result.identifier, 'CHAINCO 2026 SPRING EXPO', 'checkPacklistExists should return canonical tab title');
});

test('IDENTIFIER SAFETY', 'deduplicateScheduleByShow uses canonical identifiers, not stale Identifier fields', async () => {
    const rows = [
        {
            Show: 'Spring Expo',
            Client: 'ChainCo',
            Year: '2026',
            Identifier: 'CHAINCO 2026 SPRING EXPO'
        },
        {
            Show: 'Spring Expo',
            Client: 'ChainCo',
            Year: '2026',
            Identifier: 'CHAINCO 2026 SPRING EXPO TYPO'
        }
    ];
    const deduped = await ProductionUtils.deduplicateScheduleByShow(rows);
    assertEqual(deduped.length, 1, 'deduplicateScheduleByShow should collapse stale-identifier duplicates');
});

// ── Group 20: Item Quantities Summary ─────────────────────────────────────────
// getItemQuantitiesSummary extracts item quantities from a single packlist tab.
// The extractItems loop explicitly skips the edithistory and metadata fields to prevent
// old description values in the EditHistory JSON from being parsed as item codes.
// Tests cover: known simple extractions, EditHistory-skip regression (ATSC NAB),
// and the Lockheed suffix variant tabs (primary and MEETING ROOM).

test('ITEM QUANTITIES SUMMARY', 'SPRING EXPO TABLE-001 quantity is 2', async () => {
    const rows = await Requests.getItemQuantitiesSummary('CHAINCO 2026 SPRING EXPO');
    const row = rows?.find(r => r.itemId === 'TABLE-001');
    if (!row) throw new Error('TABLE-001 not found in SPRING EXPO summary');
    assertEqual(row.quantity, 2, 'SPRING EXPO TABLE-001 quantity');
});

test('ITEM QUANTITIES SUMMARY', 'SPRING EXPO CHAIR-002 quantity is 5', async () => {
    const rows = await Requests.getItemQuantitiesSummary('CHAINCO 2026 SPRING EXPO');
    const row = rows?.find(r => r.itemId === 'CHAIR-002');
    if (!row) throw new Error('CHAIR-002 not found in SPRING EXPO summary');
    assertEqual(row.quantity, 5, 'SPRING EXPO CHAIR-002 quantity');
});

test('ITEM QUANTITIES SUMMARY', 'ATSC NAB CAB-004 quantity is 11 (EditHistory skip regression)', async () => {
    // Crates 4/5/6 contribute 4+4+3=11. EditHistory cells contain old description text;
    // if not skipped they could inflate this count.
    const rows = await Requests.getItemQuantitiesSummary('ATSC 2025 NAB');
    const row = rows?.find(r => r.itemId === 'CAB-004');
    if (!row) throw new Error('CAB-004 not found in ATSC NAB summary');
    assertEqual(row.quantity, 11, 'ATSC NAB CAB-004 quantity (4+4+3)');
});

test('ITEM QUANTITIES SUMMARY', 'Lockheed NGAUS primary tab TABLE-001 quantity is 2', async () => {
    const rows = await Requests.getItemQuantitiesSummary('LOCKHEED MARTIN 2025 NGAUS');
    const row = rows?.find(r => r.itemId === 'TABLE-001');
    if (!row) throw new Error('TABLE-001 not found in LOCKHEED MARTIN 2025 NGAUS summary');
    assertEqual(row.quantity, 2, 'LOCKHEED NGAUS primary TABLE-001 quantity');
});

test('ITEM QUANTITIES SUMMARY', 'Lockheed NGAUS MEETING ROOM suffix tab TABLE-001 quantity is 2', async () => {
    const rows = await Requests.getItemQuantitiesSummary('LOCKHEED MARTIN 2025 NGAUS MEETING ROOM');
    const row = rows?.find(r => r.itemId === 'TABLE-001');
    if (!row) throw new Error('TABLE-001 not found in LOCKHEED MARTIN 2025 NGAUS MEETING ROOM summary');
    assertEqual(row.quantity, 2, 'LOCKHEED NGAUS MEETING ROOM TABLE-001 quantity');
});

// ── Group 20: Timeline Balance Event ─────────────────────────────────────────
// getItemTimeline emits a Balance event at the window start whose quantity reflects
// the inventory level just before the window opens. The NOTE in inventory-utils reads:
// "Balance row is pushed AFTER Phase 4 so pre-window ship adjustments are captured
// in startQty before the anchor row is written."
// For TABLE-001 with no pre-2026 history in FakeGoogle, the balance must equal the
// raw inventory quantity (2) at the start of the chain window.

test('TIMELINE BALANCE', 'timeline includes a Balance event', async () => {
    const events = await Requests.getItemTimeline('TABLE-001', '2026-03-01', '2026-06-30');
    const balance = events.find(e => e.event === 'Balance');
    if (!balance) throw new Error('expected Balance event in TABLE-001 timeline');
});

test('TIMELINE BALANCE', 'Balance event is dated at window start', async () => {
    const events = await Requests.getItemTimeline('TABLE-001', '2026-03-01', '2026-06-30');
    const balance = events.find(e => e.event === 'Balance');
    if (!balance) throw new Error('Balance event not found');
    assertEqual(balance.date, '2026-03-01', 'Balance event date');
});

test('TIMELINE BALANCE', 'Balance quantity equals inventory quantity before any ships', async () => {
    // No TABLE-001 history exists before 2026-03-01 in FakeGoogle, so balance = inventory qty 2
    const events = await Requests.getItemTimeline('TABLE-001', '2026-03-01', '2026-06-30');
    const balance = events.find(e => e.event === 'Balance');
    if (!balance) throw new Error('Balance event not found');
    assertEqual(balance.quantity, 2, 'Balance quantity should equal inventory qty 2');
});

// ── Group 21: Available Tabs ──────────────────────────────────────────────────

test('AVAILABLE TABS', 'INVENTORY tabs include FURNITURE', async () => {
    const tabs = await Requests.getAvailableTabs('INVENTORY');
    if (!Array.isArray(tabs) || tabs.length === 0) throw new Error('expected non-empty tabs array');
    assertContains(tabs.map(t => t.title), 'FURNITURE', 'INVENTORY tabs must include FURNITURE');
});

test('AVAILABLE TABS', 'PACK_LISTS without hidden excludes _TEMPLATE', async () => {
    const tabs = await Requests.getAvailableTabs('PACK_LISTS', false);
    assertNotContains(tabs.map(t => t.title), '_TEMPLATE', 'hidden=false must exclude _TEMPLATE');
});

test('AVAILABLE TABS', 'PACK_LISTS with hidden includes _TEMPLATE', async () => {
    const tabs = await Requests.getAvailableTabs('PACK_LISTS', true);
    assertContains(tabs.map(t => t.title), '_TEMPLATE', 'hidden=true must include _TEMPLATE');
});

// ── Group 22: Inventory Tab and Index ────────────────────────────────────────

test('INVENTORY TAB AND INDEX', 'getInventoryTabData returns TABLE-001 with quantity 2', async () => {
    const rows = await Requests.getInventoryTabData('FURNITURE');
    const row = rows?.find(r => r.itemNumber === 'TABLE-001');
    if (!row) throw new Error('TABLE-001 not found in FURNITURE tab data');
    assertEqual(row.quantity, '2', 'TABLE-001 quantity in FURNITURE tab');
});

test('INVENTORY TAB AND INDEX', 'getInventoryIndexData includes TABLE→FURNITURE entry', async () => {
    const index = await Requests.getInventoryIndexData();
    const entry = index?.find(r => r.prefix === 'TABLE');
    if (!entry) throw new Error('TABLE prefix not found in inventory index');
    assertEqual(entry.tab, 'FURNITURE', 'TABLE prefix maps to FURNITURE');
});

test('INVENTORY TAB AND INDEX', 'InventoryCustomItemNumbers preference contains HARDWARE', async () => {
    const prefs = await Requests.getPreferences();
    const pref = prefs?.find(p => p.id === 'InventoryCustomItemNumbers');
    if (!pref) throw new Error('InventoryCustomItemNumbers preference not found');
    let tabs = [];
    try { tabs = JSON.parse(pref.value); } catch {}
    assertContains(tabs, 'HARDWARE', 'InventoryCustomItemNumbers must include HARDWARE');
});

test('INVENTORY TAB AND INDEX', 'category cards search item rows: getAllInventoryData has TABLE-001 in FURNITURE', async () => {
    // Category cards bucket the overview rows by tab and search them directly (views plan R2.12, D7)
    const rows = await Requests.getAllInventoryData(todayISOString());
    if (!Array.isArray(rows)) throw new Error('expected array from getAllInventoryData');
    const entry = rows.find(r => r.itemNumber === 'TABLE-001');
    if (!entry || String(entry.tab).toUpperCase() !== 'FURNITURE') throw new Error('TABLE-001 not found in FURNITURE rows');
});

// ── Group 23: Item Details ────────────────────────────────────────────────────

test('ITEM DETAILS', 'getItemInventoryQuantity returns integer 2 for TABLE-001', async () => {
    const result = await Requests.getItemInventoryQuantity('TABLE-001');
    assertEqual(result, 2, 'getItemInventoryQuantity(TABLE-001)');
});

test('ITEM DETAILS', 'getItemInventoryQuantity returns null for unknown item', async () => {
    const result = await Requests.getItemInventoryQuantity('NONEXISTENT-999');
    assertEqual(result, null, 'getItemInventoryQuantity for unknown item');
});

test('ITEM DETAILS', 'getItemDescription returns inventory description for TABLE-001', async () => {
    const result = await Requests.getItemDescription('TABLE-001');
    if (!result || typeof result !== 'string') throw new Error(`expected non-null string, got ${JSON.stringify(result)}`);
    if (!result.toLowerCase().includes('table')) throw new Error(`unexpected description: ${result}`);
});

// ── Group 24: User Data ───────────────────────────────────────────────────────
// FakeGoogle has a CACHE/UserData_test_example_com tab with 'dashboard_containers' key.

test('USER DATA', 'getUserData returns stored value for test account', async () => {
    const result = await Requests.getUserData('test@example.com', 'dashboard_containers');
    if (result === null || result === undefined) throw new Error('expected non-null user data for dashboard_containers');
});

test('USER DATA', 'hasUserDataKey returns true for existing key', async () => {
    const result = await Requests.hasUserDataKey('test@example.com', 'dashboard_containers');
    assertEqual(result, true, 'hasUserDataKey for existing key');
});

test('USER DATA', 'hasUserDataKey returns false for nonexistent key', async () => {
    const result = await Requests.hasUserDataKey('test@example.com', 'definitely_nonexistent_key_xyz');
    assertEqual(result, false, 'hasUserDataKey for nonexistent key');
});

test('USER DATA', 'getUserDataByPrefix returns entry for dashboard prefix', async () => {
    const result = await Requests.getUserDataByPrefix('test@example.com', 'dashboard');
    if (result === null || result === undefined) throw new Error('expected match for prefix "dashboard"');
});

// ── Group 25: Hardware Inventory Resolution ───────────────────────────────────
// Hardware items use non-standard item number formats that fail the prefix lookup
// in getTabNameForItem and are resolved instead by scanning the tabs the
// InventoryCustomItemNumbers preference lists (HARDWARE). Three distinct failure modes have been found historically:
//
//   Multi-hyphen  VUE-V2C-LP / LED-EXL21-SL
//     Standard regex extracts only the first segment (VUE-V2C); that partial ID
//     has no tab match; hardware fallback catches the full item number.
//   Spaced-numeric  901 00 030 MKII / 615 11 01 ANO
//     Standard regex never fires (no [A-Z]+-digits prefix); direct hardware path.
//   Text-based  HH BOLTHOG M8 LONG / HH BOLTHOG 1-4 20 x 2.5
//     No standard prefix match; the InventoryCustomItemNumbers scan finds the exact row.
//     HH BOLTHOG 1-4 20 x 2.5 also tests the getItemInfo hyphen-split fallback:
//     split('-')[1] yields '4 20 x 2.5' which doesn't exist; code retries with
//     the full original item name.
//
// FakeGoogle HARDWARE quantities:
//   VUE-V2C-LP=20, 901 00 030 MKII=50, HH BOLTHOG M8 LONG=100, HH BOLTHOG 1-4 20 x 2.5=150
//
// FakeGoogle TEST 2025 ENHANCED packlist hardware quantities:
//   901 00 030 MKII=10, VUE-V2C-LP=3, HH BOLTHOG M8 LONG=25, HH BOLTHOG 1-4 20 x 2.5=15

test('HARDWARE INVENTORY', 'multi-hyphen item VUE-V2C-LP routes to HARDWARE tab', async () => {
    const result = await Requests.getTabNameForItem('VUE-V2C-LP');
    assertEqual(result, 'HARDWARE', 'getTabNameForItem("VUE-V2C-LP")');
});

test('HARDWARE INVENTORY', 'spaced-numeric item 901 00 030 MKII routes to HARDWARE tab', async () => {
    const result = await Requests.getTabNameForItem('901 00 030 MKII');
    assertEqual(result, 'HARDWARE', 'getTabNameForItem("901 00 030 MKII")');
});

test('HARDWARE INVENTORY', 'text-based item HH BOLTHOG M8 LONG routes to HARDWARE tab', async () => {
    const result = await Requests.getTabNameForItem('HH BOLTHOG M8 LONG');
    assertEqual(result, 'HARDWARE', 'getTabNameForItem("HH BOLTHOG M8 LONG")');
});

test('HARDWARE INVENTORY', 'hyphen-containing text item HH BOLTHOG 1-4 20 x 2.5 routes to HARDWARE tab', async () => {
    // split('-')[1] = '4 20 x 2.5' has no tab match; customItemNumbers fallback finds exact row
    const result = await Requests.getTabNameForItem('HH BOLTHOG 1-4 20 x 2.5');
    assertEqual(result, 'HARDWARE', 'getTabNameForItem("HH BOLTHOG 1-4 20 x 2.5")');
});

test('HARDWARE INVENTORY', 'getInventoryInfo returns correct quantity for multi-hyphen hardware item', async () => {
    // getItemInfo: split('-')[1]='V2C' not found → falls back to full original item name
    const rows = await Requests.getInventoryInfo('VUE-V2C-LP', ['quantity']);
    const row = rows?.find(r => r.itemName === 'VUE-V2C-LP');
    if (!row) throw new Error('VUE-V2C-LP not found in inventory info');
    assertEqual(row.quantity, '20', 'VUE-V2C-LP quantity');
});

test('HARDWARE INVENTORY', 'getInventoryInfo returns correct quantity for spaced-numeric hardware item', async () => {
    const rows = await Requests.getInventoryInfo('901 00 030 MKII', ['quantity']);
    const row = rows?.find(r => r.itemName === '901 00 030 MKII');
    if (!row) throw new Error('901 00 030 MKII not found in inventory info');
    assertEqual(row.quantity, '50', '901 00 030 MKII quantity');
});

test('HARDWARE INVENTORY', 'getInventoryInfo returns correct quantity for hyphen-containing text item', async () => {
    // getItemInfo hyphen-split fallback: split('-')[1]='4 20 x 2.5' not found; retries with full name
    const rows = await Requests.getInventoryInfo('HH BOLTHOG 1-4 20 x 2.5', ['quantity']);
    const row = rows?.find(r => r.itemName === 'HH BOLTHOG 1-4 20 x 2.5');
    if (!row) throw new Error('HH BOLTHOG 1-4 20 x 2.5 not found in inventory info');
    assertEqual(row.quantity, '150', 'HH BOLTHOG 1-4 20 x 2.5 quantity');
});

test('HARDWARE INVENTORY', 'extractItemNumber falls through to hardware for spaced-numeric item', async () => {
    // Standard regex [A-Z]+-[0-9...] never fires; hardware fallback catches the full item number
    const result = await Requests.extractItemNumber('(10) 901 00 030 MKII Mounting brackets');
    assertEqual(result, '901 00 030 MKII', 'extractItemNumber spaced-numeric hardware');
});

test('HARDWARE INVENTORY', 'extractItemNumber falls through to hardware for multi-hyphen item', async () => {
    // Standard regex matches partial VUE-V2C; that ID has no tab → hardware fallback catches VUE-V2C-LP
    const result = await Requests.extractItemNumber('(3) VUE-V2C-LP Low profile connectors');
    assertEqual(result, 'VUE-V2C-LP', 'extractItemNumber multi-hyphen hardware');
});

test('HARDWARE INVENTORY', 'extractItemNumber falls through to hardware for text-based HH item', async () => {
    const result = await Requests.extractItemNumber('(25) HH BOLTHOG M8 LONG Long bolts');
    assertEqual(result, 'HH BOLTHOG M8 LONG', 'extractItemNumber text-based hardware');
});

test('HARDWARE INVENTORY', 'getItemQuantitiesSummary counts 901 00 030 MKII correctly in TEST 2025 ENHANCED', async () => {
    const rows = await Requests.getItemQuantitiesSummary('TEST 2025 ENHANCED');
    const row = rows?.find(r => r.itemId === '901 00 030 MKII');
    if (!row) throw new Error('901 00 030 MKII not found in TEST 2025 ENHANCED quantities');
    assertEqual(row.quantity, 10, 'TEST 2025 ENHANCED 901 00 030 MKII quantity');
});

test('HARDWARE INVENTORY', 'getItemQuantitiesSummary counts VUE-V2C-LP correctly in TEST 2025 ENHANCED', async () => {
    const rows = await Requests.getItemQuantitiesSummary('TEST 2025 ENHANCED');
    const row = rows?.find(r => r.itemId === 'VUE-V2C-LP');
    if (!row) throw new Error('VUE-V2C-LP not found in TEST 2025 ENHANCED quantities');
    assertEqual(row.quantity, 3, 'TEST 2025 ENHANCED VUE-V2C-LP quantity');
});

test('HARDWARE INVENTORY', 'getItemQuantitiesSummary counts HH BOLTHOG M8 LONG correctly in TEST 2025 ENHANCED', async () => {
    const rows = await Requests.getItemQuantitiesSummary('TEST 2025 ENHANCED');
    const row = rows?.find(r => r.itemId === 'HH BOLTHOG M8 LONG');
    if (!row) throw new Error('HH BOLTHOG M8 LONG not found in TEST 2025 ENHANCED quantities');
    assertEqual(row.quantity, 25, 'TEST 2025 ENHANCED HH BOLTHOG M8 LONG quantity');
});

test('HARDWARE INVENTORY', 'getItemQuantitiesSummary counts HH BOLTHOG 1-4 20 x 2.5 correctly in TEST 2025 ENHANCED', async () => {
    // Verifies the special-character hardware item (dot, spaces in item number) is extracted via hardware fallback
    const rows = await Requests.getItemQuantitiesSummary('TEST 2025 ENHANCED');
    const row = rows?.find(r => r.itemId === 'HH BOLTHOG 1-4 20 x 2.5');
    if (!row) throw new Error('HH BOLTHOG 1-4 20 x 2.5 not found in TEST 2025 ENHANCED quantities');
    assertEqual(row.quantity, 15, 'TEST 2025 ENHANCED HH BOLTHOG 1-4 20 x 2.5 quantity');
});

// ── Item Variants ─────────────────────────────────────────────────────────────
// A letter appended to a standard item number notes a variant of the base item. Variants are
// declared, with optional counts, in the base item's inventory description (parseItemVariants).
// FakeGoogle CABINETS:
//   CAB-005 (QTY 6, no real variant parts): CAB-005b and CAB-005C count as CAB-005. Its description
//     "Tall gray storage cabinet\n(1) CAB-005b with locking doors" declares one CAB-005b.
//   CAB-006 with a real CAB-006a: CAB-006a matches itself, CAB-006b stays unmatched (no fallback)
//   CAB-009 is not an item: CAB-009b stays CAB-009b
// Pack lists:
//   TEST 2025 ENHANCED crate 1: (6) CAB-005, (2) CAB-005b, (1) CAB-005C, (3) CAB-006a, (1) CAB-006b
//     → CAB-005=9, CAB-006a=3, CAB-006b=1. No show overlaps it.
//   ATSC 2025 NAB and GEARFIRE 2025 SHOT (overlapping, 1/10 to 1/31/2025): (1) CAB-005b each
// Variant checks:
//   ATSC CAB-005b: 1 declared, 2 needed (ATSC 1 + GEARFIRE 1) → 1 short (red)
//   TEST ENHANCED CAB-005b: 1 declared, 2 needed → 1 short (red)
//   TEST ENHANCED unmodified CAB-005: 6 - 1 = 5 available, 9 - 3 variants = 6 needed → 1 short (orange)
//   TEST ENHANCED CAB-005C: undeclared → a description alert, no variant check

const CAB_005_DESCRIPTION = 'Tall gray storage cabinet\n(1) CAB-005b with locking doors';

test('ITEM VARIANTS', 'resolveItemVariant applies the variant rules', async () => {
    const items = ['CAB-005', 'CAB-006', 'CAB-006a', 'BX-10Rx39P'];
    assertEqual(itemVariantBase('CAB-005b'), 'CAB-005', 'lower-case suffix');
    assertEqual(itemVariantBase('CAB-005B'), 'CAB-005', 'upper-case suffix');
    assertEqual([itemVariantBase('CAB-005'), itemVariantBase('CAB-005bc'), itemVariantBase('BX-3Rx8_45°')], [null, null, null], 'not variant-shaped');
    assertEqual([itemVariantKey('CAB-005C'), itemVariantKey('CAB-005b'), itemVariantKey('CAB-005')], ['CAB-005c', 'CAB-005b', null], 'variant keys');
    assertEqual(resolveItemVariant('CAB-005b', items), 'CAB-005', 'falls back to base');
    assertEqual(resolveItemVariant('CAB-006a', items), 'CAB-006a', 'a real variant matches itself');
    assertEqual(resolveItemVariant('CAB-006b', items), 'CAB-006b', 'a family with a real variant does not fall back');
    assertEqual(resolveItemVariant('CAB-009b', items), 'CAB-009b', 'no base item');
    assertEqual(resolveItemVariant('BX-10Rx39P', items), 'BX-10Rx39P', 'a real item ending in a letter');
});

test('ITEM VARIANTS', 'parseItemVariants reads variant lines from a description', async () => {
    const parsed = parseItemVariants('CAB-004', 'gray cabinet\n(3) CAB-004b with larger top\n(1) CAB-004C with smaller top\nCAB-004d');
    assertEqual(parsed, {
        baseDescription: 'gray cabinet',
        variants: [
            { key: 'CAB-004b', itemNumber: 'CAB-004b', letter: 'b', quantity: 3, note: 'with larger top', description: 'gray cabinet with larger top' },
            { key: 'CAB-004c', itemNumber: 'CAB-004C', letter: 'c', quantity: 1, note: 'with smaller top', description: 'gray cabinet with smaller top' },
            { key: 'CAB-004d', itemNumber: 'CAB-004d', letter: 'd', quantity: null, note: '', description: 'gray cabinet' }
        ]
    }, 'three variants');
    const prose = 'Counter. (4) standoffs on front and top\nsee CAB-004b\n(2) CAB-004bc\n(1) CAB-0045b\n(1) TABLE-001b';
    assertEqual(parseItemVariants('CAB-004', prose), { baseDescription: prose, variants: [] }, 'no variant lines');
    assertEqual(parseItemVariants('CAB-004', 'a\n(1) CAB-004b x\n(5) CAB-004B y').variants.map(v => v.quantity), [1], 'first line for a letter wins');
    assertEqual(parseItemVariants('BX-10Rx39P', 'panel\n(1) BX-10Rx39Pb').variants, [], 'base ending in a letter has no variants');
    assertEqual(parseItemVariants('CAB-004', ''), { baseDescription: '', variants: [] }, 'empty description');
});

test('ITEM VARIANTS', 'pack list text extracts the variant base item', async () => {
    const extract = (text) => Requests.extractItemNumber(text);
    assertEqual(await extract('(2) CAB-005b Tall gray storage cabinet with locking doors'), 'CAB-005', 'CAB-005b');
    assertEqual(await extract('(1) CAB-005C Tall gray storage cabinet'), 'CAB-005', 'CAB-005C');
    assertEqual(await extract('(3) CAB-006a Rolling demo cabinet'), 'CAB-006a', 'CAB-006a');
    assertEqual(await extract('(1) CAB-006b Rolling demo cabinet'), 'CAB-006b', 'CAB-006b');
    assertEqual(await extract('(1) CAB-009b Unknown cabinet'), 'CAB-009b', 'CAB-009b');
    const variant = await Requests.extractCustomItemFromText('(2) CAB-005b with locking doors', ['CABINETS']);
    assertEqual(variant.itemNumber, null, 'CABINETS is not a custom item number tab');
});

test('ITEM VARIANTS', 'variant quantities count against the base item', async () => {
    const rows = await Requests.getItemQuantitiesSummary('TEST 2025 ENHANCED');
    const quantities = Object.fromEntries(rows.filter(r => r.itemId.startsWith('CAB-')).map(r => [r.itemId, r.quantity]));
    assertEqual(quantities, { 'CAB-005': 9, 'CAB-006a': 3, 'CAB-006b': 1 }, 'TEST 2025 ENHANCED cabinet quantities');
});

test('ITEM VARIANTS', 'description matching uses the variant or base description', async () => {
    const check = (Description) => Requests.checkDescriptionMatch({ 'Extracted Item': 'CAB-005', Description });
    assertEqual(await check('(1) CAB-005b Tall gray storage cabinet with locking doors'), null, 'declared variant matches its description');
    assertEqual(await check('(6) CAB-005 Tall gray storage cabinet'), null, 'base line matches the base description without variant lines');
    const mismatch = await check('(1) CAB-005b red cabinet');
    assertEqual([mismatch?.type, mismatch?.variant, mismatch?.inventoryDescription], ['description mismatch', 'CAB-005b', 'Tall gray storage cabinet with locking doors'], 'variant mismatch keeps the variant');
    const undeclared = await check('(1) CAB-005C Tall gray storage cabinet, short top');
    assertEqual([undeclared?.type, undeclared?.severity, undeclared?.message, undeclared?.variant], ['undeclared variant', 'attention', 'Undeclared variant of CAB-005', 'CAB-005C'], 'undeclared variant');
});

test('ITEM VARIANTS', 'variant counts are checked against this and overlapping shows', async () => {
    const level = (Description, show) => Requests.checkVariantLevel({ 'Extracted Item': Description.match(/CAB-00\d/)[0], Description }, show);
    const pick = (alert) => alert && [alert.type, alert.severity, alert.message, alert.remaining, alert.details];
    assertEqual(pick(await level('(1) CAB-005b Tall gray storage cabinet with locking doors', 'ATSC 2025 NAB')),
        ['variant shortage', 'critical', 'CAB-005b: 1 short', -1, 'CAB-005b: 1 in inventory, 2 needed by this and overlapping shows.\nATSC 2025 NAB: 1\nGEARFIRE 2025 SHOT: 1'],
        'ATSC CAB-005b with GEARFIRE overlapping');
    assertEqual(pick(await level('(2) CAB-005b Tall gray storage cabinet with locking doors', 'TEST 2025 ENHANCED')),
        ['variant shortage', 'critical', 'CAB-005b: 1 short', -1, 'CAB-005b: 1 in inventory, 2 needed by this and overlapping shows.\nTEST 2025 ENHANCED: 2'],
        'TEST ENHANCED CAB-005b');
    assertEqual(pick(await level('(6) CAB-005 Tall gray storage cabinet', 'TEST 2025 ENHANCED')),
        ['variant shortage', 'warning', 'Unmodified CAB-005: 1 short', -1, 'Unmodified CAB-005: 5 in inventory, 6 needed by this and overlapping shows.\nTEST 2025 ENHANCED: 6'],
        'TEST ENHANCED unmodified CAB-005');
    assertEqual(await level('(1) CAB-005C Tall gray storage cabinet, short top', 'TEST 2025 ENHANCED'), null, 'undeclared variant has no count');
    assertEqual(await level('(4) CAB-004 Curved-bottom white demo counter', 'ATSC 2025 NAB'), null, 'family without declared variants');
});

test('ITEM VARIANTS', 'inventory description cards show each declared variant', async () => {
    const opened = [];
    const cards = itemVariantCards({ itemNumber: 'CAB-005', quantity: '6', description: CAB_005_DESCRIPTION }, (message, title) => opened.push([message, title]));
    assertEqual(cards.map(({ action, ...card }) => card), [{ message: 'b', class: 'purple', end: true, title: 'CAB-005b (1 of 6): Tall gray storage cabinet with locking doors' }], 'one card');
    cards[0].action();
    assertEqual(opened, [['Tall gray storage cabinet with locking doors', 'CAB-005b (1 of 6)']], 'card opens the variant');
    assertEqual(itemVariantCards({ itemNumber: 'CAB-004', quantity: '10', description: 'Counter' }, () => {}), [], 'no variants, no cards');
});

test('ITEM VARIANTS', 'a family with a real variant item shows that its variants are off', async () => {
    assertEqual([...itemVariantFamilies(['CAB-005', 'CAB-006', 'CAB-006a', 'BX-10Rx39P'])], ['CAB-006', 'BX-10Rx39'], 'families');
    const families = itemVariantFamilies(['CAB-005', 'CAB-006', 'CAB-006a']);
    const cards = itemVariantCards({ itemNumber: 'CAB-006', quantity: '4', description: 'Rolling demo cabinet\n(1) CAB-006b with shelves' }, () => {}, families);
    assertEqual(cards.map(card => [card.message, card.severity]), [['Variants off', 'critical']], 'one critical card');
    assertEqual(itemVariantCards({ itemNumber: 'CAB-005', quantity: '6', description: CAB_005_DESCRIPTION }, () => {}, families).map(card => card.message), ['b'], 'other families unaffected');
});

// Variant counts come from the inventory description through the cache: editing CAB-005's
// description to declare (3) CAB-005b clears ATSC's shortage (3 declared, 2 needed: 1 spare).
test('ITEM VARIANTS', 'editing a variant count updates the variant check', async () => {
    const atscLine = { 'Extracted Item': 'CAB-005', Description: '(1) CAB-005b Tall gray storage cabinet with locking doors' };
    const remaining = async () => (await Requests.checkVariantLevel(atscLine, 'ATSC 2025 NAB'))?.remaining ?? null;
    const original = await Database.getData('INVENTORY', 'CABINETS', DEFAULT_INVENTORY_MAPPING);
    const withDescription = (description) => original.map(row => row.itemNumber === 'CAB-005' ? { ...row, description } : row);
    assertEqual(await remaining(), -1, 'before: 1 short');
    try {
        await Database.setData('INVENTORY', 'CABINETS', withDescription('Tall gray storage cabinet\n(3) CAB-005b with locking doors'), DEFAULT_INVENTORY_MAPPING, { skipMetadata: true });
        assertEqual(await remaining(), null, 'after: no alert');
    } finally {
        await Database.setData('INVENTORY', 'CABINETS', withDescription(CAB_005_DESCRIPTION), DEFAULT_INVENTORY_MAPPING, { skipMetadata: true });
    }
    assertEqual(await remaining(), -1, 'restored: 1 short');
});

// ── Group 26: Thumbnail Column ────────────────────────────────────────────────
// Item thumbnails live in each inventory tab's Thumbnail column as a JSON array of Drive file IDs;
// category images in the index's Thumbnail column. FakeGoogle fixtures:
//   FURNITURE (Thumbnail at B): CHAIR-001 '["file_id_chair_001"]', CHAIR-002 '["file_id_chair_002"]',
//     TABLE-001 blank; TABLE-001 'Packing/shop notes' = 'Legs in bag' (an unmapped column)
//   PANELS (Thumbnail at B): every cell blank
//   Other tabs: a stale upper-case 'THUMBNAIL' column, which is NOT the Thumbnail column
//   HANGING SIGNS: no NOTES column (a required column, added after the last header on save)
//   CACHE/Inventory Thumbnail: TABLE '["file_id_table_prefix"]'; CHAIR and BX blank
//   CACHE/Thumbnails (the old table): BX, CHAIR, CHAIR-001, CHAIR-002, TABLE, TABLE-001
// Expected migration: FURNITURE fills TABLE-001 (2 already set); the index fills BX and CHAIR
// (TABLE already set); no record is left unmatched.

/** Run fn, then put the listed fixture tabs back and drop their cached reads. */
async function _withRestoredTabs(tabs, fn) {
    const saved = tabs.map(([db, tab]) => [db, tab, JSON.parse(JSON.stringify(FakeGoogleSheetsService.mockData[db][tab]))]);
    try {
        return await fn();
    } finally {
        for (const [db, tab, rows] of saved) {
            FakeGoogleSheetsService.mockData[db][tab] = rows;
            invalidateCache([{ namespace: 'database', methodName: 'getData', args: [db, tab] }], true);
        }
    }
}
const _rawTab = (db, tab) => FakeGoogleSheetsService.mockData[db][tab];

test('THUMBNAIL COLUMN', 'thumbnail values parse arrays, bare IDs and blanks', async () => {
    assertEqual(parseThumbnails('["a", "b"]'), ['a', 'b'], 'JSON array');
    assertEqual(parseThumbnails('abc'), ['abc'], 'bare file ID');
    assertEqual(parseThumbnails(''), [], 'blank');
    assertEqual(parseThumbnails('[broken'), [], 'invalid JSON');
    assertEqual(parseThumbnails('["a", {"id": "b", "note": "x"}]'), ['a', 'b'], 'objects give their file ID');
});

test('THUMBNAIL COLUMN', 'a column-preserving mapping owns only its own columns', async () => {
    const mapping = { a: 'A', b: 'B', c: 'C', t: 'T', _optional: ['t'], _preserveColumns: true };
    const { read, write } = resolveSheetMapping(mapping, ['X', 'B', 'A']);
    assertEqual(read, { a: 'A', b: 'B', c: 'C' }, 'read: present columns plus the required one');
    assertEqual(write._orderedHeaders, ['X', 'B', 'A', 'C'], 'the tab order, the missing required column appended');
    assertEqual(write._orderedKeys, [null, 'b', 'a', 'c'], 'other columns are not owned');
    assertEqual(resolveSheetMapping(mapping, ['T', 'A']).write._orderedKeys, ['t', 'a', 'b', 'c'], 'an optional column present is owned');
});

test('THUMBNAIL COLUMN', 'a tab reads its Thumbnail column; a stale THUMBNAIL column is not it', async () => {
    const furniture = await Requests.getInventoryTabData('FURNITURE');
    assertEqual(furniture.find(r => r.itemNumber === 'CHAIR-001').thumbnail, '["file_id_chair_001"]', 'CHAIR-001');
    assertEqual(furniture.find(r => r.itemNumber === 'TABLE-001').thumbnail, '', 'TABLE-001 blank');
    const lightbox = (await Requests.getInventoryTabData('LIGHTBOXES')).find(r => r.itemNumber === 'LB-001');
    assertEqual('thumbnail' in lightbox, false, 'LB-001 has no thumbnail key');
});

test('THUMBNAIL COLUMN', 'saving writes the thumbnail in place, keeps other columns and records history', async () => {
    await _withRestoredTabs([['INVENTORY', 'FURNITURE']], async () => {
        const headerBefore = [..._rawTab('INVENTORY', 'FURNITURE')[0]];
        const rows = (await Requests.getInventoryTabData('FURNITURE')).map(r => ({ ...r }));
        rows.find(r => r.itemNumber === 'CHAIR-001').thumbnail = '["file_new"]';
        await _asUser(() => Requests.saveInventoryTabData(rows, 'FURNITURE'));
        const raw = _rawTab('INVENTORY', 'FURNITURE');
        assertEqual(raw[0], headerBefore, 'header row unchanged');
        const chair = raw.find(r => r[0] === 'CHAIR-001');
        assertEqual(chair[1], '["file_new"]', 'new value under the Thumbnail header');
        assertEqual(raw.find(r => r[0] === 'TABLE-001')[7], 'Legs in bag', 'unmapped column kept');
        const saved = (await Requests.getInventoryTabData('FURNITURE')).find(r => r.itemNumber === 'CHAIR-001');
        assertEqual(JSON.parse(saved.edithistory).h[0].c, [{ n: 'thumbnail', o: '["file_id_chair_001"]' }], 'history entry');
    });
});

test('THUMBNAIL COLUMN', 'saving a tab without a Thumbnail column never adds one', async () => {
    await _withRestoredTabs([['INVENTORY', 'LIGHTBOXES']], async () => {
        const headerBefore = [..._rawTab('INVENTORY', 'LIGHTBOXES')[0]];
        const rows = (await Requests.getInventoryTabData('LIGHTBOXES')).map(r => ({ ...r }));
        rows[0].quantity = '3';
        await _asUser(() => Requests.saveInventoryTabData(rows, 'LIGHTBOXES'));
        assertEqual(_rawTab('INVENTORY', 'LIGHTBOXES')[0], headerBefore, 'header row unchanged');
        assertEqual(_rawTab('INVENTORY', 'LIGHTBOXES')[1][2], '3', 'QTY written in place');
    });
});

test('THUMBNAIL COLUMN', 'a missing required column is added after the last header', async () => {
    await _withRestoredTabs([['INVENTORY', 'HANGING SIGNS']], async () => {
        const rows = (await Requests.getInventoryTabData('HANGING SIGNS')).map(r => ({ ...r }));
        rows[0].notes = 'hang high';
        await _asUser(() => Requests.saveInventoryTabData(rows, 'HANGING SIGNS'));
        const raw = _rawTab('INVENTORY', 'HANGING SIGNS');
        assertEqual(raw[0], ['ITEM#', 'THUMBNAIL', 'QTY', 'EditHistory', 'MetaData', 'Description', 'Packing/shop notes', 'NOTES'], 'NOTES appended');
        assertEqual(raw[1][7], 'hang high', 'note under it');
        assertEqual(raw[1][5], 'This is a sign', 'Description kept in place');
    });
});

test('THUMBNAIL COLUMN', 'item thumbnails list items of thumbnail tabs only', async () => {
    const map = new Map((await Requests.getItemThumbnails()).map(e => [e.item, e.thumbnail]));
    assertEqual(map.get('CHAIR-001'), '["file_id_chair_001"]', 'own image');
    assertEqual(map.get('CHAIR-002'), '["file_id_chair_002"]', 'only the primary image');
    assertEqual(map.get('TABLE-001'), '', 'thumbnail tab, no image');
    assertEqual(map.get('BX-16x39'), '', 'PANELS item');
    assertEqual(map.has('LB-001'), false, 'tab without a Thumbnail column');
});

test('THUMBNAIL COLUMN', 'category images come from the index Thumbnail column', async () => {
    assertEqual(await Requests.getCategoryThumbnails(), [{ prefix: 'TABLE', thumbnail: '["file_id_table_prefix"]' }], 'TABLE only');
});

test('THUMBNAIL COLUMN', 'proposals carry thumbnail changes like other fields', async () => {
    const inventoryRow = { itemNumber: 'CHAIR-001', quantity: '20', description: 'Chair', notes: '', thumbnail: '["a"]' };
    assertEqual(ProposalUtils.diffRow(inventoryRow, { ...inventoryRow, thumbnail: '["b"]' }), [{ n: 'thumbnail', ne: '["b"]' }], 'diffRow');
    const row = ProposalUtils.toTableRow({ category: 'FURNITURE', itemNumber: 'CHAIR-001', changes: [{ n: 'thumbnail', ne: '["b"]' }] }, inventoryRow);
    assertEqual([row.thumbnail, row.currentThumbnail], ['["b"]', '["a"]'], 'proposed and current');
    assertEqual(ProposalUtils.changesFromTableRow(row), [{ n: 'thumbnail', ne: '["b"]' }], 'changes from the row');
    const noColumn = ProposalUtils.toTableRow({ category: 'LIGHTBOXES', itemNumber: 'LB-001', changes: [] }, { itemNumber: 'LB-001', quantity: '0' });
    assertEqual('thumbnail' in noColumn, false, 'no thumbnail for a tab without the column');
});

test('THUMBNAIL COLUMN', 'an identical image is uploaded once', async () => {
    const file = () => new File([new Uint8Array([7, 7, 7, 1])], 'same.png', { type: 'image/png' });
    const first = await Requests.uploadItemImage(file(), 'CHAIR-001');
    const second = await Requests.uploadItemImage(file(), 'CHAIR-002');
    assertEqual(second.fileId, first.fileId, 'same file ID');
    assertEqual([first.reused, second.reused], [false, true], 'second upload reused');
});

test('THUMBNAIL COLUMN', 'uploads are resized to fit 1000 x 1000 and only that copy is uploaded', async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 2400, height: 1200 });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = `rgb(${Date.now() % 255}, 80, 160)`;
    ctx.fillRect(0, 0, 2400, 1200);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const before = FakeGoogleSheetsService.uploadedFiles.length;
    const result = await Requests.uploadItemImage(new File([blob], 'big.png', { type: 'image/png' }), 'TABLE-002');
    const bitmap = await createImageBitmap(result.file);
    assertEqual([bitmap.width, bitmap.height], [1000, 500], 'resized');
    const added = FakeGoogleSheetsService.uploadedFiles.slice(before);
    assertEqual([added.length, added.some(f => f.name.includes('ORIGINAL'))], [1, false], 'one file, no original');
});

test('THUMBNAIL COLUMN', 'thumbnails are a column type that is never searched', async () => {
    assertEqual(guessColumnType('Thumbnail'), 'thumbnail', 'guessed from the name');
    assertEqual(isOpaqueType('thumbnail'), true, 'opaque');
    assertEqual(formatValue('["a","b"]', { format: 'thumbnail' }), '2 images', 'text form');
    const fields = [{ key: 'thumbnail', type: 'thumbnail' }, { key: 'itemNumber' }];
    const resolved = resolveView(fields, { id: 't', layout: 'table', columns: ['thumbnail', 'itemNumber'] });
    assertEqual(resolved.fieldMap.get('thumbnail').cell, 'thumbnail', 'cell from the type');
    assertEqual(searchTiers(resolved).shown, ['itemNumber'], 'not searched');
});

test('THUMBNAIL COLUMN', 'migration dry run plans blank cells only', async () => {
    const report = await migrateThumbnails();
    const furniture = report.tabs.find(t => t.tab === 'FURNITURE');
    assertEqual([furniture.fill, furniture.already, furniture.conflicts.length], [1, 2, 0], 'FURNITURE');
    assertEqual([report.index.fill, report.index.already], [2, 1], 'index');
    assertEqual(report.unmatched, [], 'every record matched');
    assertEqual(_rawTab('INVENTORY', 'FURNITURE').find(r => r[0] === 'TABLE-001')[1], '', 'nothing written');
});

test('THUMBNAIL COLUMN', 'migration fills the item and category cells', async () => {
    await _withRestoredTabs([['INVENTORY', 'FURNITURE'], ['CACHE', 'Inventory']], async () => {
        await migrateThumbnails({ dryRun: false });
        const table = (await Requests.getInventoryTabData('FURNITURE')).find(r => r.itemNumber === 'TABLE-001');
        assertEqual(table.thumbnail, '["file_id_table_001"]', 'TABLE-001 filled');
        const categories = (await Requests.getCategoryThumbnails()).map(c => c.prefix).sort();
        assertEqual(categories, ['BX', 'CHAIR', 'TABLE'], 'category images');
        assertEqual(_rawTab('INVENTORY', 'FURNITURE').find(r => r[0] === 'TABLE-001')[7], 'Legs in bag', 'other cells untouched');
    });
});

// ── Group 26b: New-Row History and List Origins ──────────────────────────────
// A new row's first save always records a creation marker (c: []), also when it arrives carrying
// history (pasted, moved in) or is saved without a user or by a scheduled save.
// EditHistoryUtils.listItemOrigins finds when each item of a list field (a thumbnail gallery)
// entered the history. The marker tests use a scratch PACK_LISTS tab (_MARKER_TEST) and the
// FURNITURE fixture (restored afterwards).

test('NEW ROW HISTORY', 'history gives when and by whom each image was added', async () => {
    const h = [
        { u: 'sam', t: 300, c: [{ n: 'thumbnail', o: '["a","b"]' }] },
        { u: 'dan', t: 200, c: [{ n: 'quantity', o: '1' }] },
        { u: 'kim', t: 100, c: [{ n: 'thumbnail', o: '["a"]' }] },
        { u: 'lee', t: 50, c: [] }
    ];
    const origins = EditHistoryUtils.listItemOrigins(_eh({ i: 1, h }), 'thumbnail', '["a","b","c"]', parseThumbnails);
    assertEqual(Object.fromEntries(origins), {
        a: { u: 'lee', t: 50, created: true },
        b: { u: 'kim', t: 100, created: false },
        c: { u: 'sam', t: 300, created: false }
    }, 'each image');
    const capped = EditHistoryUtils.listItemOrigins(_eh({ i: 1, h: h.slice(0, 3) }), 'thumbnail', '["a","b","c"]', parseThumbnails);
    assertEqual(capped.get('a'), null, 'before the recorded history');
    const carried = EditHistoryUtils.listItemOrigins(_eh({ i: 1, h: [{ u: 'mover', t: 400, c: [] }, { u: 'kim', t: 100, c: [{ n: 'thumbnail', o: '' }] }] }), 'thumbnail', '["a"]', parseThumbnails);
    assertEqual(carried.get('a'), { u: 'kim', t: 100, created: false }, 'history carried in below a creation marker wins');
});

const _MARKER_TAB = '_MARKER_TEST';
const _markerRead = async () => (await Database.getData('PACK_LISTS', _MARKER_TAB, _HISTORY_MAPPING)).map(r => ({ ...r }));

test('NEW ROW HISTORY', "a new row's first save always records a creation marker", async () => {
    await Database.setData('PACK_LISTS', _MARKER_TAB, [_row('A', '1')], _HISTORY_MAPPING, { skipMetadata: true });
    const rows = await _markerRead();
    const pasted = { name: 'X', qty: '2', edithistory: _eh({ h: [{ u: 'old', t: 5, c: [{ n: 'qty', o: '1' }] }] }) };
    const moved = { name: 'Y', qty: '3', edithistory: _eh({ i: 99, h: [{ u: 'old', t: 6, c: [] }] }) };
    await Database.setData('PACK_LISTS', _MARKER_TAB, [...rows, pasted, moved], _HISTORY_MAPPING, { username: 'test@example.com', source: 'web' });
    const saved = await _markerRead();
    const x = _parsed(saved[1]);
    assertEqual([x.i > 0, x.h.map(e => [e.u, e.c])], [true, [['test', []], ['old', [{ n: 'qty', o: '1' }]]]], 'pasted row: marker above its carried history');
    const y = _parsed(saved[2]);
    assertEqual([y.i, y.h.map(e => [e.u, e.c])], [99, [['test', []], ['old', []]]], 'moved row keeps its identity, gains a marker');
    await Database.setData('PACK_LISTS', _MARKER_TAB, [...saved, _row('Z', '4')], _HISTORY_MAPPING, { source: 'web' });
    assertEqual(_parsed((await _markerRead())[3]).h.map(e => e.u), ['unknown'], 'a save without a user still marks creation');
});

test('NEW ROW HISTORY', 'a scheduled save gives a new row its identity and creation marker', async () => {
    await _withRestoredTabs([['INVENTORY', 'FURNITURE']], async () => {
        const rows = (await Requests.getInventoryTabData('FURNITURE')).map(r => ({ ...r }));
        rows.push({ itemNumber: 'STOOL-009', quantity: '4', description: 'Folding stool', notes: '', thumbnail: '["file_new"]', edithistory: '' });
        await _asUser(() => Requests.saveInventoryTabData(rows, 'FURNITURE', undefined, undefined, undefined, { scheduledDate: '2099-01-01', note: 'arrives' }));
        const saved = await Requests.getInventoryTabData('FURNITURE');
        const eh = _parsed(saved.find(r => r.itemNumber === 'STOOL-009'));
        const highest = Math.max(...saved.filter(r => r.itemNumber !== 'STOOL-009').map(r => _parsed(r).i || 0));
        assertEqual([eh.i, eh.h.map(e => [e.u, e.c]), eh.p.length], [highest + 1, [['test', []]], 1], 'next identity, marker and the pending change');
    });
});

// ── Group 26c: Thumbnail Gallery ──────────────────────────────────────────────
// A thumbnail cell is a gallery: images as file IDs, or { id, note, crop } objects; the first is the
// primary (the icon). When each image entered the item's history comes from its EditHistory
// (EditHistoryUtils.listItemOrigins). FakeGoogle: FURNITURE CHAIR-002 holds
// ['file_id_chair_002', { id: 'file_id_chair_001', note: 'Side view', crop: { x: 0.25, y: 0, w: 0.5, h: 1 } }]
// and one history entry: sam (t 17912947200) changed thumbnail from '["file_id_chair_002"]'.

test('THUMBNAIL GALLERY', 'images with notes and crops parse and write compactly', async () => {
    assertEqual(parseThumbnailEntries('["a", {"id": "b", "note": " n ", "crop": {"x": 0, "y": 0, "w": 1, "h": 1}}]'),
        [{ id: 'a' }, { id: 'b', note: 'n' }], 'note trimmed, whole-image crop dropped');
    assertEqual(serializeThumbnailEntries([{ id: 'a' }, { id: 'b', note: 'n' }]), '["a",{"id":"b","note":"n"}]', 'plain images stay bare IDs');
    assertEqual(primaryThumbnailValue('[{"id":"a","note":"n","crop":{"x":0.1,"y":0,"w":0.5,"h":1}},"b"]'),
        '[{"id":"a","crop":{"x":0.1,"y":0,"w":0.5,"h":1}}]', 'icon: primary file and crop, no note');
    assertEqual(thumbnailKey('a', { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }), 'a#0.1,0.2,0.5,0.5', 'cache key with crop');
    assertEqual(thumbnailKey('a', null), 'a', 'cache key without crop');
});

test('THUMBNAIL GALLERY', 'gallery edits add, remove, reorder, note and crop', async () => {
    assertEqual(addThumbnails('["a"]', ['b', 'a']), '["a","b"]', 'add at the end, no duplicates');
    assertEqual(addThumbnails('', ['a', 'b']), '["a","b"]', 'first added becomes the primary');
    assertEqual(removeThumbnailAt('["a","b","c"]', 1), '["a","c"]', 'remove');
    assertEqual(setPrimaryThumbnail('["a","b","c"]', 2), '["c","a","b"]', 'set as thumbnail moves it first');
    const noted = setThumbnailNote('["a"]', 0, 'front');
    assertEqual(noted, '[{"id":"a","note":"front"}]', 'note');
    assertEqual(setThumbnailNote(noted, 0, ''), '["a"]', 'blank note clears it');
    assertEqual(setThumbnailCrop('["a"]', 0, { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }), '[{"id":"a","crop":{"x":0.1,"y":0.2,"w":0.5,"h":0.5}}]', 'crop');
    assertEqual(setThumbnailCrop('[{"id":"a","crop":{"x":0.1,"y":0.2,"w":0.5,"h":0.5}}]', 0, null), '["a"]', 'crop cleared');
});

test('THUMBNAIL GALLERY', 'the CHAIR-002 gallery reads its images, note, crop and origins', async () => {
    const row = (await Requests.getInventoryTabData('FURNITURE')).find(r => r.itemNumber === 'CHAIR-002');
    assertEqual(parseThumbnailEntries(row.thumbnail), [{ id: 'file_id_chair_002' }, { id: 'file_id_chair_001', note: 'Side view', crop: { x: 0.25, y: 0, w: 0.5, h: 1 } }], 'entries');
    const origins = EditHistoryUtils.listItemOrigins(row.edithistory, 'thumbnail', row.thumbnail, parseThumbnails);
    assertEqual(origins.get('file_id_chair_001'), { u: 'sam', t: 17912947200, created: false }, 'added by sam');
    assertEqual(origins.get('file_id_chair_002'), null, 'primary predates the history');
});

// ── Group 26: Row-Based Transship and Date Normalization ──────────────────────
// getTransshipSourceForScheduleRow / getTransshipDestinationsForScheduleRow accept
// a schedule row object instead of a canonical identifier. guessShipDate,
// normalizeStartDate, and normalizeEndDate apply year context to partial date strings.

test('ROW TRANSSHIP AND DATES', 'getTransshipSourceForScheduleRow from Summer Show row returns SPRING EXPO', async () => {
    const result = await Requests.getTransshipSourceForScheduleRow({
        Show: 'Summer Show', Client: 'ChainCo', Year: '2026'
    });
    assertEqual(result, 'CHAINCO 2026 SPRING EXPO', 'getTransshipSourceForScheduleRow(Summer Show)');
});

test('ROW TRANSSHIP AND DATES', 'getTransshipDestinationsForScheduleRow from Spring Expo row returns SUMMER SHOW', async () => {
    const result = await Requests.getTransshipDestinationsForScheduleRow({
        Show: 'Spring Expo', Client: 'ChainCo', Year: '2026'
    });
    assertEqual(result, 'CHAINCO 2026 SUMMER SHOW', 'getTransshipDestinationsForScheduleRow(Spring Expo)');
});

test('ROW TRANSSHIP AND DATES', 'guessShipDate returns full MM/DD/YYYY for explicit ship date', async () => {
    const result = await Requests.guessShipDate({
        Ship: '3/1/2026', Year: '2026', 'S. Start': '3/8', 'S. End': '3/11'
    });
    assertEqual(result, '03/01/2026', 'guessShipDate with explicit Ship field');
});

test('ROW TRANSSHIP AND DATES', 'normalizeStartDate returns full MM/DD/YYYY', async () => {
    const result = await Requests.normalizeStartDate({
        'S. Start': '3/8', 'S. End': '3/11', Year: '2026'
    });
    assertEqual(result, '03/08/2026', 'normalizeStartDate M/D with Year context');
});

test('ROW TRANSSHIP AND DATES', 'normalizeEndDate returns full MM/DD/YYYY', async () => {
    const result = await Requests.normalizeEndDate({
        'S. Start': '3/8', 'S. End': '3/11', Year: '2026'
    });
    assertEqual(result, '03/11/2026', 'normalizeEndDate M/D with Year context');
});

// ── Group 27: Packlist Convenience Queries ────────────────────────────────────

test('PACKLIST QUERIES', 'getPacklists with show-all returns non-empty array', async () => {
    const result = await Requests.getPacklists({ type: 'show-all' });
    if (!Array.isArray(result) || result.length === 0) throw new Error('expected non-empty packlists array');
});

test('PACKLIST QUERIES', 'getPacklists with null returns empty array by design', async () => {
    const result = await Requests.getPacklists(null);
    assertEqual(result.length, 0, 'getPacklists(null) should return empty array');
});

test('PACKLIST QUERIES', 'getItemHeaders returns array including Description', async () => {
    const result = await Requests.getItemHeaders('CHAINCO 2026 SPRING EXPO');
    if (!Array.isArray(result)) throw new Error('expected array from getItemHeaders');
    assertContains(result, 'Description', 'item headers must include Description');
});

test('PACKLIST QUERIES', 'resolvePacklistIdentifier returns canonical tab title', async () => {
    const result = await Requests.resolvePacklistIdentifier('CHAINCO 2026 SPRING EXPO');
    assertEqual(result, 'CHAINCO 2026 SPRING EXPO', 'resolvePacklistIdentifier canonical title');
});

test('PACKLIST QUERIES', 'getPacklistDescription returns string containing crate count', async () => {
    const result = await Requests.getPacklistDescription('CHAINCO 2026 SPRING EXPO');
    if (typeof result !== 'string' || result.length === 0) throw new Error(`expected non-empty string, got: ${JSON.stringify(result)}`);
    if (!result.includes('crate')) throw new Error(`expected "crate" in description, got: ${result}`);
});

test('PACKLIST QUERIES', 'getPacklistScheduleAttachment returns attached for known packlist', async () => {
    const result = await Requests.getPacklistScheduleAttachment('CHAINCO 2026 SPRING EXPO');
    assertEqual(result?.attached, true, 'CHAINCO 2026 SPRING EXPO must be attached');
});

test('PACKLIST QUERIES', 'getPacklistScheduleAttachment returns not-attached for _TEMPLATE', async () => {
    const result = await Requests.getPacklistScheduleAttachment('_TEMPLATE');
    assertEqual(result?.attached, false, '_TEMPLATE must not be attached');
    assertEqual(result?.hasIdentifierParts, false, '_TEMPLATE has no identifier structure');
});

// ── Group 28: Schedule Index Queries ─────────────────────────────────────────

test('SCHEDULE INDEX', 'getNameOverrides returns an array', async () => {
    const result = await Requests.getNameOverrides();
    if (!Array.isArray(result)) throw new Error(`expected array, got ${typeof result}`);
});

test('SCHEDULE INDEX', 'getAllScheduleIdentifiers includes CHAINCO 2026 SPRING EXPO', async () => {
    const result = await Requests.getAllScheduleIdentifiers();
    assertContains(result, 'CHAINCO 2026 SPRING EXPO', 'getAllScheduleIdentifiers must include SPRING EXPO');
});

test('SCHEDULE INDEX', 'getUnattachedPacklistTabNames does not include matched SPRING EXPO', async () => {
    const result = await Requests.getUnattachedPacklistTabNames();
    if (!Array.isArray(result)) throw new Error('expected array from getUnattachedPacklistTabNames');
    assertNotContains(result, 'CHAINCO 2026 SPRING EXPO', 'SPRING EXPO is attached and must not appear as unattached');
});

test('SCHEDULE INDEX', 'getOverrideTargets with packlist source returns schedule identifiers', async () => {
    const result = await Requests.getOverrideTargets('packlist');
    assertContains(result, 'CHAINCO 2026 SPRING EXPO', 'packlist override targets must include schedule identifiers');
});

test('SCHEDULE INDEX', 'getOverrideTargets with schedule source returns unattached packlists', async () => {
    const result = await Requests.getOverrideTargets('schedule');
    if (!Array.isArray(result)) throw new Error('expected array from getOverrideTargets(schedule)');
});

// ── Group 29: Locking Convenience Wrappers ────────────────────────────────────
// getPacklistLock and getInventoryLock are thin wrappers over getSheetLock with
// the spreadsheet name pre-filled. FakeGoogle has locks for both.

test('LOCK WRAPPERS', 'getPacklistLock returns lock for ATSC 2025 NAB', async () => {
    const result = await Requests.getPacklistLock('ATSC 2025 NAB');
    if (!result) throw new Error('expected lock object for ATSC 2025 NAB packlist');
    if (!result.user) throw new Error('expected lock to have user field');
});

test('LOCK WRAPPERS', 'getInventoryLock returns lock for CABINETS', async () => {
    const result = await Requests.getInventoryLock('CABINETS');
    if (!result) throw new Error('expected lock object for CABINETS inventory');
});

test('LOCK WRAPPERS', 'getInventoryLock returns null for unlocked category', async () => {
    const result = await Requests.getInventoryLock('FURNITURE');
    assertEqual(result, null, 'FURNITURE has no lock in FakeGoogle');
});

// ── Group 30: Nonstandard Item Number Extraction ──────────────────────────────
// extractCustomItemFromText scans the tabs listed in InventoryCustomItemNumbers (HARDWARE
// in FakeGoogle) for matching item numbers using pattern matching against non-standard
// item codes. FakeGoogle HARDWARE tab has
// '901 00 030 MKII' and 'HH BOLTHOG M8 LONG' as known fixtures.

test('HARDWARE EXTRACTION', '901 00 030 MKII extracted with correct quantity', async () => {
    const result = await Requests.extractCustomItemFromText('(10) 901 00 030 MKII Mounting brackets');
    assertEqual(result.quantity, 10, 'extractCustomItemFromText quantity');
    assertEqual(result.itemNumber, '901 00 030 MKII', 'extractCustomItemFromText itemNumber');
});

test('HARDWARE EXTRACTION', 'HH BOLTHOG M8 LONG extracted with correct quantity', async () => {
    const result = await Requests.extractCustomItemFromText('(3) HH BOLTHOG M8 LONG Long bolts');
    assertEqual(result.quantity, 3, 'HH BOLTHOG M8 LONG quantity');
    assertEqual(result.itemNumber, 'HH BOLTHOG M8 LONG', 'HH BOLTHOG M8 LONG itemNumber');
});

test('HARDWARE EXTRACTION', 'text with no hardware returns null itemNumber', async () => {
    const result = await Requests.extractCustomItemFromText('plain text no hardware here');
    assertEqual(result.itemNumber, null, 'no hardware match returns null itemNumber');
});

// ── Group 31: Description Match ───────────────────────────────────────────────
// checkDescriptionMatch compares a packlist description against the inventory
// description for the same item and returns null on good match, alert on mismatch.

test('DESCRIPTION MATCH', 'exact inventory description returns null (no alert)', async () => {
    const result = await Requests.checkDescriptionMatch({
        'Extracted Item': 'TABLE-001',
        Description: 'Conference room table black 30 x 76 x 30'
    });
    assertEqual(result, null, 'exact description match should return null alert');
});

test('DESCRIPTION MATCH', 'unrelated description returns non-null alert', async () => {
    const result = await Requests.checkDescriptionMatch({
        'Extracted Item': 'TABLE-001',
        Description: 'rotating bar stool chrome legs adjustable height pneumatic'
    });
    if (!result) throw new Error('expected alert for mismatched description, got null');
    if (!result.type) throw new Error('alert must have a type field');
});

// ── Group 32: Inventory Level Check ──────────────────────────────────────────
// checkInventoryLevel returns null for items in skipped tabs and an alert for shortages.
// FURNITURE is in InventorySuppressCategoryAnalysis preference; TABLE-001 maps to FURNITURE.
// CAB-004 during ATSC 2025 NAB window: 10 in stock, 22 needed (11 ATSC + 11 GEARFIRE same day).

test('INVENTORY LEVEL CHECK', 'item in a skipped tab returns null', async () => {
    // TABLE-001 is in FURNITURE, which InventorySuppressCategoryAnalysis lists
    const result = await Requests.checkInventoryLevel(
        { 'Extracted Item': 'TABLE-001' },
        'CHAINCO 2026 SPRING EXPO'
    );
    assertEqual(result, null, 'TABLE-001 (FURNITURE skipped) must return null');
});

test('INVENTORY LEVEL CHECK', 'oversold CAB-004 during ATSC NAB returns shortage alert', async () => {
    // 10 CAB-004 in stock; ATSC NAB + GEARFIRE SHOT ship 22 on same date
    const result = await Requests.checkInventoryLevel(
        { 'Extracted Item': 'CAB-004' },
        'ATSC 2025 NAB'
    );
    if (!result) throw new Error('expected shortage alert for CAB-004 in ATSC 2025 NAB');
    assertEqual(result.type, 'item shortage', 'CAB-004 shortage alert type');
});

// ── Group 33: Page Notes ──────────────────────────────────────────────────────

test('PAGE NOTES', 'getPageNotes returns an array', async () => {
    // FakeGoogle Notes tab has only headers and no data rows
    const result = await Requests.getPageNotes();
    if (!Array.isArray(result)) throw new Error(`expected array, got ${typeof result}`);
});

// ── Group 34: Cache Invalidation ─────────────────────────────────────────────
// Each test warms an API cache entry, subscribes to CacheInvalidationBus,
// calls a mutation, then asserts that the correct api:* event fired.
// The bus fires synchronously inside invalidate(), so events are always
// captured before the mutation's await resolves — no timing gaps.
// Mutations use round-trip saves (read → write same data back) to stay
// idempotent: calculateRowDiff returns empty changes, so no history entry
// is appended. The first round-trip of a tab assigns EditHistory.i to rows
// that lack it (first touch); field values in mockData are unchanged.

test('CACHE INVALIDATION', 'savePackList fires getPackList invalidation', async () => {
    await Requests.getPackList('CHAINCO 2026 SPRING EXPO'); // warm: registers dependency chain
    const fired = new Set();
    const handler = (e) => fired.add(e.methodName);
    CacheInvalidationBus.on('api', handler);
    try {
        const crates = await Requests.getPackList('CHAINCO 2026 SPRING EXPO');
        await Requests.savePackList(crates, 'CHAINCO 2026 SPRING EXPO');
    } finally {
        CacheInvalidationBus.off('api', handler);
    }
    if (!fired.has('getPackList'))
        throw new Error(`savePackList did not invalidate getPackList; fired: ${[...fired].join(', ')}`);
});

test('CACHE INVALIDATION', 'storeUserData fires getUserData invalidation', async () => {
    await Requests.getUserData('test@example.com', 'dashboard_containers'); // warm
    const fired = new Set();
    const handler = (e) => fired.add(e.methodName);
    CacheInvalidationBus.on('api', handler);
    try {
        // isolated throwaway key — no effect on other tests' user data
        await Requests.storeUserData([{ v: 'cache_test' }], 'test@example.com', 'cache_invalidation_test_key');
    } finally {
        CacheInvalidationBus.off('api', handler);
    }
    if (!fired.has('getUserData'))
        throw new Error(`storeUserData did not invalidate getUserData; fired: ${[...fired].join(', ')}`);
});

test('CACHE INVALIDATION', 'saveInventoryTabData fires getInventoryInfo invalidation', async () => {
    await Requests.getInventoryInfo('TABLE-001', ['quantity']); // warm: registers full dependency chain
    const fired = new Set();
    const handler = (e) => fired.add(e.methodName);
    CacheInvalidationBus.on('api', handler);
    try {
        const rows = await Requests.getInventoryTabData('FURNITURE');
        await Requests.saveInventoryTabData(rows, 'FURNITURE'); // round-trip: empty diff → no edithistory change
    } finally {
        CacheInvalidationBus.off('api', handler);
    }
    if (!fired.has('getInventoryInfo'))
        throw new Error(`saveInventoryTabData did not invalidate getInventoryInfo; fired: ${[...fired].join(', ')}`);
});

test('CACHE INVALIDATION', 'createNewTab (tab mutation) fires getItemTimeline invalidation', async () => {
    // warm: Phase 4 of getItemTimeline calls extractChainItemsForIdentifier which calls
    // extractAllItemsForShow which calls deps.call(Database.getTabs, 'PACK_LISTS') —
    // this registers Database.getTabs as a transitive dependency of getItemTimeline.
    await Requests.getItemTimeline('TABLE-001', '2026-02-15', '2026-06-30');
    const fired = new Set();
    const handler = (e) => fired.add(e.methodName);
    CacheInvalidationBus.on('api', handler);
    try {
        // hidden tab (starts with _) — excluded from getAvailableTabs(false) and getPacklists
        await Requests.createNewTab('PACK_LISTS', '_TEMPLATE', '_CACHE_INVALIDATION_TEST');
    } finally {
        CacheInvalidationBus.off('api', handler);
    }
    if (!fired.has('getItemTimeline'))
        throw new Error(`createNewTab did not invalidate getItemTimeline; fired: ${[...fired].join(', ')}`);
    if (!fired.has('getAvailableTabs'))
        throw new Error(`createNewTab did not invalidate getAvailableTabs; fired: ${[...fired].join(', ')}`);
});

test('CACHE INVALIDATION', 'setTransshipLink fires getTransshipSourceForShow and getItemTimeline invalidation', async () => {
    // warm: Phase 4 calls getTransshipSourceForShow via deps, registering ScheduleOverrides dependency
    await Requests.getTransshipSourceForShow('CHAINCO 2026 SUMMER SHOW');
    await Requests.getItemTimeline('TABLE-001', '2026-02-15', '2026-06-30');
    const fired = new Set();
    const handler = (e) => fired.add(e.methodName);
    CacheInvalidationBus.on('api', handler);
    try {
        // fake identifiers — no real show rows, safe to create and remove
        await Requests.setTransshipLink('FAKE CACHE TEST DEST 9999', 'FAKE CACHE TEST SRC 9999');
    } finally {
        CacheInvalidationBus.off('api', handler);
        await Requests.removeTransshipLink('FAKE CACHE TEST DEST 9999').catch(() => {});
    }
    if (!fired.has('getTransshipSourceForShow'))
        throw new Error(`setTransshipLink did not invalidate getTransshipSourceForShow; fired: ${[...fired].join(', ')}`);
    if (!fired.has('getItemTimeline'))
        throw new Error(`setTransshipLink did not invalidate getItemTimeline; fired: ${[...fired].join(', ')}`);
});

test('CACHE INVALIDATION', 'addNameOverride fires getPacklistScheduleAttachment and getShowDetails invalidation', async () => {
    // warm: getNameOverrides must return non-empty so database:getData result gets cached
    // (CacheManager skips caching empty arrays, which breaks the invalidation cascade).
    // The sentinel row in FakeGoogle.NameOverrides ensures this.
    await Requests.getNameOverrides();
    await Requests.getPacklistScheduleAttachment('CHAINCO 2026 SPRING EXPO');
    await Requests.getShowDetails('CHAINCO 2026 SPRING EXPO');
    const fired = new Set();
    const handler = (e) => fired.add(e.methodName);
    CacheInvalidationBus.on('api', handler);
    try {
        // fake identifiers — no real schedule/packlist row to match, safe to add
        await Requests.addNameOverride('FAKE SCHED 9999', 'FAKE PACK 9999');
    } finally {
        CacheInvalidationBus.off('api', handler);
    }
    if (!fired.has('getPacklistScheduleAttachment'))
        throw new Error(`addNameOverride did not invalidate getPacklistScheduleAttachment; fired: ${[...fired].join(', ')}`);
    if (!fired.has('getShowDetails'))
        throw new Error(`addNameOverride did not invalidate getShowDetails; fired: ${[...fired].join(', ')}`);
});

test('CACHE INVALIDATION', 'appendScheduleReferenceAbbreviation fires computeIdentifier and getShowDetails invalidation', async () => {
    // warm: computeIdentifier calls computeIdentifierReferenceData which calls
    // deps.call(Database.getData, 'CACHE', 'Shows', ...) — registers Shows as dependency
    await Requests.computeIdentifier('Spring Expo', 'ChainCo', '2026');
    await Requests.getShowDetails('CHAINCO 2026 SPRING EXPO');
    const fired = new Set();
    const handler = (e) => fired.add(e.methodName);
    CacheInvalidationBus.on('api', handler);
    try {
        // isolated fake entry — distinct name/abbr ensures no collision with existing index entries
        await Requests.appendScheduleReferenceAbbreviation('show', 'FAKE SHOW FOR CACHE TEST 2099', 'FS2099');
    } finally {
        CacheInvalidationBus.off('api', handler);
    }
    if (!fired.has('computeIdentifier'))
        throw new Error(`appendScheduleReferenceAbbreviation did not invalidate computeIdentifier; fired: ${[...fired].join(', ')}`);
    if (!fired.has('getShowDetails'))
        throw new Error(`appendScheduleReferenceAbbreviation did not invalidate getShowDetails; fired: ${[...fired].join(', ')}`);
});

test('CACHE INVALIDATION', 'remote Caching-tab timestamp for getTabs fires getPacklists via poller', async () => {
    // warm: PackListUtils.getPacklists calls deps.call(Database.getTabs, 'PACK_LISTS'),
    // registering database:getTabs:"PACK_LISTS" as a dependency of api:getPacklists.
    await Requests.getPacklists({ type: 'show-all' });

    // Simulate a remote write: writeCacheTimestamp adds +1s to Date.now() so the
    // poller's (remoteTs > entry.filled) comparison is always true.
    await ApplicationUtils.writeCacheTimestamp('database:getTabs:"PACK_LISTS"');

    const fired = new Set();
    const handler = (e) => fired.add(e.methodName);
    CacheInvalidationBus.on('api', handler);
    try {
        // triggerCachePoll() runs the interval logic immediately: reads CACHE/Caching,
        // finds the newer timestamp, and calls CacheManager.invalidateByPrefix which
        // cascades through the dependency chain to api:getPacklists.
        await triggerCachePoll();
    } finally {
        CacheInvalidationBus.off('api', handler);
    }
    if (!fired.has('getPacklists'))
        throw new Error(`poller did not invalidate getPacklists; fired: ${[...fired].join(', ')}`);
});

// ── Group: Google requests ────────────────────────────────────────────────────
// FakeGoogle CACHE/Clients: headers Clients | Abbreviations | Notes, first row ABCAM,
// AUSTAL USA abbreviated AUSTAL. A tab read unmapped and under two mappings is one sheet read.

/** Run fn(reads) while counting sheet reads of one tab; reads() is the count so far. */
async function _countSheetReads(db, tab, fn) {
    const original = FakeGoogleSheetsService.getSheetData;
    let count = 0;
    FakeGoogleSheetsService.getSheetData = async function (tableId, range) {
        if (tableId === db && range === tab) count++;
        return original.call(this, tableId, range);
    };
    try {
        return await fn(() => count);
    } finally {
        FakeGoogleSheetsService.getSheetData = original;
    }
}

test('GOOGLE REQUESTS', 'a tab read unmapped and under two mappings is one sheet read', async () => {
    invalidateCache([{ namespace: 'database', methodName: 'getData', args: ['CACHE', 'Clients'] }], true);
    await _withRestoredTabs([['CACHE', 'Clients']], () => _countSheetReads('CACHE', 'Clients', async (reads) => {
        const raw = await Database.getData('CACHE', 'Clients');
        const names = await Database.getData('CACHE', 'Clients', { name: 'Clients' });
        const full = await Database.getData('CACHE', 'Clients', { name: 'Clients', abbr: 'Abbreviations' });
        assertEqual(reads(), 1, 'sheet reads');
        assertEqual([raw[1][0], names[0].name, full.find(r => r.name === 'AUSTAL USA').abbr], ['ABCAM', 'ABCAM', 'AUSTAL'], 'values');
    }));
});

test('GOOGLE REQUESTS', 'a mapped read sees the change after its tab is invalidated', async () => {
    await _withRestoredTabs([['CACHE', 'Clients']], () => _countSheetReads('CACHE', 'Clients', async (reads) => {
        await Database.getData('CACHE', 'Clients', { name: 'Clients' });
        _rawTab('CACHE', 'Clients')[1][0] = 'ABCAM RENAMED';
        // As a write to the tab, or the poller, invalidates it
        invalidateCache([{ namespace: 'database', methodName: 'getData', args: ['CACHE', 'Clients'] }], true);
        const names = await Database.getData('CACHE', 'Clients', { name: 'Clients' });
        assertEqual([names[0].name, reads()], ['ABCAM RENAMED', 2], 'fresh value, one more read');
    }));
});

// User data writes made at the same moment are one write of the user's tab
// (CACHE/UserData_test_example_com), applied in call order.
const USER_TAB = 'UserData_test_example_com';

/** Run fn(writes) while counting whole-tab writes of one tab; writes() is the count so far. */
async function _countTabWrites(db, tab, fn) {
    const original = FakeGoogleSheetsService.setSheetData;
    let count = 0;
    FakeGoogleSheetsService.setSheetData = async function (tableId, range, ...rest) {
        if (tableId === db && range === tab) count++;
        return original.call(this, tableId, range, ...rest);
    };
    try {
        return await fn(() => count);
    } finally {
        FakeGoogleSheetsService.setSheetData = original;
    }
}

test('GOOGLE REQUESTS', 'user data stored at the same moment is one write, applied in order', async () => {
    await _withRestoredTabs([['CACHE', USER_TAB]], () => _countTabWrites('CACHE', USER_TAB, async (writes) => {
        await Promise.all([
            Requests.storeUserData({ n: 1 }, 'test@example.com', 'batch_test_a'),
            Requests.storeUserData({ n: 2 }, 'test@example.com', 'batch_test_b'),
            Requests.storeUserData({ n: 3 }, 'test@example.com', 'batch_test_a'),
            Requests.storeUserData({ n: 4 }, 'test@example.com', 'batch_test_c'),
            Requests.storeUserData(null, 'test@example.com', 'batch_test_c')
        ]);
        assertEqual(writes(), 1, 'tab writes');
        const stored = Object.fromEntries(_rawTab('CACHE', USER_TAB).filter(r => String(r[0]).startsWith('batch_test_')).map(r => [r[0], r[1]]));
        assertEqual(stored, { batch_test_a: '{"n":3}', batch_test_b: '{"n":2}' }, 'stored rows');
    }));
});

test('GOOGLE REQUESTS', 'user data stored while the tab is being written is kept', async () => {
    // The first write of the tab waits until the second call has been made
    const original = FakeGoogleSheetsService.setSheetData;
    let release, started;
    const gate = new Promise(resolve => release = resolve);
    const firstStarted = new Promise(resolve => started = resolve);
    let writes = 0;
    FakeGoogleSheetsService.setSheetData = async function (tableId, range, ...rest) {
        if (tableId === 'CACHE' && range === USER_TAB && writes++ === 0) {
            started();
            await gate;
        }
        return original.call(this, tableId, range, ...rest);
    };
    try {
        await _withRestoredTabs([['CACHE', USER_TAB]], async () => {
            const first = Requests.storeUserData('one', 'test@example.com', 'batch_test_a');
            await firstStarted;
            const second = Requests.storeUserData('two', 'test@example.com', 'batch_test_b');
            release();
            await Promise.all([first, second]);
            const stored = Object.fromEntries(_rawTab('CACHE', USER_TAB).filter(r => String(r[0]).startsWith('batch_test_')).map(r => [r[0], r[1]]));
            assertEqual([stored, writes], [{ batch_test_a: 'one', batch_test_b: 'two' }, 2], 'both rows, two writes');
        });
    } finally {
        FakeGoogleSheetsService.setSheetData = original;
    }
});

// ── Group: Spreadsheet watch ──────────────────────────────────────────────────
// Each poll reads the spreadsheets' Drive modifiedTime (FakeGoogleSheetsService.touch is a hand
// edit). FakeGoogle PROD_SCHED/Production Schedule row 1 is ALLEN ARMS 2025 SHOT, City
// "Las Vegas, NV" (column 4); PACK_LISTS/ATSC 2025 NAB is read unmapped.

test('SPREADSHEET WATCH', 'an unchanged schedule stays cached; a hand edit is re-read once, at the next poll', async () => {
    await _withRestoredTabs([['PROD_SCHED', 'Production Schedule']], () => _countSheetReads('PROD_SCHED', 'Production Schedule', async (reads) => {
        await triggerCachePoll();
        await Database.getData('PROD_SCHED', 'Production Schedule');
        const base = reads();
        await triggerCachePoll();
        await Database.getData('PROD_SCHED', 'Production Schedule');
        assertEqual(reads(), base, 'reads while unchanged');

        _rawTab('PROD_SCHED', 'Production Schedule')[1][4] = 'Reno, NV';
        FakeGoogleSheetsService.touch('PROD_SCHED');
        await triggerCachePoll();
        const rows = await Database.getData('PROD_SCHED', 'Production Schedule');
        await triggerCachePoll();
        await Database.getData('PROD_SCHED', 'Production Schedule');
        assertEqual([rows[1][4], reads()], ['Reno, NV', base + 1], 'edited value, one read');
    }));
});

test('SPREADSHEET WATCH', 'a pack list change with no stamp expires its cached reads after one more poll', async () => {
    const TAB = 'ATSC 2025 NAB';
    await _withRestoredTabs([['PACK_LISTS', TAB]], () => _countSheetReads('PACK_LISTS', TAB, async (reads) => {
        await triggerCachePoll();
        await Database.getData('PACK_LISTS', TAB);
        const base = reads();
        const sheet = _rawTab('PACK_LISTS', TAB);
        sheet[1][0] = `${sheet[1][0]} EDITED`;
        // Changed long after any stamp of the table
        const later = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        await withFaults({ beforeModifiedTimes: () => ({ PACK_LISTS: later }) }, async () => {
            await triggerCachePoll();
            await Database.getData('PACK_LISTS', TAB);
            assertEqual(reads(), base, 'still cached at the poll that saw the change');
            await triggerCachePoll();
        });
        const rows = await Database.getData('PACK_LISTS', TAB);
        assertEqual([rows[1][0], reads()], [sheet[1][0], base + 1], 'expired, then read once');
        await triggerCachePoll(); // back to the real modifiedTime
    }));
});

test('SPREADSHEET WATCH', 'a stamped pack list change is re-read once', async () => {
    const TAB = 'ATSC 2025 NAB';
    await _withRestoredTabs([['PACK_LISTS', TAB]], () => _countSheetReads('PACK_LISTS', TAB, async (reads) => {
        await triggerCachePoll();
        await Database.getData('PACK_LISTS', TAB);
        const base = reads();
        const sheet = _rawTab('PACK_LISTS', TAB);
        sheet[1][0] = `${sheet[1][0]} STAMPED`;
        FakeGoogleSheetsService.touch('PACK_LISTS');
        await ApplicationUtils.writeCacheTimestamp(`database:getData:"PACK_LISTS","${TAB}"`);
        await triggerCachePoll();
        const rows = await Database.getData('PACK_LISTS', TAB);
        await triggerCachePoll();
        await Database.getData('PACK_LISTS', TAB);
        assertEqual([rows[1][0], reads()], [sheet[1][0], base + 1], 'stamped value, one read');
    }));
});

test('SPREADSHEET WATCH', 'the Caching tab is read only when it may hold new stamps', async () => {
    await triggerCachePoll();
    await _countSheetReads('CACHE', 'Caching', async (reads) => {
        await triggerCachePoll();
        assertEqual(reads(), 0, 'Caching reads while nothing changed');
        FakeGoogleSheetsService.touch('CACHE');
        await triggerCachePoll();
        assertEqual(reads(), 1, 'Caching reads after the CACHE spreadsheet changed');
        await withFaults({ beforeModifiedTimes: () => { throw new Error('Drive unavailable'); } }, async () => {
            await triggerCachePoll();
            await triggerCachePoll();
        });
        assertEqual(reads(), 3, 'Caching reads at every poll while Drive is unavailable');
    });
});

// ── Group: Change stamps ──────────────────────────────────────────────────────
// Stamps for made-up tabs ("StampTest …") are added to CACHE/Caching and left there.

async function _waitFor(check, label) {
    for (let i = 0; i < 300; i++) {
        const value = await check();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${label}`);
}
const _stampRow = (prefix) => (_rawTab('CACHE', 'Caching') || []).find(row => row[0] === prefix);

test('CHANGE STAMPS', 'a failed read of the Caching tab writes nothing; the next poll writes the stamp', async () => {
    const prefix = 'database:getData:"CACHE","StampTest failed read"';
    await triggerCachePoll();
    const before = JSON.stringify(_rawTab('CACHE', 'Caching'));
    let failed = false;
    FakeGoogleSheetsService.faults = {
        beforeRead: (t, range) => { if (t === 'CACHE' && range === 'Caching' && !failed) { failed = true; throw new Error('read failed'); } }
    };
    try {
        stampDataChange(prefix);
        await _waitFor(() => failed, 'the failed read');
        await new Promise(resolve => setTimeout(resolve, 50));
    } finally {
        FakeGoogleSheetsService.faults = null;
    }
    assertEqual(JSON.stringify(_rawTab('CACHE', 'Caching')), before, 'Caching tab untouched');
    await triggerCachePoll();
    const row = await _waitFor(() => _stampRow(prefix), 'the retried stamp');
    assertEqual(isNaN(new Date(row[1]).getTime()), false, 'stamp has a timestamp');
});

test('CHANGE STAMPS', 'two sessions adding new keys at the same moment each keep their row', async () => {
    const [b, c] = ['database:getData:"CACHE","StampTest session B"', 'database:getData:"CACHE","StampTest session C"'];
    const rowsBefore = _rawTab('CACHE', 'Caching').length;
    const timestamp = new Date().toISOString();
    // Both read the tab before either writes
    await Promise.all([
        ApplicationUtils.writeCacheTimestamps([{ prefix: b, timestamp }]),
        ApplicationUtils.writeCacheTimestamps([{ prefix: c, timestamp }])
    ]);
    assertEqual([!!_stampRow(b), !!_stampRow(c), _rawTab('CACHE', 'Caching').length], [true, true, rowsBefore + 2], 'both rows added');
});

test('CHANGE STAMPS', 'stamps made while a stamp write runs go out together', async () => {
    const prefixes = [1, 2, 3].map(n => `database:getData:"CACHE","StampTest batch ${n}"`);
    const original = FakeGoogleSheetsService.appendSheetValues;
    let appends = 0;
    FakeGoogleSheetsService.appendSheetValues = async function (tableId, range, rows) {
        if (rows.some(row => prefixes.includes(row[0]))) appends++;
        return original.call(this, tableId, range, rows);
    };
    try {
        prefixes.forEach(prefix => stampDataChange(prefix));
        await _waitFor(() => prefixes.every(_stampRow), 'all three stamps');
    } finally {
        FakeGoogleSheetsService.appendSheetValues = original;
    }
    assertLessThan(appends, 3, 'append requests for three stamps');
});

// ── Group: Saves cache what they wrote ────────────────────────────────────────
// A whole-tab write's response is the tab as a read returns it (FakeGoogle: the tab after the
// write), so the save caches it instead of reading the tab again. FakeGoogle CACHE/Clients row 1
// is ABCAM with no abbreviation.
const CLIENTS_MAPPING = { name: 'Clients', abbr: 'Abbreviations' };

test('SAVE CACHING', 'a whole-tab save caches the tab as written: no read follows, before or after the next poll', async () => {
    await _withRestoredTabs([['CACHE', 'Clients']], () => _countSheetReads('CACHE', 'Clients', async (reads) => {
        const rows = (await Database.getData('CACHE', 'Clients', CLIENTS_MAPPING)).map(row => ({ ...row }));
        const base = reads();
        rows[0].abbr = 'ABC';
        await Database.setData('CACHE', 'Clients', rows, CLIENTS_MAPPING, { skipMetadata: true });
        const cached = await Database.getData('CACHE', 'Clients');
        const mapped = await Database.getData('CACHE', 'Clients', CLIENTS_MAPPING);
        assertEqual(reads(), base, 'reads after the save');
        assertEqual(JSON.stringify(cached), JSON.stringify(FakeGoogleSheetsService.getMockData('CACHE', 'Clients')), 'cached tab matches a fresh read');
        assertEqual(mapped[0].abbr, 'ABC', 'mapped read from the cached tab');
        await _waitFor(() => _stampRow('database:getData:"CACHE","Clients"'), 'the save\'s stamp');
        await triggerCachePoll();
        await Database.getData('CACHE', 'Clients');
        assertEqual(reads(), base, 'reads after the poll read our own stamp');
    }));
});

test('SAVE CACHING', 'another session\'s stamp after our save still re-reads the tab once', async () => {
    await _withRestoredTabs([['CACHE', 'Clients']], () => _countSheetReads('CACHE', 'Clients', async (reads) => {
        const rows = await Database.getData('CACHE', 'Clients', CLIENTS_MAPPING);
        const savedAt = Date.now();
        await Database.setData('CACHE', 'Clients', rows, CLIENTS_MAPPING, { skipMetadata: true });
        const base = reads();
        await _waitFor(() => new Date(_stampRow('database:getData:"CACHE","Clients"')?.[1]).getTime() > savedAt, 'our stamp');
        await new Promise(resolve => setTimeout(resolve, 5)); // the other session stamps later than we did
        _rawTab('CACHE', 'Clients')[1][0] = 'ABCAM ELSEWHERE';
        await ApplicationUtils.writeCacheTimestamp('database:getData:"CACHE","Clients"');
        await triggerCachePoll();
        const after = await Database.getData('CACHE', 'Clients', CLIENTS_MAPPING);
        assertEqual([after[0].name, reads()], ['ABCAM ELSEWHERE', base + 1], 'their value, one read');
    }));
});

test('SAVE CACHING', 'when our stamp replaces one we never saw, the tab is re-read once', async () => {
    const prefix = 'database:getData:"CACHE","Clients"';
    await _withRestoredTabs([['CACHE', 'Clients']], () => _countSheetReads('CACHE', 'Clients', async (reads) => {
        await triggerCachePoll();
        const rows = await Database.getData('CACHE', 'Clients', CLIENTS_MAPPING);
        // Our stamp write's read of the Caching tab waits while another session changes the tab
        // and stamps it; our stamp then replaces theirs
        let release, reached, held = false;
        const gate = new Promise(resolve => release = resolve);
        const atRead = new Promise(resolve => reached = resolve);
        FakeGoogleSheetsService.faults = {
            beforeRead: async (t, range) => {
                if (held || t !== 'CACHE' || range !== 'Caching') return;
                held = true;
                reached();
                await gate;
            }
        };
        // Dated apart from ours (stamps are dated a second ahead)
        const theirs = new Date(Date.now() + 500).toISOString();
        try {
            await Database.setData('CACHE', 'Clients', rows, CLIENTS_MAPPING, { skipMetadata: true });
            await atRead;
            _rawTab('CACHE', 'Clients')[1][0] = 'ABCAM ELSEWHERE';
            const row = _stampRow(prefix);
            if (row) row[1] = theirs; else _rawTab('CACHE', 'Caching').push([prefix, theirs]);
        } finally {
            FakeGoogleSheetsService.faults = null;
            release();
        }
        const base = reads();
        await _waitFor(() => _stampRow(prefix)[1] !== theirs, 'our stamp over theirs');
        await triggerCachePoll();
        const after = await Database.getData('CACHE', 'Clients', CLIENTS_MAPPING);
        assertEqual([after[0].name, reads()], ['ABCAM ELSEWHERE', base + 1], 'their value, one read');
    }));
});

test('SAVE CACHING', 'a read in flight from before a save doesn\'t overwrite the saved tab', async () => {
    await _withRestoredTabs([['CACHE', 'Clients']], async () => {
        const rows = (await Database.getData('CACHE', 'Clients', CLIENTS_MAPPING)).map(row => ({ ...row }));
        invalidateCache([{ namespace: 'database', methodName: 'getData', args: ['CACHE', 'Clients'] }], true);
        // The next read of the tab takes its data now and answers only once released
        const original = FakeGoogleSheetsService.getSheetData;
        let release, taken;
        const gate = new Promise(resolve => release = resolve);
        const read = new Promise(resolve => taken = resolve);
        FakeGoogleSheetsService.getSheetData = async function (tableId, range) {
            if (tableId !== 'CACHE' || range !== 'Clients') return original.call(this, tableId, range);
            FakeGoogleSheetsService.getSheetData = original;
            const data = await original.call(this, tableId, range);
            taken();
            await gate;
            return data;
        };
        try {
            const stale = Database.getData('CACHE', 'Clients');
            await read;
            rows[0].abbr = 'SAVED';
            await Database.setData('CACHE', 'Clients', rows, CLIENTS_MAPPING, { skipMetadata: true });
            release();
            await stale;
        } finally {
            FakeGoogleSheetsService.getSheetData = original;
            release();
        }
        const after = await Database.getData('CACHE', 'Clients', CLIENTS_MAPPING);
        assertEqual(after[0].abbr, 'SAVED', 'the saved tab stays cached');
    });
});

test('SAVE CACHING', 'a lock change is still confirmed by a fresh read at the next poll', async () => {
    const user = 'stamp.tester@example.com';
    const tab = 'StampTest lock';
    await _withRestoredTabs([['CACHE', 'Locks']], () => _countSheetReads('CACHE', 'Locks', async (reads) => {
        try {
            await ApplicationUtils.lockSheet('PACK_LISTS', tab, user);
            await ApplicationUtils.getLocksData();
            const base = reads();
            await _waitFor(() => {
                const row = _stampRow('app_utils:getLocksData');
                return row && new Date(row[1]).getTime() > Date.now();
            }, 'the lock stamp');
            await triggerCachePoll();
            await ApplicationUtils.getLocksData();
            assertEqual(reads(), base + 1, 'Locks reads after the poll read our own lock stamp');
        } finally {
            await ApplicationUtils.unlockSheet('PACK_LISTS', tab, user);
        }
    }));
    invalidateCache([{ namespace: 'app_utils', methodName: 'getLocksData', args: [] }]);
});

// ── Group: URL toggles ────────────────────────────────────────────────────────
// ParamToggles keeps on/off page options in the container's URL parameters (CLAUDE.md "Page
// options in the URL"). A toggle at its default leaves the URL; other parameters are kept.

test('URL TOGGLES', 'a toggle reads its parameter, else its default', async () => {
    const pending = { param: 'pending', label: 'Pending' };
    const hidden = { param: 'extra', label: 'Extra', default: false };
    assertEqual([paramToggleValue({}, pending), paramToggleValue({ pending: false }, pending), paramToggleValue({}, hidden), paramToggleValue({ extra: true }, hidden)],
        [true, false, false, true], 'values');
});

test('URL TOGGLES', 'updateContainerParams writes only the changed parameters', async () => {
    const opened = [];
    const navigate = path => opened.push(NavigationRegistry.parsePath(path));
    const current = NavigationRegistry.buildPath('inventory/furniture', { searchTerm: 'chair' });
    NavigationRegistry.updateContainerParams('inventory/furniture', current, { pending: false }, navigate);
    const toggled = NavigationRegistry.buildPath('inventory/furniture', { searchTerm: 'chair', pending: false });
    NavigationRegistry.updateContainerParams('inventory/furniture', toggled, { pending: undefined }, navigate);
    assertEqual(opened.map(({ path, parameters }) => [path, parameters]),
        [['inventory/furniture', { searchTerm: 'chair', pending: false }], ['inventory/furniture', { searchTerm: 'chair' }]], 'set, then removed');
});

// TEMPORARY admin check (until an admin system with permissions replaces it): a hand-kept list,
// plus the fake test user on localhost
test('URL TOGGLES', 'isTemporaryAdmin: the listed users, and the test user on localhost', async () => {
    const previous = authState.user;
    try {
        const as = (email) => { authState.user = email ? { email } : null; return isTemporaryAdmin(); };
        assertEqual([as('dschwab@topshelfexhibits.com'), as('test@example.com'), as('sam@example.com'), as(null)], [true, true, false, false], 'admins');
    } finally {
        authState.user = previous;
    }
});

// ── Group: Severity ───────────────────────────────────────────────────────────
// Alerts, banners and status cards carry a severity (data_management/utils/severity.js); the UI
// gives each one colour (application/utils/severity.js). Expected colours are SEVERITY_COLORS.

test('SEVERITY', 'each severity has one colour', async () => {
    assertEqual(Object.values(SEVERITY).map(severityColor), ['red', 'orange', 'yellow', 'purple', 'white', 'blue', 'gray', 'green'], 'colours');
    assertEqual([severityColor(''), severityColor('nonsense'), severityColor(undefined)], ['', '', ''], 'none');
});

test('SEVERITY', 'statusColor: a class wins, then the severity', async () => {
    assertEqual(statusColor({ severity: SEVERITY.critical }), 'red', 'severity');
    assertEqual(statusColor({ severity: SEVERITY.critical, class: 'green' }), 'green', 'explicit class');
    assertEqual(statusColor({ color: 'blue' }), 'blue', 'older color field');
    assertEqual([statusColor({}), statusColor(null)], ['', ''], 'plain');
});

test('SEVERITY', 'remaining quantities: one rule for alerts and cells', async () => {
    assertEqual([-1, 0, 0.5, 1, 5, null, NaN].map(remainingSeverity), ['critical', 'warning', 'warning', '', '', '', ''], 'remainingSeverity');
    assertEqual([-1, 0, 1].map(getAutoColorClass), ['red', 'orange', ''], 'getAutoColorClass');
    assertEqual(applyColorRule('checked:critical', 'X'), 'red', 'a view rule may name a severity');
    assertEqual(applyColorRule('checked:gray', 'X'), 'gray', 'or a class');
});

test('SEVERITY', 'API alerts carry a severity, not a colour', async () => {
    const shortage = await Requests.checkInventoryLevel({ 'Extracted Item': 'CAB-004' }, 'ATSC 2025 NAB');
    assertEqual([shortage?.type, shortage?.severity, shortage?.color], ['item shortage', 'critical', undefined], 'CAB-004 shortage');
    const missing = await Requests.checkDescriptionMatch({ 'Extracted Item': 'CAB-005', Description: '(1) CAB-005C Tall gray storage cabinet' });
    assertEqual([missing?.severity, missing?.color], ['attention', undefined], 'undeclared variant');
});

// ── Group: Grid ranges ────────────────────────────────────────────────────────
// gridRanges.js: GoogleSheetsService grows a sheet's grid for range writes and clips range reads
// to it. Regression: a show note appended after empty note rows were deleted wrote "ShowNotes!A7:C7"
// to a 6-row grid ("exceeds grid limits"), because cell writes and range reads didn't handle it.

test('GRID RANGES', 'parseA1Range reads sheets and bounds', async () => {
    assertEqual(parseA1Range('ShowNotes!A7:C7'), { sheetPart: 'ShowNotes', sheet: 'ShowNotes', startRow: 7, startCol: 1, endRow: 7, endCol: 3 }, 'block');
    assertEqual(parseA1Range("'Production Schedule'!AB5"), { sheetPart: "'Production Schedule'", sheet: 'Production Schedule', startRow: 5, startCol: 28, endRow: 5, endCol: 28 }, 'quoted single cell');
    assertEqual(parseA1Range('Caching!A:B'), { sheetPart: 'Caching', sheet: 'Caching', startRow: null, startCol: 1, endRow: null, endCol: 2 }, 'whole columns');
    assertEqual(parseA1Range("'Bob''s'"), { sheetPart: "'Bob''s'", sheet: "Bob's", startRow: null, startCol: null, endRow: null, endCol: null }, 'whole tab');
});

test('GRID RANGES', 'gridNeeded takes the furthest cell per sheet', async () => {
    const needs = gridNeeded(['ShowNotes!A7:C7', 'ShowNotes!B9:B9', "'Production Schedule'!AA5:AA5", 'Caching!A:B']);
    assertEqual([...needs], [['ShowNotes', { rows: 9, cols: 3 }], ['Production Schedule', { rows: 5, cols: 27 }], ['Caching', { rows: 0, cols: 2 }]], 'needs');
});

test('GRID RANGES', 'clipRangeToGrid pulls a range into the grid', async () => {
    assertEqual(clipRangeToGrid('ShowNotes!A7:C7', 6, 3), null, 'row past the grid: nothing to read');
    assertEqual(clipRangeToGrid('ShowNotes!A5:C8', 6, 3), 'ShowNotes!A5:C6', 'rows clipped');
    assertEqual(clipRangeToGrid("'My Tab'!B2:Z2", 6, 3), "'My Tab'!B2:C2", 'columns clipped, quoting kept');
    assertEqual(clipRangeToGrid('ShowNotes!D1:D1', 6, 3), null, 'column past the grid');
    assertEqual(clipRangeToGrid('Caching!A:B', 6, 3), 'Caching!A:B', 'open rows stay open');
    assertEqual(clipRangeToGrid('ShowNotes', 6, 3), 'ShowNotes', 'whole tab');
});

test('GRID RANGES', 'isGridLimitError recognises the API error', async () => {
    const apiError = { status: 400, result: { error: { code: 400, message: 'Range (ShowNotes!A7:C7) exceeds grid limits. Max rows: 6, max columns: 3', status: 'INVALID_ARGUMENT' } } };
    assertEqual([isGridLimitError(apiError), isGridLimitError({ status: 400, result: { error: { message: 'Unable to parse range' } } }), isGridLimitError(null)], [true, false, false], 'errors');
});

// ── Group: Tab reads ──────────────────────────────────────────────────────────
// getData's whole-tab reads queue per spreadsheet and go out together as one values.batchGet.
// clearCache empties the cache without reloading the stores, so only the test's own reads run.

/** Run fn, recording each tab read request: { tableId, ranges } (a single read has one range). */
async function _recordTabReads(fn) {
    const S = FakeGoogleSheetsService;
    const getSheetData = S.getSheetData, batchGetValues = S.batchGetValues;
    const requests = [];
    S.getSheetData = async function (tableId, range) {
        requests.push({ tableId, ranges: [range] });
        return getSheetData.call(this, tableId, range);
    };
    S.batchGetValues = async function (tableId, ranges) {
        requests.push({ tableId, ranges: [...ranges] });
        return Promise.all(ranges.map(range => getSheetData.call(S, tableId, range)));
    };
    try {
        await fn();
    } finally {
        S.getSheetData = getSheetData;
        S.batchGetValues = batchGetValues;
    }
    return requests;
}

test('TAB READS', 'tabs read at the same moment are one request', async () => {
    const tabs = ['FURNITURE', 'CABINETS', 'PANELS'];
    clearCache();
    let results;
    const requests = await _recordTabReads(async () => {
        results = await Promise.all(tabs.map(tab => Database.getData('INVENTORY', tab)));
    });
    assertEqual(requests.filter(r => r.tableId === 'INVENTORY'), [{ tableId: 'INVENTORY', ranges: tabs }], 'one request');
    assertEqual(JSON.stringify(results), JSON.stringify(tabs.map(tab => FakeGoogleSheetsService.getMockData('INVENTORY', tab))), 'each tab as read');
});

test('TAB READS', 'a missing tab fails only its own read', async () => {
    clearCache();
    const results = await withFaults({
        beforeRead: (t, range) => {
            if (range !== 'NO SUCH TAB') return;
            const err = new Error('Unable to parse range: NO SUCH TAB');
            err.status = 400;
            throw err;
        }
    }, () => Promise.allSettled([Database.getData('INVENTORY', 'FURNITURE'), Database.getData('INVENTORY', 'NO SUCH TAB')]));
    assertEqual(results.map(r => r.status), ['fulfilled', 'rejected'], 'results');
    assertEqual(JSON.stringify(results[0].value), JSON.stringify(FakeGoogleSheetsService.getMockData('INVENTORY', 'FURNITURE')), 'the good tab');
});

test('TAB READS', 'getAllInventoryData reads every inventory tab in one request', async () => {
    clearCache();
    const requests = await _recordTabReads(() => Requests.getAllInventoryData());
    const tabs = (await Requests.getAvailableTabs('INVENTORY')).map(tab => tab.title);
    const inventory = requests.filter(r => r.tableId === 'INVENTORY');
    assertEqual([inventory.length, [...(inventory[0]?.ranges || [])].sort()], [1, [...tabs].sort()], 'one request, every tab');
});

// ── Group 35: Preferences ─────────────────────────────────────────────────────
// FakeGoogle CACHE/Preferences has 13 rows, among them:
//   4 schedule* integer prefs (offsets 14, 14, 7, 7)
//   3 inventory* json tab lists (InventorySuppressCategoryAnalysis, InventoryCustomItemNumbers,
//     InventoryDescriptionOnly), the only source of those settings

test('PREFERENCES', 'getPreferences returns an array', async () => {
    const result = await Requests.getPreferences();
    if (!Array.isArray(result)) throw new Error(`expected array, got ${typeof result}`);
});

test('PREFERENCES', 'getPreferences returns every fixture row', async () => {
    const result = await Requests.getPreferences();
    assertEqual(result.length, 13, 'getPreferences row count');
});

test('PREFERENCES', 'all rows have required fields', async () => {
    const result = await Requests.getPreferences();
    for (const row of result) {
        if (!row.id) throw new Error(`row missing id: ${JSON.stringify(row)}`);
        if (!row.name) throw new Error(`row missing name: ${JSON.stringify(row)}`);
        if (!row.type) throw new Error(`row missing type: ${JSON.stringify(row)}`);
        if (!row.page) throw new Error(`row missing page: ${JSON.stringify(row)}`);
    }
});

test('PREFERENCES', 'ScheduleShipOffsetDaysFromShow has value "14" and type "integer"', async () => {
    const result = await Requests.getPreferences();
    const pref = result.find(r => r.id === 'ScheduleShipOffsetDaysFromShow');
    if (!pref) throw new Error('ScheduleShipOffsetDaysFromShow not found');
    assertEqual(pref.value, '14', 'ScheduleShipOffsetDaysFromShow value');
    assertEqual(pref.type, 'integer', 'ScheduleShipOffsetDaysFromShow type');
});

test('PREFERENCES', 'InventorySuppressCategoryAnalysis has type "json" and page "inventory*"', async () => {
    const result = await Requests.getPreferences();
    const pref = result.find(r => r.id === 'InventorySuppressCategoryAnalysis');
    if (!pref) throw new Error('InventorySuppressCategoryAnalysis not found');
    assertEqual(pref.type, 'json', 'InventorySuppressCategoryAnalysis type');
    assertEqual(pref.page, 'inventory*', 'InventorySuppressCategoryAnalysis page');
});

test('PREFERENCES', 'schedule prefs have page "schedule*"', async () => {
    const result = await Requests.getPreferences();
    const schedulePrefs = result.filter(r => r.id.startsWith('Schedule'));
    if (schedulePrefs.length === 0) throw new Error('no schedule preferences found');
    for (const p of schedulePrefs) {
        if (p.page !== 'schedule*') throw new Error(`expected page "schedule*" for ${p.id}, got "${p.page}"`);
    }
});

// ── Group 36: Edit History ────────────────────────────────────────────────────
// Contract: docs/notes/metadata-implementation.md
// Pure tests cover EditHistoryUtils matching and aggregation. Integration tests save
// through Database.setData into a dedicated hidden PACK_LISTS tab (_HISTORY_TEST) so
// fixture tabs are untouched; deletions archive to PACK_LISTS/_EditHistory.

const _eh = (obj) => JSON.stringify(obj);
const _row = (name, qty, edithistory = '') => ({ name, qty, edithistory });

test('EDIT HISTORY', 'getRowIndex reads positive integer i only', async () => {
    assertEqual(EditHistoryUtils.getRowIndex(_eh({ i: 4, h: [] })), 4, 'valid i');
    assertEqual(EditHistoryUtils.getRowIndex(_eh({ i: 0 })), null, 'zero rejected');
    assertEqual(EditHistoryUtils.getRowIndex(_eh({ i: '4' })), null, 'string rejected');
    assertEqual(EditHistoryUtils.getRowIndex(''), null, 'empty');
});

test('EDIT HISTORY', 'matchRows matches by i across reorder and insertion', async () => {
    const originals = [_row('A', 1, _eh({ i: 1 })), _row('B', 2, _eh({ i: 2 })), _row('C', 3, _eh({ i: 3 }))];
    const updated = [_row('NEW', 0), originals[2], originals[0], { ...originals[1], qty: 9 }];
    const { matchOf, duplicates, deleted } = EditHistoryUtils.matchRows(originals, updated);
    assertEqual(matchOf, [-1, 2, 0, 1], 'matchOf');
    assertEqual([...duplicates], [], 'duplicates');
    assertEqual(deleted, [], 'deleted');
});

test('EDIT HISTORY', 'matchRows: copied row closest to the original keeps i', async () => {
    const originals = [_row('A', 1, _eh({ i: 1 })), _row('B', 2, _eh({ i: 2 }))];
    const updated = [originals[0], originals[1], { ...originals[0] }];
    const { matchOf, duplicates } = EditHistoryUtils.matchRows(originals, updated);
    assertEqual(matchOf, [0, 1, -1], 'matchOf');
    assertEqual([...duplicates], [2], 'duplicates');
});

test('EDIT HISTORY', 'matchRows: legacy rows without i match by content, then within gap', async () => {
    const originals = [_row('X', 1), _row('Y', 2), _row('Z', 3)];
    const updated = [_row('W', 5), _row('X', 1), _row('Y', 7), _row('Z', 3)];
    const { matchOf, deleted } = EditHistoryUtils.matchRows(originals, updated);
    assertEqual(matchOf, [-1, 0, 1, 2], 'matchOf (W new, edited Y matched in gap)');
    assertEqual(deleted, [], 'deleted');
});

test('EDIT HISTORY', 'matchRows: unmatched stored row is reported deleted', async () => {
    const originals = [_row('A', 1, _eh({ i: 1 })), _row('B', 2, _eh({ i: 2 }))];
    const { deleted } = EditHistoryUtils.matchRows(originals, [originals[1]]);
    assertEqual(deleted, [0], 'deleted');
});

test('EDIT HISTORY', 'aggregation merges same user+source within an hour, keeping the older o', async () => {
    const first = { u: 'dan', t: 1000, s: 'web', c: [{ n: 'qty', o: '1' }] };
    const second = { u: 'dan', t: 1000 + 600, s: 'web', c: [{ n: 'qty', o: '2' }, { n: 'name', o: 'A' }] };
    const result = JSON.parse(EditHistoryUtils.appendToEditHistory(_eh({ i: 1, h: [first] }), second, undefined, { qty: '3', name: 'B' }));
    assertEqual(result.h.length, 1, 'merged into one entry');
    assertEqual(result.h[0].t, 1600, 'timestamp advanced');
    assertEqual(result.h[0].c, [{ n: 'qty', o: '1' }, { n: 'name', o: 'A' }], 'older o kept, new field added');
    assertEqual(result.i, 1, 'root keys preserved');
});

test('EDIT HISTORY', 'aggregation drops reverted fields and empty merged entries', async () => {
    const first = { u: 'dan', t: 1000, s: 'web', c: [{ n: 'qty', o: '1' }] };
    const second = { u: 'dan', t: 1100, s: 'web', c: [{ n: 'qty', o: '2' }] };
    const result = JSON.parse(EditHistoryUtils.appendToEditHistory(_eh({ h: [first] }), second, undefined, { qty: '1' }));
    assertEqual(result.h, [], 'edit + revert within window leaves no entry');
});

test('EDIT HISTORY', 'aggregation does not merge across source, window, or creation markers', async () => {
    const base = { u: 'dan', t: 1000, s: 'web', c: [{ n: 'qty', o: '1' }] };
    const cad = { u: 'dan', t: 1100, s: 'cad', c: [{ n: 'qty', o: '2' }] };
    const late = { u: 'dan', t: 1000 + 36001, s: 'web', c: [{ n: 'qty', o: '2' }] };
    const created = { u: 'dan', t: 1000, s: 'web', c: [] };
    const soon = { u: 'dan', t: 1100, s: 'web', c: [{ n: 'qty', o: '0' }] };
    assertEqual(JSON.parse(EditHistoryUtils.appendToEditHistory(_eh({ h: [base] }), cad)).h.length, 2, 'different source');
    assertEqual(JSON.parse(EditHistoryUtils.appendToEditHistory(_eh({ h: [base] }), late)).h.length, 2, 'outside window');
    assertEqual(JSON.parse(EditHistoryUtils.appendToEditHistory(_eh({ h: [created] }), soon)).h.length, 2, 'creation marker');
});

test('EDIT HISTORY', 'history is capped at 10 entries', async () => {
    let eh = '';
    for (let n = 0; n < 15; n++) {
        eh = EditHistoryUtils.appendToEditHistory(eh, { u: `user${n}`, t: n, s: 'web', c: [{ n: 'qty', o: String(n) }] });
    }
    const parsed = JSON.parse(eh);
    assertEqual(parsed.h.length, 10, 'cap');
    assertEqual(parsed.h[0].u, 'user14', 'newest first');
});

test('EDIT HISTORY', 'applyNeValue returns strings like sheet cells', async () => {
    assertEqual(EditHistoryUtils.applyNeValue('12', '+6'), '18', 'delta');
    assertEqual(EditHistoryUtils.applyNeValue('', '+5'), '5', 'delta on empty');
    assertEqual(EditHistoryUtils.applyNeValue('3', 10), '10', 'absolute number');
    assertEqual(EditHistoryUtils.applyNeValue('a', 'b'), 'b', 'absolute string');
    const { updatedItems } = EditHistoryUtils.applyPendingChangesToData(
        [{ quantity: '12', edithistory: _eh({ i: 1, h: [], p: [{ u: 'dan', t: 1, d: 1, s: 'n', c: [{ n: 'quantity', ne: '+6' }] }] }) }],
        Math.floor(Date.now() / 100)
    );
    assertEqual(updatedItems[0].quantity, '18', 'applied pending quantity is a string');
});

const _HISTORY_TAB = '_HISTORY_TEST';
const _HISTORY_MAPPING = { name: 'Name', qty: 'Qty', edithistory: 'EditHistory' };
const _historySave = (rows) => Database.setData('PACK_LISTS', _HISTORY_TAB, rows, _HISTORY_MAPPING, { username: 'test@example.com', source: 'web' });
// Copy rows: getData returns the cached array, and editing it in place would also edit the "stored" rows
const _historyRead = async () => (await Database.getData('PACK_LISTS', _HISTORY_TAB, _HISTORY_MAPPING)).map(r => ({ ...r }));
const _parsed = (row) => JSON.parse(row.edithistory || '{}');

test('EDIT HISTORY', 'first touch assigns i to legacy rows without adding history', async () => {
    await Database.setData('PACK_LISTS', _HISTORY_TAB, [_row('A', '1'), _row('B', '2'), _row('C', '3')], _HISTORY_MAPPING, { skipMetadata: true });
    await _historySave(await _historyRead());
    const rows = await _historyRead();
    assertEqual(rows.map(r => _parsed(r).i), [1, 2, 3], 'identities');
    assertEqual(rows.map(r => (_parsed(r).h || []).length), [0, 0, 0], 'no history entries');
});

test('EDIT HISTORY', 'inserting a row above others records no changes on shifted rows', async () => {
    const rows = await _historyRead();
    rows[1] = { ...rows[1], qty: '20' };
    await _historySave([_row('NEW', '5'), ...rows]);
    const saved = await _historyRead();
    assertEqual(saved.map(r => r.name), ['NEW', 'A', 'B', 'C'], 'order');
    assertEqual(_parsed(saved[0]).i, 4, 'new row gets next identity');
    assertEqual(_parsed(saved[0]).h.map(e => e.c), [[]], 'new row has a creation marker');
    assertEqual((_parsed(saved[1]).h || []).length, 0, 'A unchanged');
    assertEqual(_parsed(saved[2]).h[0].c, [{ n: 'qty', o: '2' }], 'B records its own old qty');
    assertEqual((_parsed(saved[3]).h || []).length, 0, 'C unchanged');
});

test('EDIT HISTORY', 'repeat edit within the hour aggregates into one entry', async () => {
    const rows = await _historyRead();
    rows[2] = { ...rows[2], qty: '25' };
    await _historySave(rows);
    const b = (await _historyRead())[2];
    assertEqual(_parsed(b).h.length, 1, 'single entry');
    assertEqual(_parsed(b).h[0].c, [{ n: 'qty', o: '2' }], 'oldest value kept');
});

test('EDIT HISTORY', 'copied row gets a fresh identity and history', async () => {
    const rows = await _historyRead();
    await _historySave([...rows, { ...rows[2] }]);
    const saved = await _historyRead();
    assertEqual(_parsed(saved[2]).i, 2, 'original B keeps i=2');
    assertEqual(_parsed(saved[4]).i, 5, 'copy gets i=5');
    assertEqual(_parsed(saved[4]).h.map(e => e.c), [[]], 'copy history restarts');
});

test('EDIT HISTORY', 'deletions append to _EditHistory without overwriting earlier archive rows', async () => {
    const archiveMapping = { SourceTab: 'SourceTab', RowIdentifier: 'RowIdentifier', Operation: 'Operation' };
    const archived = async () => (await Database.getData('PACK_LISTS', '_EditHistory', archiveMapping))
        .filter(r => r.SourceTab === _HISTORY_TAB);
    let rows = await _historyRead();
    await _historySave(rows.filter(r => r.name !== 'C'));
    rows = await _historyRead();
    await _historySave(rows.filter(r => r.name !== 'NEW'));
    const entries = await archived();
    assertEqual(entries.map(r => r.RowIdentifier), ['3', '4'], 'both deletions archived by identity');
    assertEqual(entries.map(r => r.Operation), ['delete', 'delete'], 'operation');
});

test('EDIT HISTORY', 'packlist crates and items use lowercase edithistory/metadata keys', async () => {
    const crates = await Requests.getPackList('ATSC 2025 NAB');
    const objects = crates.flatMap(crate => [crate, ...(crate.Items || [])]);
    for (const obj of objects) {
        if ('EditHistory' in obj || 'MetaData' in obj)
            throw new Error(`capitalized key on packlist object: ${Object.keys(obj).join(', ')}`);
    }
    if (!crates[0].Items[0].edithistory.includes('cadbot'))
        throw new Error('fixture history not found on item.edithistory');
});

test('EDIT HISTORY', 'packlist round-trip keeps history and assigns identity', async () => {
    // ATSC 2025 NAB is the only fixture with history but is locked by another user; round-trip an unlocked copy
    const tab = '_HISTORY_PACKLIST';
    await Requests.createNewTab('PACK_LISTS', 'ATSC 2025 NAB', tab);
    const crates = await Requests.getPackList(tab);
    const notes = (list) => list.flatMap(c => (c.Items || []).map(i => i['Packing/shop notes'])).filter(Boolean);
    // Run as a logged-in user so a false change would also show up as a history entry
    await _asUser(() => Requests.savePackList(crates, tab));
    const saved = await Requests.getPackList(tab);
    // The sheet header is "Packing/shop\nnotes"; rows use the normalized key
    assertEqual(notes(saved), notes(crates), 'packing notes survive the round trip');
    const parsed = JSON.parse(saved[0].Items[0].edithistory);
    assertEqual(parsed.h.map(e => e.u), ['cadbot', 'dan'], 'existing history preserved');
    if (!Number.isInteger(parsed.i)) throw new Error(`expected integer i, got ${parsed.i}`);
});

// ── Group 37: Edit History View ───────────────────────────────────────────────
// Plan: docs/notes/inventory-edit-history-view-plan.md
// FakeGoogle FURNITURE fixtures:
//   CHAIR-003  qty 12, three history entries (restock +2, description edit, qty+notes edit)
//   CHAIR-004  qty '', past-due scheduled change (+5)
//   INVENTORY/_EditHistory  one archived FURNITURE row (CHAIR-099)

const _VIEW_FIELDS = ['quantity', 'description', 'notes'];
const _furnitureRow = async (itemNumber) => (await Requests.getInventoryTabData('FURNITURE')).find(r => r.itemNumber === itemNumber);

test('EDIT HISTORY VIEW', 'getHistoryStates rewinds CHAIR-003 newest first', async () => {
    const states = EditHistoryUtils.getHistoryStates(await _furnitureRow('CHAIR-003'), _VIEW_FIELDS);
    assertEqual(states.map(s => s.kind), ['current', 'change', 'change', 'earliest'], 'kinds');
    assertEqual(states.map(s => s.state.quantity), ['12', '10', '10', '8'], 'quantity at each state');
    assertEqual(states.map(s => s.state.notes), ['', '', '', 'check legs'], 'notes at each state');
    assertEqual(states[2].state.description, 'Cube chair (black) collapsible', 'description before sam\'s edit');
    assertEqual(states.map(s => s.entry?.u ?? null), ['dan', 'sam', 'dan', null], 'entry paired with each state');
    assertEqual([...states[2].changed].sort(), ['notes', 'quantity'], 'fields changed by the oldest entry');
});

test('EDIT HISTORY VIEW', 'getHistoryStates ends with a created row when history reaches creation', async () => {
    const row = { quantity: '3', edithistory: JSON.stringify({ i: 1, h: [
        { u: 'dan', t: 200, s: 'web', c: [{ n: 'quantity', o: '1' }, { m: 4 }] },
        { u: 'dan', t: 100, s: 'web', c: [] }
    ] }) };
    const states = EditHistoryUtils.getHistoryStates(row, ['quantity']);
    assertEqual(states.map(s => s.kind), ['current', 'created'], 'kinds (no earliest row)');
    assertEqual(states.map(s => s.state.quantity), ['3', '1'], 'created state; move record ignored');
});

test('EDIT HISTORY VIEW', 'getHistoryStates with no history returns only the current row', async () => {
    const states = EditHistoryUtils.getHistoryStates({ quantity: '4', edithistory: '' }, ['quantity']);
    assertEqual(states.map(s => s.kind), ['current'], 'kinds');
    assertEqual(states[0].entry, null, 'no entry');
});

test('EDIT HISTORY VIEW', 'applied scheduled change reads like a normal entry (CHAIR-004)', async () => {
    const row = await _furnitureRow('CHAIR-004');
    const { updatedItems } = EditHistoryUtils.applyPendingChangesToData([row], Math.floor(Date.now() / 100));
    const states = EditHistoryUtils.getHistoryStates(updatedItems[0], _VIEW_FIELDS);
    assertEqual(states.map(s => s.state.quantity), ['5', ''], 'quantity after and before the scheduled change');
    assertEqual(states[0].entry.s, 'new stock', 'note from the scheduled entry');
});

test('EDIT HISTORY VIEW', 'getArchivedRows returns this tab\'s deleted rows, parsed', async () => {
    const rows = await Requests.getArchivedRows('INVENTORY', 'FURNITURE');
    assertEqual(rows.length, 1, 'one archived FURNITURE row');
    assertEqual(rows[0].RowData.itemNumber, 'CHAIR-099', 'RowData parsed');
    assertFiniteNumber(rows[0].Timestamp, 'Timestamp is a number');
    assertEqual(await Requests.getArchivedRows('INVENTORY', 'CABINETS'), [], 'other tab has none');
});

test('EDIT HISTORY VIEW', 'getArchivedRows returns [] when the spreadsheet has no archive tab', async () => {
    assertEqual(await Requests.getArchivedRows('CACHE', 'Notes'), [], 'no CACHE/_EditHistory tab');
});

// The history page's delete button (admins) marks a row as the table's Delete key does; saving
// removes it from the tab and archives it, and the page's deleted items store shows it without a
// reload. FakeGoogle SHELVES holds SHLF-001 only; the test puts it back.
test('EDIT HISTORY VIEW', 'a row marked for deletion is removed and archived on save', async () => {
    const original = await Database.getData('INVENTORY', 'SHELVES', DEFAULT_INVENTORY_MAPPING);
    const store = await _loadedStore(Requests.getInventoryTabData, Requests.saveInventoryTabData, ['SHELVES', undefined, undefined, undefined]);
    const deletedItems = await _loadedStore(Requests.getArchivedRows, null, ['INVENTORY', 'SHELVES']);
    try {
        assertEqual(deletedItems.data, [], 'nothing deleted yet');
        const index = store.data.findIndex(row => row.itemNumber === 'SHLF-001');
        store.markRowForDeletion(index, true);
        assertEqual(isMarkedForDeletion(store.data[index]), true, 'marked');
        await _asUser(() => store.save('Saving...'));
        assertEqual(store.data.map(row => row.itemNumber), [], 'gone from the store');
        assertEqual((await Requests.getInventoryTabData('SHELVES')).map(row => row.itemNumber), [], 'gone from the tab');
        assertEqual((await Requests.getArchivedRows('INVENTORY', 'SHELVES')).map(row => row.RowData.itemNumber), ['SHLF-001'], 'archived');
        for (let i = 0; i < 100 && !deletedItems.data.length; i++) await new Promise(r => setTimeout(r, 50));
        assertEqual(deletedItems.data.map(row => row.RowData.itemNumber), ['SHLF-001'], 'the deleted items store reloaded');
    } finally {
        await Database.setData('INVENTORY', 'SHELVES', original, DEFAULT_INVENTORY_MAPPING, { skipMetadata: true });
    }
});

// Row flags (deletion mark, highlight, grouping) live in a row's metadata as JSON text. Pages read and
// write them with readRowMetadata / writeRowMetadata; clearing the last flag removes the key, as rows load.
test('ROW METADATA', 'readRowMetadata reads JSON text or an object; anything else reads as no flags', async () => {
    const flags = { grouping: { groupId: 'G1', isGroupMaster: true } };
    assertEqual(readRowMetadata({ metadata: JSON.stringify(flags) }), flags, 'JSON text');
    const row = { metadata: flags };
    assertEqual(readRowMetadata(row) === flags, true, 'an object is returned as is');
    assertEqual([{}, { metadata: '' }, { metadata: null }, { metadata: 'not json' }, { metadata: '"text"' }, null].map(readRowMetadata),
        [{}, {}, {}, {}, {}, {}], 'missing, empty, unreadable or not an object');
});

test('ROW METADATA', 'writeRowMetadata stores JSON text, and removes the key when no flags are left', async () => {
    const row = { itemNumber: 'A-1', metadata: '' };
    writeRowMetadata(row, { highlight: { class: 'yellow' } });
    assertEqual(row.metadata, '{"highlight":{"class":"yellow"}}', 'stored as text');
    writeRowMetadata(row, {});
    assertEqual('metadata' in row, false, 'key removed');
});

test('EDIT HISTORY VIEW', 'deleted items list the newest deletion of each item; a restored row drops its mark', async () => {
    const entry = (itemNumber, i, t) => ({ Timestamp: t, RowData: { itemNumber, edithistory: i ? JSON.stringify({ i, h: [] }) : '' } });
    const entries = [entry('A-1', 3, 30), entry('B-1', 5, 20), entry('A-1', 3, 10), entry('C-1', null, 5)];
    assertEqual(EditHistoryUtils.currentDeletions(entries, [{ itemNumber: 'B-1' }], 'itemNumber').map(e => [e.RowData.itemNumber, e.Timestamp]),
        [['A-1', 30], ['C-1', 5]], 'newest per item number; B-1 is in the tab again');
    assertEqual(EditHistoryUtils.currentDeletions(entries, [{ itemNumber: 'B-1' }], null).map(e => [e.RowData.itemNumber, e.Timestamp]),
        [['A-1', 30], ['B-1', 20], ['C-1', 5]], 'without a key field: newest per identity, item numbers ignored');
    const archived = { itemNumber: 'A-1', AppData: { x: 1 }, metadata: JSON.stringify({ deletion: { marked: true }, grouping: 1 }), edithistory: JSON.stringify({ i: 3, h: [{ u: 'dan' }] }) };
    const restored = EditHistoryUtils.restoredRow(archived);
    assertEqual([restored.AppData, JSON.parse(restored.metadata), JSON.parse(restored.edithistory).i], [undefined, { grouping: 1 }, 3], 'no mark, identity kept');
    const taken = EditHistoryUtils.restoredRow(archived, [{ itemNumber: 'Z-9', edithistory: JSON.stringify({ i: 3 }) }]);
    assertEqual(JSON.parse(taken.edithistory), { h: [{ u: 'dan' }] }, 'an identity taken since is given up; history stays');
    // Rows without item numbers go by identity: each is listed until a row with its identity is back
    const blank = [entry('', 7, 40), entry('', 8, 35), entry('', 7, 15), entry('', null, 12), entry('', null, 11)];
    assertEqual(EditHistoryUtils.currentDeletions(blank, [{ itemNumber: '', edithistory: JSON.stringify({ i: 8 }) }], 'itemNumber').map(e => e.Timestamp),
        [40, 12, 11], 'no item numbers: newest per identity, identity 8 is back, rows without either all listed');
});

// The archive is appended in one values.append per save, so deletions saved at the same time
// (two sessions, two categories) each keep their entry. Regression: each entry went to the next
// free row found by a read, and simultaneous saves could write the same row (losing a deleted row
// for good). FakeGoogle SHELVES holds SHLF-001, COUNTERTOPS CNTR-001; the test puts them back.
test('EDIT HISTORY VIEW', 'deletions saved at the same time each keep their archive entry', async () => {
    const tabs = ['SHELVES', 'COUNTERTOPS'];
    const originals = await Promise.all(tabs.map(tab => Database.getData('INVENTORY', tab, DEFAULT_INVENTORY_MAPPING)));
    const archived = async (tab) => (await Requests.getArchivedRows('INVENTORY', tab)).map(entry => entry.RowData.itemNumber);
    const before = await Promise.all(tabs.map(archived));
    try {
        await Promise.all(tabs.map(tab => Database.setData('INVENTORY', tab, [], DEFAULT_INVENTORY_MAPPING, { username: 'test@example.com' })));
        const after = await Promise.all(tabs.map(archived));
        assertEqual(after.map((list, k) => list.length - before[k].length), [1, 1], 'one new entry each');
        assertEqual(after.map(list => list[0]), ['SHLF-001', 'CNTR-001'], 'for the deleted rows');
    } finally {
        await Promise.all(tabs.map((tab, k) => Database.setData('INVENTORY', tab, originals[k], DEFAULT_INVENTORY_MAPPING, { skipMetadata: true })));
    }
});

// Full cycle on the history page: delete an item, restore it from the deleted items list (its row,
// identity and history come back as an unsaved change, and the save records the restore), then
// delete it again: the list holds its newest deletion once. FakeGoogle SHELVES holds SHLF-001
// only; the test gives it an identity first and puts the tab back.
test('EDIT HISTORY VIEW', 'a deleted row restores with its identity and history, and deletes again', async () => {
    const original = await Database.getData('INVENTORY', 'SHELVES', DEFAULT_INVENTORY_MAPPING);
    const archivedBefore = (await Requests.getArchivedRows('INVENTORY', 'SHELVES')).length;
    try {
        await Database.setData('INVENTORY', 'SHELVES', original, DEFAULT_INVENTORY_MAPPING, { username: 'test@example.com' });
        const store = await _loadedStore(Requests.getInventoryTabData, Requests.saveInventoryTabData, ['SHELVES', undefined, undefined, undefined]);
        const identity = EditHistoryUtils.getRowIndex(store.data[0].edithistory);
        const listed = async () => EditHistoryUtils.currentDeletions(await Requests.getArchivedRows('INVENTORY', 'SHELVES'), store.data, 'itemNumber');

        store.markRowForDeletion(0, true);
        await _asUser(() => store.save('Saving...'));
        const [deleted] = await listed();
        assertEqual([deleted?.RowData.itemNumber, store.data.length], ['SHLF-001', 0], 'deleted and listed');

        store.addRow(EditHistoryUtils.restoredRow(deleted.RowData, store.data));
        assertEqual([await listed(), store.isModified], [[], true], 'restoring takes it off the list, unsaved');
        await _asUser(() => store.save('Saving...', { note: 'restore SHLF-001' }));
        const [row] = await Requests.getInventoryTabData('SHELVES');
        const history = EditHistoryUtils.parseEditHistory(row.edithistory);
        assertEqual([row.itemNumber, history.i, history.h[0].s, history.h[0].c], ['SHLF-001', identity, 'restore SHLF-001', []], 'back with its identity; the save records the restore');

        store.markRowForDeletion(0, true);
        await _asUser(() => store.save('Saving...'));
        const archived = await Requests.getArchivedRows('INVENTORY', 'SHELVES');
        assertEqual([archived.length - archivedBefore, (await listed()).length], [2, 1], 'two deletions archived, the newest listed');
    } finally {
        await Database.setData('INVENTORY', 'SHELVES', original, DEFAULT_INVENTORY_MAPPING, { skipMetadata: true });
    }
});

// ── Store backups ──
// Unsaved edits are backed up to the user's data as a diff (calculateStoreDiff) and restored when
// their store loads again (applyDiffToData). Each change names its row (EditHistory i, or a
// fingerprint of its values), so it lands on that row after rows move. Regression: changes were
// restored by position, so after a row above was deleted (by a save elsewhere, or a proposal
// commit) a restored deletion mark fell on the next row, and the next save deleted that row.
// FakeGoogle PANELS starts BX-16x39, BX-16x47, BX-15x39; the tests put it back.

async function _loadedStore(...args) {
    const store = getReactiveStore(...args);
    for (let i = 0; i < 100 && (store.isLoading || store.initialLoad); i++) await new Promise(r => setTimeout(r, 50));
    return store;
}
const _panels = () => Database.getData('INVENTORY', 'PANELS', DEFAULT_INVENTORY_MAPPING);
const _marked = (rows) => rows.filter(row => isMarkedForDeletion(row)).map(row => row.itemNumber);
const _withMark = (row) => ({ ...row, metadata: JSON.stringify({ deletion: { marked: true } }) });

test('STORE BACKUPS', 'a restored change follows its row after rows move', async () => {
    const original = await _panels();
    try {
        // Unsaved: BX-15x39 marked for deletion and BX-16x47's notes edited, backed up as a diff
        const edited = original.map(row => row.itemNumber === 'BX-15x39' ? _withMark(row)
            : row.itemNumber === 'BX-16x47' ? { ...row, notes: 'check edges' } : row);
        const diff = calculateStoreDiff(original, edited);
        // Another session deletes BX-16x39 (every row below it moves up one) and saves the tab
        await Database.setData('INVENTORY', 'PANELS', original.filter(row => row.itemNumber !== 'BX-16x39'), DEFAULT_INVENTORY_MAPPING, { username: 'other@example.com' });
        const restored = applyDiffToData(await _panels(), diff);
        assertEqual(_marked(restored), ['BX-15x39'], 'the mark is back on its own row');
        assertEqual(restored.filter(row => row.notes === 'check edges').map(row => row.itemNumber), ['BX-16x47'], 'and the edit');
    } finally {
        await Database.setData('INVENTORY', 'PANELS', original, DEFAULT_INVENTORY_MAPPING, { skipMetadata: true });
    }
});

test('STORE BACKUPS', 'a change whose row is gone is not restored', async () => {
    const original = await _panels();
    const diff = calculateStoreDiff(original, original.map(row => row.itemNumber === 'BX-16x39' ? _withMark(row) : row));
    const restored = applyDiffToData(original.filter(row => row.itemNumber !== 'BX-16x39'), diff);
    assertEqual(_marked(restored), [], 'no other row takes the mark');
});

test('STORE BACKUPS', 'an older backup restores edits by position, never a deletion mark', async () => {
    const original = await _panels();
    // A backup saved before changes named their rows: index only
    const legacy = [{ index: 2, type: 'modified', data: { notes: 'legacy edit', metadata: JSON.stringify({ deletion: { marked: true } }) } }];
    const restored = applyDiffToData(original, legacy);
    assertEqual([restored[2].itemNumber, restored[2].notes, _marked(restored)], ['BX-15x39', 'legacy edit', []], 'edit at its position, no mark');
});

test('STORE BACKUPS', 'discarding edits discards their backup', async () => {
    const store = await _loadedStore(Requests.getInventoryTabData, Requests.saveInventoryTabData, ['PANELS', undefined, undefined, undefined]);
    const calls = [];
    const discardBackup = store.discardBackup;
    store.discardBackup = async () => { calls.push('discarded'); };
    try {
        await store.load('Loading...');
        assertEqual(calls, [], 'an unmodified reload keeps any backup');
        store.markRowForDeletion(0, true);
        // Discard, Refresh and sending edits to a proposal all reload the modified store
        await store.load('Loading...');
        assertEqual([calls, _marked(store.data)], [['discarded'], []], 'the edit and its backup are gone');
    } finally {
        store.discardBackup = discardBackup;
        store.setData(store.originalData);
    }
});

test('EDIT HISTORY VIEW', 'item timeline shows field changes and rebuilt quantities (CHAIR-003)', async () => {
    const events = await Requests.getItemTimeline('CHAIR-003', '2026-01-01', '2026-12-31');
    const balance = events.find(e => e.event === 'Balance');
    assertEqual(balance.quantity, 8, 'opening balance is the earliest known quantity');
    const changes = events.filter(e => e.event === 'Inv. Change');
    assertEqual(changes.map(e => e.change), [
        'quantity: +2, notes: "check legs" → ""',
        'description: "Cube chair (black) collapsible" → "Cube chair (black?) collapsible"',
        'quantity: +2'
    ], 'change labels, oldest first');
    assertEqual(changes.map(e => e.quantity), [10, 10, 12], 'running quantity');
    assertEqual(changes[2].note, 'dan: restock', 'note');
});

test('EDIT HISTORY VIEW', 'item timeline labels scheduled changes by their own field', async () => {
    const events = await Requests.getItemTimeline('CHAIR-003', '2027-01-01', '2027-12-31');
    const scheduled = events.find(e => e.event === 'Scheduled');
    assertEqual(scheduled.change, 'quantity: +6', 'scheduled label');
    assertEqual(scheduled.quantity, 18, 'quantity after scheduled restock');
});

test('EDIT HISTORY VIEW', 'entryNote hides the default web/app source but keeps notes and cad', async () => {
    assertEqual(EditHistoryUtils.entryNote({ s: 'web' }), '', 'web hidden');
    assertEqual(EditHistoryUtils.entryNote({ s: 'app' }), '', 'legacy app hidden');
    assertEqual(EditHistoryUtils.entryNote({}), '', 'missing s');
    assertEqual(EditHistoryUtils.entryNote({ s: 'restock' }), 'restock', 'note kept');
    assertEqual(EditHistoryUtils.entryNote({ s: 'cad' }), 'cad', 'cad kept');
});

test('EDIT HISTORY VIEW', 'createEditHistoryEntry omits s when no source is given', async () => {
    const entry = EditHistoryUtils.createEditHistoryEntry('dan@example.com', [{ column: 'quantity', old: '1' }], null);
    assertEqual('s' in entry, false, 'no s');
    assertEqual(EditHistoryUtils.createEditHistoryEntry('dan@example.com', []).s, 'web', 'default source still web');
});

test('EDIT HISTORY VIEW', 'inventory save stores the note in s, and omits s without a note', async () => {
    const save = async (quantity, note) => {
        const rows = (await Requests.getInventoryTabData('FURNITURE')).map(r => ({ ...r }));
        rows.find(r => r.itemNumber === 'STOOL-002').quantity = quantity;
        await InventoryUtils.saveInventoryTabData(rows, 'FURNITURE', undefined, null, 'test@example.com', { source: 'web', note });
        return JSON.parse((await _furnitureRow('STOOL-002')).edithistory).h[0];
    };
    const withoutNote = await save('13', '');
    assertEqual('s' in withoutNote, false, 'no s without a note');
    const withNote = await save('14', 'recount');
    assertEqual(withNote.s, 'recount', 'note stored in s');
});

// ── INVENTORY PROPOSALS ──────────────────────────────────────────────────────
// Fixtures (CACHE/InventoryProposals): "Spring buy" (FURNITURE + HANGING SIGNS), "Cabinet fix"
// (CABINETS, locked by another user), "Fall buy" (committed). These tests run last: commits change inventory.

const _proposalRows = async (name) => (await Requests.getInventoryProposals()).filter(e => e.proposal === name);


test('INVENTORY PROPOSALS', 'validateName enforces length, characters and case-insensitive uniqueness', async () => {
    const existing = ['Spring buy', 'Fall buy'];
    assertEqual(ProposalUtils.validateName('', existing), 'Enter a proposal name', 'empty');
    assertEqual(ProposalUtils.validateName('x'.repeat(16), existing), 'Use at most 15 characters', 'too long');
    assertEqual(ProposalUtils.validateName('---', existing), 'Use at least one letter or number', 'no letters');
    assertEqual(ProposalUtils.validateName('SPRING BUY', existing), 'A proposal with this name already exists', 'duplicate ignoring case');
    assertEqual(ProposalUtils.validateName('Spring-buy', existing), 'A proposal with this name already exists', 'duplicate by slug');
    assertEqual(ProposalUtils.validateName('Winter buy', existing), null, 'valid');
    assertEqual(ProposalUtils.commitNote('Winter buy'), 'proposal: Winter buy', 'default commit note');
});

test('INVENTORY PROPOSALS', 'diffRow stores quantity as a delta and text fields as new values', async () => {
    const saved = { quantity: '12', description: 'Chair', notes: '' };
    assertEqual(ProposalUtils.diffRow(saved, { quantity: '20', description: 'Chair', notes: 'buy black' }),
        [{ n: 'quantity', ne: '+8' }, { n: 'notes', ne: 'buy black' }], 'delta and new value');
    assertEqual(ProposalUtils.diffRow(saved, { quantity: '9', description: 'Chair', notes: '' }), [{ n: 'quantity', ne: '-3' }], 'negative delta');
    assertEqual(ProposalUtils.diffRow(saved, { ...saved }), [], 'no change');
});

test('INVENTORY PROPOSALS', 'applyChanges adds quantity deltas but sets text literally', async () => {
    const row = ProposalUtils.applyChanges({ quantity: '12', description: 'Pole' }, [
        { n: 'quantity', ne: '+8' }, { n: 'description', ne: '-5 ft pole' }
    ]);
    assertEqual(row.quantity, '20', 'quantity delta applied');
    assertEqual(row.description, '-5 ft pole', 'signed text is not a delta');
});

test('INVENTORY PROPOSALS', 'mergeChanges replaces the same field and keeps the others', async () => {
    const merged = ProposalUtils.mergeChanges([{ n: 'quantity', ne: '+4' }, { n: 'notes', ne: 'legs' }], [{ n: 'quantity', ne: '+2' }, { n: 'description', ne: 'Chair' }]);
    assertEqual(merged, [{ n: 'notes', ne: 'legs' }, { n: 'quantity', ne: '+2' }, { n: 'description', ne: 'Chair' }], 'quantity replaced, notes kept, description added');
});

// Every proposal write is a save of the proposal's table store. saveToProposal (the save dialog's
// Proposal button) loads the store, takes the proposal lock, merges each item into its row (one row
// per item) and saves. The tests make their own proposals and empty them afterwards.
const _furnitureItem = async (itemNumber, changes) => ({
    inventoryRow: (await Requests.getInventoryTabData('FURNITURE')).find(row => row.itemNumber === itemNumber),
    changes
});

test('INVENTORY PROPOSALS', 'saveToProposal creates a proposal, then merges into it one row per item', async () => {
    const name = 'Store test';
    try {
        await _asUser(async () => saveToProposal(name, 'FURNITURE', [await _furnitureItem('CHAIR-003', [{ n: 'quantity', ne: '+4' }, { n: 'notes', ne: 'legs' }])]));
        await _asUser(async () => saveToProposal(name, 'FURNITURE', [
            await _furnitureItem('CHAIR-003', [{ n: 'quantity', ne: '+2' }]),
            await _furnitureItem('STOOL-002', [{ n: 'quantity', ne: '+1' }])
        ]));
        // Compare n/ne only: the proposals store (reloaded by saveToProposal) adds runtime AppData to the cached entries
        assertEqual((await _proposalRows(name)).filter(e => !e.committed).map(e => [e.itemNumber, e.changes.map(({ n, ne }) => ({ n, ne }))]), [
            ['CHAIR-003', [{ n: 'quantity', ne: '+2' }, { n: 'notes', ne: 'legs' }]],
            ['STOOL-002', [{ n: 'quantity', ne: '+1' }]]
        ], 'CHAIR-003 merged (quantity replaced, notes kept), STOOL-002 added');
        assertEqual(await ApplicationUtils.getSheetLock(PROPOSAL_LOCK_NAMESPACE, name, 'other@example.com'), null, 'lock released');
    } finally {
        await _asUser(() => Requests.saveInventoryProposalTable([], name));
    }
});

test('INVENTORY PROPOSALS', 'saveToProposal refuses while the proposal is locked, edited on another device, or has unsaved edits', async () => {
    const name = 'Lock test';
    const added = async (itemNumber) => {
        try { await _asUser(async () => saveToProposal(name, 'FURNITURE', [await _furnitureItem(itemNumber, [{ n: 'quantity', ne: '+1' }])])); return null; }
        catch (e) { return e.message; }
    };
    try {
        assertEqual(await added('CHAIR-001'), null, 'created');
        await ApplicationUtils.lockSheet(PROPOSAL_LOCK_NAMESPACE, name, 'other@example.com');
        assertEqual(/is locked/.test(await added('CHAIR-002') || ''), true, 'refused while another user holds the lock');
        await ApplicationUtils.unlockSheet(PROPOSAL_LOCK_NAMESPACE, name, 'other@example.com');
        // The same user editing it on another device: that session's lock is left alone
        await ApplicationUtils.lockSheet(PROPOSAL_LOCK_NAMESPACE, name, 'test@example.com', 'other-device');
        assertEqual(/another of your devices/.test(await added('CHAIR-002') || ''), true, 'refused while this user edits it on another device');
        assertEqual((await ApplicationUtils.getSheetLock(PROPOSAL_LOCK_NAMESPACE, name))?.deviceId, 'other-device', "the other device's lock kept");
        await ApplicationUtils.unlockSheet(PROPOSAL_LOCK_NAMESPACE, name, 'test@example.com');
        const store = proposalTableStore(name);
        for (let i = 0; i < 100 && (store.isLoading || store.initialLoad); i++) await new Promise(r => setTimeout(r, 50));
        store.data[0].notes = 'unsaved edit';
        const refused = await added('CHAIR-002');
        store.setData(store.originalData);
        assertEqual(/unsaved changes/.test(refused || ''), true, `refused with unsaved edits: ${refused}`);
        assertEqual((await _proposalRows(name)).map(e => e.itemNumber), ['CHAIR-001'], 'nothing added either time');
    } finally {
        await ApplicationUtils.unlockSheet(PROPOSAL_LOCK_NAMESPACE, name, 'other@example.com').catch(() => {});
        await ApplicationUtils.unlockSheet(PROPOSAL_LOCK_NAMESPACE, name, 'test@example.com').catch(() => {});
        await _asUser(() => Requests.saveInventoryProposalTable([], name));
    }
});

test('INVENTORY PROPOSALS', 'replaceActiveEntries and markCommitted only touch the named proposal', async () => {
    const entries = ProposalUtils.parseRows([
        { proposal: 'Spring buy', category: 'FURNITURE', itemNumber: 'CHAIR-001', changes: JSON.stringify([{ n: 'quantity', ne: '+8' }]), updatedBy: 'sam', updated: '5' },
        { proposal: 'Spring buy', category: 'FURNITURE', itemNumber: 'CHAIR-003', changes: JSON.stringify([{ n: 'quantity', ne: '+4' }]), updatedBy: 'sam', updated: '5' },
        { proposal: 'Spring buy', category: 'HANGING SIGNS', itemNumber: 'HS-001', changes: JSON.stringify([{ n: 'quantity', ne: '+2' }]), updatedBy: 'dan', updated: '5' },
        { proposal: 'Fall buy', category: 'FURNITURE', itemNumber: 'STOOL-001', changes: JSON.stringify([{ n: 'quantity', ne: '+4' }]), updated: '1', committedBy: 'dan', committed: '2' }
    ]);
    const row = (itemNumber, quantityChange) => ({ category: 'FURNITURE', itemNumber, quantityChange, description: '', currentDescription: '', notes: '', currentNotes: '' });
    // CHAIR-001 unchanged, CHAIR-003 edited, HS-001 removed from the page
    const replaced = ProposalUtils.replaceActiveEntries(entries, 'spring buy', [row('CHAIR-001', '8'), row('CHAIR-003', '6')], 'test', 99);
    const spring = ProposalUtils.entriesOf(replaced, 'Spring buy');
    assertEqual(spring.map(e => `${e.itemNumber} ${e.changes[0].ne} ${e.updatedBy}`), ['CHAIR-001 +8 sam', 'CHAIR-003 +6 test'], 'unchanged keeps its author; removed row dropped');
    assertEqual(ProposalUtils.entriesOf(replaced, 'Fall buy').length, 1, 'other proposal kept');
    let error = null;
    try { ProposalUtils.replaceActiveEntries(entries, 'Fall buy', [], 'test', 99); } catch (e) { error = e; }
    assertEqual(!!error, true, 'committed proposal refused');
    const marked = ProposalUtils.markCommitted(entries, 'Spring buy', ['FURNITURE'], 'test', 99);
    assertEqual(ProposalUtils.entriesOf(marked, 'Spring buy').map(e => e.committed), [99, 99, 0], 'only the committed category');
    assertEqual(ProposalUtils.isCommitted(ProposalUtils.entriesOf(marked, 'Spring buy')), false, 'partially committed is still active');
});

test('INVENTORY PROPOSALS', 'groupProposals lists active proposals before committed ones', async () => {
    const proposals = ProposalUtils.groupProposals(await Requests.getInventoryProposals());
    assertEqual(proposals.map(p => p.name), ['Spring buy', 'Cabinet fix', 'Fall buy'], 'order');
    assertEqual(proposals.map(p => !!p.committed), [false, false, true], 'committed flags');
    assertEqual(proposals[0].categories, ['FURNITURE', 'HANGING SIGNS'], 'categories');
    assertEqual(proposals[0].slug, 'spring-buy', 'slug');
});

test('INVENTORY PROPOSALS', 'proposal table joins current values and projects owned quantity by date', async () => {
    const rows = await Requests.getInventoryProposalTable('spring buy');
    assertEqual(rows.map(r => r.itemNumber), ['CHAIR-001', 'CHAIR-003', 'HS-001'], 'items');
    const chair3 = rows.find(r => r.itemNumber === 'CHAIR-003');
    assertEqual([chair3.currentQuantity, chair3.quantityChange, chair3.notes, chair3.currentNotes], ['12', '4', 'order matching legs', ''], 'joined values');
    const ds = (iso) => Math.floor(new Date(`${iso}T12:00:00`).getTime() / 100);
    assertEqual(ProposalUtils.projectQuantity(chair3, ds('2027-05-01')), 16, 'before the scheduled +6');
    assertEqual(ProposalUtils.projectQuantity(chair3, ds('2027-07-01')), 22, 'after the scheduled +6');
});

test('INVENTORY PROPOSALS', 'saving the proposal table replaces its rows and drops unchanged ones', async () => {
    const rows = (await Requests.getInventoryProposalTable('Cabinet fix')).map(r => ({ ...r }));
    rows[0].quantityChange = '-2';
    rows[0].description = 'Curved counter';
    await _asUser(() => Requests.saveInventoryProposalTable(rows, 'Cabinet fix'));
    assertEqual((await _proposalRows('Cabinet fix'))[0].changes, [{ n: 'quantity', ne: '-2' }, { n: 'description', ne: 'Curved counter' }], 'changes saved');
    assertEqual((await _proposalRows('Spring buy')).length, 3, 'other proposals untouched');
});

// Removing an item from a proposal follows the delete design: the remove button marks the row
// (store.toggleRowDeletion) and saving takes the marked rows out. The test makes a two-item
// proposal (CHAIR-001, CHAIR-002) and empties it afterwards.
test('INVENTORY PROPOSALS', 'removing an item marks it; saving takes it out of the proposal', async () => {
    const name = 'Removal test';
    await _asUser(async () => saveToProposal(name, 'FURNITURE', [
        await _furnitureItem('CHAIR-001', [{ n: 'quantity', ne: '+1' }]),
        await _furnitureItem('CHAIR-002', [{ n: 'quantity', ne: '+2' }])
    ]));
    const store = await _loadedStore(Requests.getInventoryProposalTable, Requests.saveInventoryProposalTable, [name]);
    try {
        const row = store.data.find(r => r.itemNumber === 'CHAIR-001');
        assertEqual(store.indexOfRow({ AppData: { _rowId: row.AppData._rowId } }), store.data.indexOf(row), 'found by row id');
        assertEqual([store.toggleRowDeletion(row), store.toggleRowDeletion(row), isMarkedForDeletion(row), store.isModified], [true, true, false, false], 'toggles back, unmodified');
        store.toggleRowDeletion(row);
        assertEqual([store.data.length, (await _proposalRows(name)).length], [2, 2], 'marked: still in the proposal until saved');
        await _asUser(() => store.save('Saving proposal...'));
        assertEqual((await _proposalRows(name)).filter(e => !e.committed).map(e => e.itemNumber), ['CHAIR-002'], 'saved: the marked item is out');
    } finally {
        await _asUser(() => Requests.saveInventoryProposalTable([], name));
    }
});

// New Item adds an item picked from inventory (InventorySelectorModal) as a row with no changes,
// built as the proposal page builds it (ProposalUtils.toTableRow). A row saves an entry once it has
// a change. The test empties the proposal afterwards.
test('INVENTORY PROPOSALS', 'an item added from inventory joins the proposal once it has a change', async () => {
    const name = 'Add test';
    await _asUser(async () => saveToProposal(name, 'FURNITURE', [await _furnitureItem('CHAIR-001', [{ n: 'quantity', ne: '+1' }])]));
    const store = await _loadedStore(Requests.getInventoryProposalTable, Requests.saveInventoryProposalTable, [name]);
    try {
        const inventory = await Requests.getAllInventoryData(todayISOString());
        const picked = ['STOOL-002', 'COUCH-001'].map(itemNumber => inventory.find(row => row.itemNumber === itemNumber));
        for (const item of picked) {
            store.addRow(ProposalUtils.toTableRow({ category: item.tab, itemNumber: item.itemNumber, changes: [] }, item));
        }
        assertEqual(store.data.slice(1).map(row => [row.category, row.itemNumber, row.currentQuantity, row.quantityChange]),
            picked.map(item => ['FURNITURE', item.itemNumber, item.quantity, '0']), "added with the item's current values, no change");
        store.data.find(row => row.itemNumber === 'STOOL-002').quantityChange = '3';
        await _asUser(() => store.save('Saving proposal...'));
        assertEqual((await _proposalRows(name)).filter(e => !e.committed).map(e => [e.itemNumber, e.changes]),
            [['CHAIR-001', [{ n: 'quantity', ne: '+1' }]], ['STOOL-002', [{ n: 'quantity', ne: '+3' }]]], 'the changed item joined; the unchanged one saved nothing');
    } finally {
        await _asUser(() => Requests.saveInventoryProposalTable([], name));
    }
});

// One entry per item whatever the rows: saving keeps the last row for an item (two entries would
// apply its change twice at commit).
test('INVENTORY PROPOSALS', 'a repeated item saves one entry, from the last row', async () => {
    const row = (itemNumber, quantityChange) => ({ category: 'FURNITURE', itemNumber, quantityChange, description: '', currentDescription: '', notes: '', currentNotes: '' });
    const saved = ProposalUtils.replaceActiveEntries([], 'Paste test', [row('CHAIR-001', '2'), row('CHAIR-002', '1'), row('CHAIR-001', '5')], 'test', 100);
    assertEqual(saved.map(e => [e.itemNumber, e.changes]), [['CHAIR-002', [{ n: 'quantity', ne: '+1' }]], ['CHAIR-001', [{ n: 'quantity', ne: '+5' }]]], 'one entry per item');
    const cleared = ProposalUtils.replaceActiveEntries([], 'Paste test', [row('CHAIR-001', '2'), row('CHAIR-001', '0')], 'test', 100);
    assertEqual(cleared, [], 'the last row has no change: no entry');
});

test('INVENTORY PROPOSALS', 'committed proposals cannot be edited', async () => {
    let error = null;
    try { await Requests.saveInventoryProposalTable([], 'Fall buy'); } catch (e) { error = e; }
    assertEqual(!!error, true, 'save refused');
    assertEqual((await _proposalRows('Fall buy')).length, 1, 'committed row kept');
});

test('INVENTORY PROPOSALS', 'commit refuses when a category has unsaved edits', async () => {
    const store = getReactiveStore(Requests.getInventoryTabData, Requests.saveInventoryTabData, ['FURNITURE', undefined, undefined, undefined]);
    for (let i = 0; i < 100 && (store.isLoading || store.initialLoad); i++) await new Promise(r => setTimeout(r, 50));
    store.data[0].notes = 'unsaved edit';
    let error = null;
    try { await _asUser(() => commitInventoryProposal('Spring buy', new Date().toISOString().slice(0, 10), 'proposal: Spring buy')); } catch (e) { error = e; }
    store.setData(store.originalData);
    assertEqual(/unsaved changes in FURNITURE/.test(error?.message || ''), true, `refused: ${error?.message}`);
    assertEqual((await _proposalRows('Spring buy')).every(e => !e.committed), true, 'nothing committed');
});

test('INVENTORY PROPOSALS', 'commit changes nothing when a category is locked by another user', async () => {
    let error = null;
    try { await _asUser(() => commitInventoryProposal('Cabinet fix', new Date().toISOString().slice(0, 10), 'proposal: Cabinet fix')); } catch (e) { error = e; }
    assertEqual(/CABINETS is locked/.test(error?.message || ''), true, `refused: ${error?.message}`);
    const cab = (await Requests.getInventoryTabData('CABINETS')).find(r => r.itemNumber === 'CAB-004');
    assertEqual(cab.quantity, '10', 'quantity unchanged');
    assertEqual((await _proposalRows('Cabinet fix'))[0].committed, 0, 'not committed');
});

test('INVENTORY PROPOSALS', "commit leaves alone a category this user is editing on another device", async () => {
    await ApplicationUtils.lockSheet('INVENTORY', 'FURNITURE', 'test@example.com', 'other-device');
    let error = null;
    try { await _asUser(() => commitInventoryProposal('Spring buy', new Date().toISOString().slice(0, 10), 'proposal: Spring buy')); } catch (e) { error = e; }
    const lock = await ApplicationUtils.getSheetLock('INVENTORY', 'FURNITURE');
    await ApplicationUtils.unlockSheet('INVENTORY', 'FURNITURE', 'test@example.com');
    assertEqual(error?.message, 'FURNITURE is being edited on another of your devices. Nothing was committed.', 'refused');
    assertEqual(lock?.deviceId, 'other-device', "the other device's lock kept");
    assertEqual((await _proposalRows('Spring buy')).every(e => !e.committed), true, 'nothing committed');
});

// The save dialog's Proposal button, from the category table or the categories view, sends edits
// with sendEditsToProposal: an item new to the category is first created in inventory at quantity
// 0 (so the proposal can commit it) and the proposal holds its quantity. The test adds CHAIR-900
// (quantity 3) and changes CHAIR-001 by +1, then puts FURNITURE back.
test('INVENTORY PROPOSALS', 'sendEditsToProposal creates new items at 0 and proposes their quantity', async () => {
    const name = 'Send test';
    const store = await _loadedStore(Requests.getInventoryTabData, Requests.saveInventoryTabData, ['FURNITURE', undefined, undefined, undefined]);
    const saved = (await Requests.getInventoryTabData('FURNITURE')).map(row => ({ ...row }));
    const fieldNames = Object.keys(store.data[0]).filter(key => key !== 'AppData');
    const edit = () => {
        const chair = store.data.find(row => row.itemNumber === 'CHAIR-001');
        chair.quantity = String(Number(chair.quantity) + 1);
        store.addRow({ itemNumber: 'CHAIR-900', quantity: '3', description: 'Test chair' }, fieldNames);
    };
    try {
        edit();
        assertEqual(await _asUser(() => sendEditsToProposal(store, 'FURNITURE', name, async () => false)), false, 'declined: nothing sent');
        assertEqual([(await _proposalRows(name)).length, store.isModified], [0, true], 'declined: no proposal, edits kept');
        assertEqual(await _asUser(() => sendEditsToProposal(store, 'FURNITURE', name, async () => true)), true, 'sent');
        const created = (await Requests.getInventoryTabData('FURNITURE')).find(row => row.itemNumber === 'CHAIR-900');
        assertEqual(created?.quantity, '0', 'CHAIR-900 created in inventory at 0');
        assertEqual((await _proposalRows(name)).map(e => [e.itemNumber, e.changes.map(({ n, ne }) => `${n}=${ne}`).join(',')]),
            [['CHAIR-001', 'quantity=+1'], ['CHAIR-900', 'quantity=+3']], 'both proposed');
        assertEqual(store.isModified, false, 'edits dropped from the category store');
    } finally {
        store.setData(store.originalData);
        await _asUser(() => Requests.saveInventoryProposalTable([], name));
        await _asUser(() => Requests.saveInventoryTabData(saved, 'FURNITURE'));
        await store.load('Loading...');
    }
});

test('INVENTORY PROPOSALS', 'hasQuantityChanges pairs rows by their history id, not item number', async () => {
    const row = (itemNumber, quantity, i) => ({ itemNumber, quantity, edithistory: i ? JSON.stringify({ i }) : '' });
    const originalData = [row('A-1', '5', 1), row('A-1', '2', 2), row('', '7', 3)];
    assertEqual(hasQuantityChanges({ originalData, data: [row('A-1', '5', 1), row('A-1', '2', 2), row('', '7', 3)] }), false, 'unchanged');
    assertEqual(hasQuantityChanges({ originalData, data: [row('A-1', '5', 1), row('A-1', '4', 2), row('', '7', 3)] }), true, 'the second A-1 changed');
    assertEqual(hasQuantityChanges({ originalData, data: [row('A-1', '5', 1), row('A-1', '2', 2), row('', '9', 3)] }), true, 'a row without an item number changed');
    assertEqual(hasQuantityChanges({ originalData, data: [...originalData, row('B-1', '3')] }), false, 'a new row is not a quantity change');
});

test('INVENTORY PROPOSALS', 'commit applies every category with the note and marks the proposal committed', async () => {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const result = await _asUser(() => commitInventoryProposal('Spring buy', iso, 'proposal: Spring buy'));
    assertEqual(result, { committed: ['FURNITURE', 'HANGING SIGNS'], failed: [] }, 'both categories saved');
    const furniture = await Requests.getInventoryTabData('FURNITURE');
    const chair1 = furniture.find(r => r.itemNumber === 'CHAIR-001');
    const chair3 = furniture.find(r => r.itemNumber === 'CHAIR-003');
    assertEqual([chair1.quantity, chair3.quantity, chair3.notes], ['28', '16', 'order matching legs'], 'FURNITURE changed');
    assertEqual(JSON.parse(chair1.edithistory).h[0].s, 'proposal: Spring buy', 'history note');
    const sign = (await Requests.getInventoryTabData('HANGING SIGNS')).find(r => r.itemNumber === 'HS-001');
    assertEqual(sign.quantity, '2', 'HANGING SIGNS changed');
    assertEqual((await _proposalRows('Spring buy')).every(e => e.committed && e.committedBy === 'test'), true, 'rows committed');
    assertEqual(await Requests.getSheetLock('INVENTORY', 'FURNITURE'), null, 'FURNITURE lock released');
});

// ── NOTE LENGTH (InventoryNoteMaxLength preference) ───────────────────────────

test('NOTE LENGTH', 'resolveInventoryNoteMaxLength reads the preference and falls back to 25', async () => {
    const pref = (value) => [{ id: 'InventoryNoteMaxLength', value }];
    assertEqual(resolveInventoryNoteMaxLength(pref('10')), 10, 'integer value');
    assertEqual([resolveInventoryNoteMaxLength(null), resolveInventoryNoteMaxLength([])], [25, 25], 'missing');
    assertEqual(['abc', '0', '-3'].map(v => resolveInventoryNoteMaxLength(pref(v))), [25, 25, 25], 'invalid');
    assertEqual(await Requests.getInventoryNoteMaxLength(), 25, 'fixture preference');
});

test('NOTE LENGTH', 'proposal names and commit notes follow the note limit', async () => {
    assertEqual([ProposalUtils.nameMaxLength(25), ProposalUtils.nameMaxLength(20), ProposalUtils.nameMaxLength(5)], [15, 10, 1], 'name limits');
    assertEqual(ProposalUtils.validateName('Eleven char', [], 20), 'Use at most 10 characters', 'shorter limit');
    assertEqual(ProposalUtils.commitNote('Spring buy', 15), 'proposal: Sprin', 'commit note truncated');
});

test('NOTE LENGTH', 'inventory saves truncate notes to the preference', async () => {
    const setLimit = async (value) => {
        const prefs = (await Requests.getPreferences()).map(p => ({ ...p, value: p.id === 'InventoryNoteMaxLength' ? value : p.value }));
        await _asUser(() => Requests.savePreferences(prefs));
    };
    await setLimit('10');
    try {
        assertEqual(await Requests.getInventoryNoteMaxLength(), 10, 'preference change picked up');
        const rows = (await Requests.getInventoryTabData('FURNITURE')).map(r => ({ ...r }));
        rows.find(r => r.itemNumber === 'STOOL-003').quantity = '21';
        await _asUser(() => Requests.saveInventoryTabData(rows, 'FURNITURE', undefined, undefined, undefined, { note: 'a long recount note' }));
        const saved = (await Requests.getInventoryTabData('FURNITURE')).find(r => r.itemNumber === 'STOOL-003');
        assertEqual(JSON.parse(saved.edithistory).h[0].s, 'a long rec', 'note truncated to 10');
    } finally {
        await setLimit('25');
    }
});

// ── Views system: pure functions (views-and-renderers-plan §4) ───────────────
// resolveView / resolveAction, the shared search matcher, value formatting,
// colour rules and size tiers. These are pure and run without the DOM; they lock in the
// contracts every renderer relies on.

const V_FIELDS = ['Show', 'Client', 'Ship', 'Recieved', 'S. Start', 'S. End', 'City', 'Size', 'Year', 'Booth#', 'AppData', 'packlist']
    .map(key => ({ key, label: key }));
const V_TABLE = {
    id: 'table', layout: 'table',
    columns: ['Show', 'Client', ['Ship', 'Recieved'], ['S. Start', 'S. End'], 'City', 'Size', 'packlist'],
    style: { Ship: { color: 'auto', width: 120 }, 'S*': { font: 'narrow' } },
    variants: { narrow: { columns: [['Show', 'Client'], ['Ship', 'Recieved'], ['S. Start', 'S. End'], 'packlist'] } }
};
const V_CAL = { id: 'calendar', layout: 'calendar', calendar: { start: 'S. Start', end: 'S. End', chip: [['Show', 'Client'], ['City', 'Size']] } };

function withViewWarnings(fn) {
    const warnings = [];
    setViewWarningHandler(m => warnings.push(m));
    try { return { result: fn(), warnings }; } finally { setViewWarningHandler(null); }
}

test('VIEWS ENGINE', 'tiers: columns shown, unlisted to details (rest), AppData always hidden', async () => {
    const { result: r } = withViewWarnings(() => resolveView(V_FIELDS, V_TABLE));
    assertEqual(r.slots.map(s => s.lines), [[['Show']], [['Client']], [['Ship'], ['Recieved']], [['S. Start'], ['S. End']], [['City']], [['Size']], [['packlist']]], 'slots');
    assertEqual(r.details.map(f => f.key), ['Year', 'Booth#'], 'details rest');
    assertEqual(r.hidden.has('AppData'), true, 'AppData hidden');
    assertEqual(r.hasDetails, true, 'hasDetails');
});

test('VIEWS ENGINE', 'hidden list removes fields from every tier; hidden rest hides unlisted', async () => {
    const { result: r1 } = withViewWarnings(() => resolveView(V_FIELDS, { ...V_TABLE, hidden: ['Year'] }));
    assertEqual(r1.details.map(f => f.key), ['Booth#'], 'Year hidden');
    const { result: r2 } = withViewWarnings(() => resolveView(V_FIELDS, { ...V_TABLE, details: ['Year'], hidden: 'rest' }));
    assertEqual(r2.details.map(f => f.key), ['Year'], 'explicit details');
    assertEqual(r2.hidden.has('Booth#'), true, 'Booth# hidden by rest');
});

test('VIEWS ENGINE', 'first tier wins on duplicates and unknown keys are ignored with a warning', async () => {
    const { result: r, warnings } = withViewWarnings(() => resolveView(V_FIELDS, { id: 'x', layout: 'table', columns: ['Show', 'Nope', 'Show'], details: ['Show', 'Year'] }));
    assertEqual(r.slots.map(s => s.key), ['Show'], 'Show once');
    assertEqual(r.details.map(f => f.key).includes('Show'), false, 'Show not in details');
    if (!warnings.some(w => w.includes('"Nope"'))) throw new Error('expected unknown-key warning');
    if (!warnings.some(w => w.includes('duplicate key "Show"'))) throw new Error('expected duplicate warning');
});

test('VIEWS ENGINE', 'narrow variant replaces columns; medium/wide keep them', async () => {
    const { result: wide } = withViewWarnings(() => resolveView(V_FIELDS, V_TABLE, { size: 'wide' }));
    const { result: medium } = withViewWarnings(() => resolveView(V_FIELDS, V_TABLE, { size: 'medium' }));
    const { result: narrow } = withViewWarnings(() => resolveView(V_FIELDS, V_TABLE, { size: 'narrow' }));
    assertEqual(wide.slots.length, 7, 'wide');
    assertEqual(medium.slots.length, 7, 'medium');
    assertEqual(narrow.slots[0].lines, [['Show'], ['Client']], 'narrow stacks Client under Show');
    assertEqual(narrow.details.map(f => f.key).includes('City'), true, 'City moves to details when narrow');
});

test('VIEWS ENGINE', 'presentation comes from the view: style props, sortable list, type cells; fields keep data only', async () => {
    const fields = [
        { key: 'item', label: 'Item#', type: 'item' },
        { key: 'done', label: 'Done', type: 'checkbox' },
        { key: 'who', label: 'Who', type: 'select', options: ['A', 'B'] },
        { key: 'pic', label: 'IMG', cell: 'image', sortable: true }
    ];
    const view = {
        id: 'v', layout: 'table', columns: ['pic', 'item', 'done', 'who'],
        sortable: ['item', 'w*'],
        style: { pic: { width: 1, cell: 'image', labelHtml: '<i>img</i>', cellOptions: { itemKey: 'item' } }, item: { label: 'No.', title: 'Item number' } }
    };
    const { result: r, warnings } = withViewWarnings(() => resolveView(fields, view));
    const f = (k) => r.fieldMap.get(k);
    assertEqual([f('item').label, f('item').title, f('item').sortable, f('who').sortable, f('done').sortable], ['No.', 'Item number', true, true, false], 'label, title, sortable (patterns)');
    assertEqual([f('pic').cell, f('pic').labelHtml, f('pic').cellOptions, f('done').cell, f('who').cell, f('who').options], ['image', '<i>img</i>', { itemKey: 'item' }, 'checkbox', 'select', ['A', 'B']], 'view cells, type cells, data options');
    assertEqual(warnings.filter(w => /presentation props \(sortable, cell\)/.test(w)).length, 1, 'presentation on a field warns');
    const bare = resolveView([{ key: 'pic', cell: 'image' }], { id: 'b', layout: 'table', columns: ['pic'] });
    assertEqual(bare.fieldMap.get('pic').cell, undefined, 'and is ignored');
});

test('VIEWS ENGINE', 'calendar.actions: keys drawn in the chip end bar are shown; print variants can change cell options', async () => {
    const fields = ['s', 'e', 'a', 'b', 'c'].map(key => ({ key, label: key }));
    const view = {
        id: 'cal', layout: 'calendar',
        calendar: { start: 's', end: 'e', chip: [['a']], actions: ['b', 'nope'] },
        hidden: ['s', 'e', 'c'],
        style: { b: { cell: 'showList', cellOptions: { max: 2 } } },
        variants: { print: { style: { b: { cellOptions: { max: null } } } } }
    };
    const { result: r, warnings } = withViewWarnings(() => resolveView(fields, view));
    assertEqual([r.calendar.actions, r.shown], [['b'], ['a', 'b']], 'actions shown after the chip lines');
    assertEqual(warnings.some(w => /unknown key "nope" in calendar.actions/.test(w)), true, 'unknown key warns');
    const printed = resolveView(fields, view, { print: true });
    assertEqual([r.fieldMap.get('b').cellOptions.max, printed.fieldMap.get('b').cellOptions.max], [2, null], 'print variant');
});

test('VIEWS ENGINE', 'registry style and sortable apply to every view; a view overrides them', async () => {
    const registry = { style: { a: { width: 10, cell: 'slot' } }, sortable: ['a'], views: [] };
    const merged = withRegistryDefaults(registry, { id: 'v', style: { a: { width: 20 } }, sortable: ['b'] });
    assertEqual([merged.style.a, merged.sortable], [{ width: 20, cell: 'slot' }, ['b']], 'style merges, lists replace');
    const plain = { id: 'p' };
    assertEqual(withRegistryDefaults({ views: [] }, plain) === plain, true, 'no registry defaults: the view itself');
});

test('VIEWS ENGINE', 'patches apply after variants and respect sizes', async () => {
    const patches = [{ patch: { columns: ['Client', 'Show'] }, sizes: ['narrow'] }, { patch: { hidden: ['Booth#'] } }];
    const { result: wide } = withViewWarnings(() => resolveView(V_FIELDS, V_TABLE, { size: 'wide', patches }));
    const { result: narrow } = withViewWarnings(() => resolveView(V_FIELDS, V_TABLE, { size: 'narrow', patches }));
    assertEqual(wide.slots.length, 7, 'narrow-only patch ignored when wide');
    assertEqual(wide.hidden.has('Booth#'), true, 'all-size patch applied');
    assertEqual(narrow.slots.map(s => s.key), ['Client', 'Show'], 'narrow patch applied');
});

test('VIEWS ENGINE', 'print variant applies last (PacklistTable items: Pack/Check shown when printing)', async () => {
    const fields = ['Pack', 'Check', 'Description', 'Packing/shop notes'].map(key => ({ key }));
    const view = { id: 'items', layout: 'table', hidden: ['Pack', 'Check'], variants: { narrow: { hidden: ['Pack', 'Check', 'Packing/shop notes'] }, print: { hidden: [] } } };
    const screen = withViewWarnings(() => resolveView(fields, view)).result;
    const printed = withViewWarnings(() => resolveView(fields, view, { print: true, size: 'narrow' })).result;
    assertEqual(screen.slots.map(s => s.key), ['Description', 'Packing/shop notes'], 'screen');
    assertEqual(printed.slots.map(s => s.key), ['Pack', 'Check', 'Description', 'Packing/shop notes'], 'print wins over narrow');
});

test('VIEWS ENGINE', 'mergeView merges objects deeply and replaces arrays', async () => {
    const merged = mergeView({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] }, e: 2 });
    assertEqual(merged, { a: { b: 1, c: [3] }, d: 1, e: 2 }, 'merge');
});

test('VIEWS ENGINE', 'key patterns expand in lists and style', async () => {
    const fields = ['itemId', 'show_A', 'show_B', 'qty'].map(key => ({ key }));
    const { result: r } = withViewWarnings(() => resolveView(fields, { id: 'p', layout: 'table', columns: ['itemId', 'show_*'], style: { 'show_*': { columnColor: 'striped gray' }, show_B: { width: 50 } } }));
    assertEqual(r.slots.map(s => s.key), ['itemId', 'show_A', 'show_B'], 'pattern columns');
    assertEqual(r.style.show_B, { columnColor: 'striped gray', width: 50 }, 'pattern + exact style');
    assertEqual(matchesKeyPattern('show_*', 'show_X'), true, 'pattern match');
    assertEqual(matchesKeyPattern('show', 'show_X'), false, 'exact');
});

test('VIEWS ENGINE', 'table without columns shows every non-placed field', async () => {
    const { result: r } = withViewWarnings(() => resolveView([{ key: 'a' }, { key: 'b' }, { key: 'c' }], { id: 'all', layout: 'table', hidden: ['c'] }));
    assertEqual(r.slots.map(s => s.key), ['a', 'b'], 'all shown');
    assertEqual(r.hasDetails, false, 'no details');
});

test('VIEWS ENGINE', "action 'row' falls back to 'button' when editMode is not none", async () => {
    const { result: r, warnings } = withViewWarnings(() => resolveView(V_FIELDS, { ...V_TABLE, action: 'row' }, { editMode: 'batch' }));
    assertEqual(r.trigger, 'button', 'trigger');
    if (!warnings.some(w => w.includes("action 'row'"))) throw new Error('expected warning');
    const { result: r2 } = withViewWarnings(() => resolveView(V_FIELDS, { ...V_TABLE, action: 'row' }));
    assertEqual(r2.trigger, 'row', 'row allowed read-only');
});

test('VIEWS ENGINE', 'calendar view: chip lines shown, missing start/end flagged invalid', async () => {
    const { result: r } = withViewWarnings(() => resolveView(V_FIELDS, V_CAL));
    assertEqual(r.shown, ['Show', 'Client', 'City', 'Size'], 'chip keys shown');
    assertEqual(r.invalid, null, 'valid');
    const { result: bad } = withViewWarnings(() => resolveView(V_FIELDS, { ...V_CAL, calendar: { ...V_CAL.calendar, start: 'Nope' } }));
    assertEqual(bad.invalid, 'calendar-fields', 'invalid');
});

test('VIEWS ENGINE', 'pickView: view param, legacy layout fallback, unknown id → default', async () => {
    const reg = { id: 'schedule', default: 'table', views: [V_TABLE, V_CAL] };
    withViewWarnings(() => {
        assertEqual(pickView(reg, {}).id, 'table', 'default');
        assertEqual(pickView(reg, { view: 'calendar' }).id, 'calendar', 'view param');
        assertEqual(pickView(reg, { layout: 'calendar' }).id, 'calendar', 'layout fallback');
        assertEqual(pickView(reg, { view: 'bogus' }).id, 'table', 'unknown → default');
    });
});

test('VIEWS ENGINE', 'resolved output: stacked lines, style, sticky, colour rules, hidden omitted', async () => {
    const view = { ...V_TABLE, table: { sticky: { start: ['Show'] } } };
    const { result: r } = withViewWarnings(() => resolveView(V_FIELDS, view));
    const ship = r.slots.find(s => s.key === 'Ship');
    assertEqual(ship.lines, [['Ship'], ['Recieved']], 'stack lines');
    assertEqual([ship.width, ship.color], [120, 'auto'], 'slot style');
    assertEqual(r.slots.find(s => s.key === 'Show').sticky, 'start', 'sticky');
    assertEqual(r.slots.some(s => s.key === 'AppData'), false, 'hidden omitted');
    assertEqual(r.shown.includes('Recieved'), true, 'stacked keys are shown');
    const { result: cal } = withViewWarnings(() => resolveView(V_FIELDS, V_CAL));
    assertEqual(cal.calendar.chip, [['Show', 'Client'], ['City', 'Size']], 'chip lines');
    const legacy = withViewWarnings(() => resolveView([{ key: 'a', width: 50 }], { id: 'l', layout: 'table' }));
    assertEqual([legacy.result.style.a, legacy.warnings.length > 0], [undefined, true], 'legacy field props ignored with a warning');
});

test('VIEWS ACTION', 'page action wins, then details, then none', async () => {
    const { result: r } = withViewWarnings(() => resolveView(V_FIELDS, V_TABLE));
    assertEqual(resolveAction({ to: () => 'x' }, r).kind, 'navigate', 'to');
    assertEqual(withViewWarnings(() => resolveAction({ run: () => {}, label: 'Select' }, r)).result.label, 'Select', 'run label');
    assertEqual(resolveAction(null, r).kind, 'details', 'details');
    const { result: noDetails } = withViewWarnings(() => resolveView([{ key: 'a' }], { id: 'n', layout: 'table', columns: ['a'] }));
    assertEqual(resolveAction(null, noDetails).kind, 'none', 'none');
    assertEqual(resolveAction(null, noDetails, { hasRowDetails: true }).kind, 'details', 'row-details slot');
});

test('VIEWS ACTION', 'both to and run → to, with a warning', async () => {
    const { result: r } = withViewWarnings(() => resolveView([{ key: 'a' }], { id: 'n', layout: 'table', columns: ['a'] }));
    const { result: a, warnings } = withViewWarnings(() => resolveAction({ to: () => 'x', run: () => {} }, r));
    assertEqual(a.kind, 'navigate', 'to wins');
    if (!warnings.length) throw new Error('expected warning');
});

test('VIEWS SEARCH', 'makeHighlighter escapes, wraps matches and merges overlaps', async () => {
    const h = makeHighlighter(['ab', 'bc']);
    assertEqual(h('xABCx <b>'), 'x<span class="search-match">ABC</span>x &lt;b&gt;', 'merged, case-insensitive, escaped');
    assertEqual([makeHighlighter([])('<i>'), h(null), h(0)], ['&lt;i&gt;', '', '0'], 'no words only escapes');
    assertEqual(makeHighlighter(['a.b'])('a.b axb'), '<span class="search-match">a.b</span> axb', 'regex characters are literal');
});

test('VIEWS SEARCH', 'searchWords drops words shorter than 2 characters', async () => {
    assertEqual(searchWords('a TV  15 x'), ['tv', '15'], 'words');
    assertEqual(searchWords('a b'), [], 'inactive');
    assertEqual(SEARCH_LIMITS.minTermLength, 2, 'limit');
});

test('VIEWS SEARCH', 'matchRow: AND across words, shown vs details, arrays matched', async () => {
    const tiers = { shown: ['Show', 'Client'], details: ['Notes', 'Shows'] };
    const row = { Show: 'Expo', Client: 'ACME', Notes: 'blue booth', Shows: ['NAB 2025', 'CES'] };
    assertEqual(matchRow(row, tiers, ['acme', 'expo']).shownMatch, true, 'shown match');
    const d = matchRow(row, tiers, ['acme', 'booth']);
    assertEqual([d.matched, d.shownMatch, d.detailMatches], [true, false, ['Notes']], 'details-only');
    assertEqual(matchRow(row, tiers, ['nab']).matched, true, 'array element');
    assertEqual(matchRow(row, tiers, ['acme', 'zzz']).matched, false, 'AND');
});

test('VIEWS SEARCH', 'matchRows aborts a broad search over 100 rows', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({ Show: 'S' + i, Client: i < 10 ? 'ACME' : 'other' }));
    const tiers = { shown: ['Show', 'Client'], details: [] };
    const precise = matchRows(rows, tiers, searchWords('acme'));
    assertEqual([precise.aborted, precise.matchCount], [false, 10], 'precise');
    const broad = matchRows(rows, tiers, searchWords('other'));
    assertEqual([broad.aborted, broad.matchCount, broad.results.length], [true, Infinity, 0], 'aborted');
    const small = matchRows(rows.slice(0, 50), tiers, searchWords('s'));
    assertEqual(small.active, false, 'single char inactive');
    const smallBroad = matchRows(rows.slice(10, 60), tiers, searchWords('other'));
    assertEqual(smallBroad.aborted, false, 'no abort at or under 100 rows');
});

test('VIEWS FORMAT', 'formatValue matches the table formatter', async () => {
    assertEqual(formatValue(null, { format: 'date' }), '', 'null');
    assertEqual(formatValue('2026-03-05', { format: 'date' }), '03/05/2026', 'date');
    assertEqual(formatValue('12.5', { format: 'currency' }), '$12.50', 'currency');
    assertEqual(formatValue('abc', {}), 'abc', 'passthrough');
    assertEqual(formatText(['a', 'b'], {}), 'a, b', 'array text');
});

test('VIEWS COLOR', 'colour rules: auto numbers/dates, value, literal; rowColor fallback', async () => {
    assertEqual(applyColorRule('auto', -1, { format: 'number' }), 'red', 'negative');
    assertEqual(applyColorRule('auto', 0, { format: 'number' }), 'orange', 'zero');
    assertEqual(applyColorRule('auto', 5, { format: 'number' }), '', 'positive');
    assertEqual(applyColorRule('auto', '', { format: 'number' }), '', 'blank');
    assertEqual(['X', 'true', '', '-', '8/1'].map(v => applyColorRule('checked:gray', v)), ['gray', 'gray', '', '', ''], 'checked:<class>');
    assertEqual(applyColorRule('value', 'gray', {}), 'gray', 'value');
    assertEqual(applyColorRule('purple', 'x', {}), 'purple', 'literal');
    const today = todayISOString();
    assertEqual(applyColorRule('auto', today, { format: 'date' }), 'red', 'date today');
    const resolved = { rowColor: { field: 'quantity', rule: 'auto', fallback: 'green' }, fieldMap: new Map([['quantity', { key: 'quantity', format: 'number' }]]), style: { quantity: { color: 'auto' } } };
    assertEqual(rowColorFor({ quantity: 3 }, resolved), 'green', 'fallback');
    assertEqual(rowColorFor({ quantity: -2 }, resolved), 'red', 'auto row');
    assertEqual(colorFor({ quantity: 0 }, { key: 'quantity', format: 'number' }, resolved), 'orange', 'cell colour');
});

test('VIEWS COLOR', 'colour rules: sign and differs (the proposal table)', async () => {
    const sign = 'sign:proposal-increase:proposal-decrease';
    assertEqual(['8', '+3', '-2', '0', '', 'x'].map(v => applyColorRule(sign, v)), ['proposal-increase', 'proposal-increase', 'proposal-decrease', '', '', ''], 'sign');
    assertEqual(applyColorRule('sign::red', 4), '', 'empty positive class');
    const resolved = { style: { description: { color: 'differs:currentDescription:proposal-changed' } } };
    const field = { key: 'description' };
    assertEqual(colorFor({ description: 'New', currentDescription: 'Old' }, field, resolved), 'proposal-changed', 'differs');
    assertEqual(colorFor({ description: 'Same', currentDescription: 'Same' }, field, resolved), '', 'same text');
    assertEqual(colorFor({ description: '', currentDescription: undefined }, field, resolved), '', 'blank and missing are equal');
    assertEqual(applyColorRule('differs:currentDescription:proposal-changed', 'New'), '', 'no row, no colour');
});

test('VIEWS SIZE', 'container and viewport tiers use the shared breakpoints', async () => {
    assertEqual([containerTier(360), containerTier(599), containerTier(600), containerTier(999), containerTier(1000)], ['narrow', 'narrow', 'medium', 'medium', 'wide'], 'container');
    assertEqual([viewportTier(615), viewportTier(616), viewportTier(1023), viewportTier(1024)], ['narrow', 'medium', 'medium', 'wide'], 'viewport');
    assertEqual(BREAKPOINTS, { narrow: 600, wide: 1000, gutterCompact: 8, gutterFull: 12 }, 'constants');
});

test('VIEWS CARDS', 'rowsToCards: title, escaped content lines, footer, rowColor, decorations', async () => {
    const fields = [{ key: 'title' }, { key: 'ship' }, { key: 'desc', format: 'multiline' }, { key: '_status' }, { key: '_color' }];
    const view = { id: 'cards', layout: 'cards', cards: { card: [['title'], ['ship'], ['desc']], footer: [['_status']] }, hidden: ['_color'], rowColor: { field: '_color', rule: 'value' } };
    const r = withViewWarnings(() => resolveView(fields, view)).result;
    const rows = [{ title: 'ACME 2026 <EXPO>', ship: 'Ship: 1/2', desc: '2 crates<br>5 items', _status: 'Unsaved changes', _color: 'red', sheetId: 7 }];
    const decorations = (row, key) => key === null ? [{ message: 'Save', class: 'green', action: () => {} }, { status: true, message: 'Locked' }] : [];
    const [card] = rowsToCards(rows, r, { decorations, idKey: 'sheetId' });
    assertEqual(card.title, 'ACME 2026 <EXPO>', 'title is plain text');
    assertEqual(card.content, 'Ship: 1/2<br>2 crates<br>5 items', 'content lines, multiline breaks');
    assertEqual(card.contentFooter, 'Unsaved changes<br>Locked', 'footer line + status decoration');
    assertEqual(card.footerActions.map(a => a.label), ['Save'], 'footer actions');
    assertEqual([card.cardClass, card.id], ['red', 7], 'rowColor and id');
    const [escaped] = rowsToCards([{ title: 'x', ship: '<b>bold</b>', desc: '' }], r);
    assertEqual(escaped.content, '&lt;b&gt;bold&lt;/b&gt;', 'values escaped');
});

test('VIEWS CARDS', 'bucketRowsToCards: buckets by key, empty buckets seeded, no details', async () => {
    const fields = [{ key: 'tab' }, { key: 'itemNumber' }, { key: 'description' }];
    const r = withViewWarnings(() => resolveView(fields, { id: 'categories', layout: 'cards', cards: { bucketBy: 'tab' }, theme: 'purple' }, { theme: 'purple' })).result;
    const rows = [{ tab: 'FURNITURE', itemNumber: 'T-1' }, { tab: 'FURNITURE', itemNumber: 'C-1' }, { tab: 'SIGNS', itemNumber: 'S-1' }];
    const cards = bucketRowsToCards(rows, r, {
        bucketKeys: ['ADDITIONS', 'FURNITURE'],
        bucketLabel: k => k.charAt(0) + k.slice(1).toLowerCase(),
        bucketDecorations: (k, members) => members.length > 1 ? [{ status: true, message: members.length + ' items' }] : []
    });
    assertEqual(cards.map(c => c.title), ['Additions', 'Furniture', 'Signs'], 'titles in seed order then data order');
    assertEqual(cards.map(c => c.rows.length), [0, 2, 1], 'members');
    assertEqual(cards[1].contentFooter, '2 items', 'bucket decorations');
    assertEqual([cards[1].row.tab, cards[1].hasDetails, cards[1].cardClass], ['FURNITURE', false, 'purple'], 'synthetic row, no details');
});

// ── Instant write (views-and-renderers-plan §4.16) ───────────────────────────
// writeCellsVerified locates rows by identity (Client + Year + Show) and columns by header name,
// reads, writes, re-reads, and retries once if rows moved. These tests run against FakeGoogle's
// Production Schedule and restore every cell they touch.

const IW_DB = 'PROD_SCHED';
const IW_TAB = 'Production Schedule';
const IW_ROW = { Client: 'Gearfire', Year: '2025', Show: 'SHOT Show' };

// One verified cell write (a batch of one); resolves to its result
async function writeOneVerified(database, tab, row, column, value) {
    const [result] = await Requests.writeCellsVerified(database, tab, [{ row, column, value }]);
    return result;
}

function iwSheet() {
    return FakeGoogleSheetsService.mockData[IW_DB][IW_TAB];
}
function iwCell(row, header) {
    const sheet = iwSheet();
    const c = sheet[0].findIndex(h => String(h).replace(/\s+/g, ' ').trim().toLowerCase() === header.toLowerCase());
    const r = sheet.findIndex((line, i) => i > 0 && line[0] === row.Show && line[1] === row.Client && String(line[2]) === row.Year);
    return { r, c, value: sheet[r]?.[c] };
}

test('INSTANT WRITE', 'checkbox reading: X/TRUE checked, any other value unchecked', async () => {
    assertEqual(['X', 'x', ' TRUE ', '-', 'N/a', '1/10', '', null].map(isCheckedValue), [true, true, true, false, false, false, false, false], 'isChecked');
});

test('INSTANT WRITE', 'a verified write changes one cell by identity and verifies it', async () => {
    const before = iwCell(IW_ROW, 'Elev');
    try {
        const res = await writeOneVerified(IW_DB, IW_TAB, IW_ROW, 'Elev', 'X');
        assertEqual(res.ok, true, 'ok');
        assertEqual(iwCell(IW_ROW, 'Elev').value, 'X', 'cell written');
        const res2 = await writeOneVerified(IW_DB, IW_TAB, IW_ROW, 'Elev', '');
        assertEqual([res2.ok, iwCell(IW_ROW, 'Elev').value], [true, ''], 'uncheck writes blank');
    } finally {
        iwSheet()[before.r][before.c] = before.value;
    }
});

test('INSTANT WRITE', 'refuses columns not listed in InstantWriteTables and tables without an entry', async () => {
    const r1 = await writeOneVerified(IW_DB, IW_TAB, IW_ROW, 'City', 'X');
    assertEqual(r1, { ok: false, reason: 'column-not-writable' }, 'column refused');
    const r2 = await writeOneVerified(IW_DB, 'Some Other Tab', IW_ROW, 'Elev', 'X');
    assertEqual(r2, { ok: false, reason: 'no-config' }, 'no config');
});

test('INSTANT WRITE', 'duplicate identity is never guessed', async () => {
    const sheet = iwSheet();
    const src = iwCell(IW_ROW, 'Elev');
    const copy = [...sheet[src.r]];
    sheet.push(copy);
    try {
        const res = await writeOneVerified(IW_DB, IW_TAB, IW_ROW, 'Elev', 'X');
        assertEqual(res, { ok: false, reason: 'duplicate' }, 'duplicate');
        assertEqual(sheet[src.r][src.c], src.value, 'original untouched');
    } finally {
        sheet.splice(sheet.indexOf(copy), 1);
    }
});

test('INSTANT WRITE', 'row moved mid-write: re-located by identity and written correctly', async () => {
    const sheet = iwSheet();
    const before = iwCell(IW_ROW, 'Panels');
    const original = FakeGoogleSheetsService.getSheetData;
    let inserted = null;
    // The first single-row range read happens after the row was located: insert a row above it then.
    FakeGoogleSheetsService.getSheetData = async function (tableId, range) {
        if (!inserted && tableId === IW_DB && /!A\d+:/.test(range)) {
            inserted = new Array(sheet[0].length).fill('');
            inserted[0] = 'Inserted Show'; inserted[1] = 'Inserted Client'; inserted[2] = '2025';
            sheet.splice(1, 0, inserted);
        }
        return original.call(this, tableId, range);
    };
    try {
        const res = await writeOneVerified(IW_DB, IW_TAB, IW_ROW, 'Panels', 'X');
        assertEqual(res.ok, true, 'ok after retry');
        const after = iwCell(IW_ROW, 'Panels');
        assertEqual([after.r, after.value], [before.r + 1, 'X'], 'written at the moved row');
        assertEqual(inserted[after.c], '', 'inserted row untouched');
    } finally {
        FakeGoogleSheetsService.getSheetData = original;
        if (inserted) sheet.splice(sheet.indexOf(inserted), 1);
        const cur = iwCell(IW_ROW, 'Panels');
        sheet[cur.r][cur.c] = before.value;
    }
});

test('INSTANT WRITE', 'saveShowNote creates the row the first time, then updates it', async () => {
    const sheet = FakeGoogleSheetsService.mockData.CACHE.ShowNotes;
    const startLen = sheet.length;
    const id = 'TESTCO 2099 NOTE TEST';
    try {
        const r1 = await Requests.saveShowNote(id, 'first note');
        assertEqual(r1.ok, true, 'create ok');
        assertEqual(sheet.length, startLen + 1, 'row appended');
        const r2 = await Requests.saveShowNote(id, 'second note');
        assertEqual(r2.ok, true, 'update ok');
        assertEqual(sheet.length, startLen + 1, 'no second row');
        const notes = await Requests.getShowNotes();
        assertEqual(notes.find(n => n.Identifier === id)?.Note, 'second note', 'read back');
    } finally {
        const i = sheet.findIndex(r => r[0] === id);
        if (i > 0) sheet.splice(i, 1);
    }
});

test('INSTANT WRITE', 'design queue preferences are readable as json', async () => {
    const fields = await Requests.getJsonPreference('DesignQueueFields', []);
    assertContains(fields, 'Assignee', 'DesignQueueFields');
    const cfg = await Requests.getInstantWriteConfig('PROD_SCHED', 'Production Schedule');
    assertEqual(cfg.identity, ['Client', 'Year', 'Show'], 'identity');
    assertEqual(cfg.columns, ['Elev', 'Panels', 'Setups', 'Assignee'], 'columns');
});

// ── Instant-write preference, column kinds, ship estimate ────────────────────

test('INSTANT WRITE', 'InstantWriteTables: columns as a list, the older typed object still read', async () => {
    const key = 'PROD_SCHED/Production Schedule';
    assertEqual(instantWriteEntry({ [key]: { identity: ['Client', 'Year', 'Show', 'Size'], columns: ['Elev', 'Assignee'] } }, 'PROD_SCHED', 'Production Schedule'),
        { identity: ['Client', 'Year', 'Show', 'Size'], columns: ['Elev', 'Assignee'] }, 'list form');
    assertEqual(instantWriteEntry({ [key]: { identity: ['Client'], columns: { Elev: 'checkbox', Assignee: 'select' } } }, 'PROD_SCHED', 'Production Schedule'),
        { identity: ['Client'], columns: ['Elev', 'Assignee'] }, 'object form');
    assertEqual([instantWriteEntry({ [key]: { identity: [], columns: ['Elev'] } }, 'PROD_SCHED', 'Production Schedule'), instantWriteEntry({}, 'PROD_SCHED', 'Production Schedule')], [null, null], 'incomplete');
});

test('INSTANT WRITE', 'keys: identities match trimmed and case-insensitively; cells by normalized column', async () => {
    const id = ['Client', 'Year', 'Show'];
    const key = (row) => identityKey(id, k => row[k]);
    assertEqual(key({ Client: ' QGenda ', Year: 2025, Show: 'HIMSS' }), key({ Client: 'qgenda', Year: '2025', Show: 'himss ' }), 'same identity');
    assertEqual(key({ Client: 'A|B', Year: '', Show: 'C' }) === key({ Client: 'A', Year: 'B', Show: 'C' }), false, 'a value with | is not split');
    assertEqual(cellKey('r', 'Account  Manager'), cellKey('r', 'account manager'), 'column names normalized');
    assertEqual(joinKey('a', null, 1).split(''), ['a', '', '1'], 'parts');
});

test('COLUMN TYPES', 'declared types win; undeclared columns are text unless the name reads as a date, number or currency', async () => {
    const all = { 'DB/Tab': { 'Ship BKD': 'checkbox', Owner: { type: 'select', options: 'People' }, Odd: 'colour', ' ': 'text' } };
    const list = columnTypesEntry(all, 'DB', 'Tab');
    assertEqual(list, [{ column: 'Ship BKD', type: 'checkbox' }, { column: 'Owner', type: 'select', options: 'People' }], 'unknown types and blank names skipped');
    assertEqual(columnTypesEntry(all, 'DB', 'Other'), [], 'other tab');
    const map = columnTypeMap(list);
    assertEqual([columnTypeOf(map, 'ship  bkd'), columnTypeOf(map, 'Owner'), columnTypeOf(map, 'Ship'), columnTypeOf(map, 'Notes')],
        [{ type: 'checkbox' }, { type: 'select', options: 'People' }, { type: 'date' }, { type: 'text' }], 'declared, then guessed');
    assertEqual(['S. Start', 'Qty', 'Total Cost', 'Booth#'].map(guessColumnType), ['date', 'number', 'currency', 'text'], 'name guesses');
});

test('COLUMN TYPES', 'getColumnTypes reads the ColumnTypes preference; schedule fields carry the types', async () => {
    const types = await Requests.getColumnTypes('PROD_SCHED', 'Production Schedule');
    const byName = Object.fromEntries(types.map(t => [t.column, t]));
    assertEqual([byName.Elev?.type, byName.Assignee], ['checkbox', { column: 'Assignee', type: 'select', options: 'DesignQueueAssignees' }], 'declared');
    const fields = Object.fromEntries(buildScheduleFields([{ Elev: '', 'Ship BKD': '', Ship: '', Client: '', Assignee: '' }], { packlist: false, types }).map(f => [f.key, f]));
    assertEqual([fields.Elev.type, fields['Ship BKD'].type, fields.Ship.type, fields.Client.type, fields.Assignee.optionList], ['checkbox', 'checkbox', 'date', undefined, 'DesignQueueAssignees'], 'field types');
});

test('INSTANT WRITE', 'design queue setup: instant config, shown fields, assignees and column types in one call', async () => {
    const [setup] = await Requests.getDesignQueueSetup('PROD_SCHED', 'Production Schedule');
    assertEqual(setup.instant, { identity: ['Client', 'Year', 'Show'], columns: ['Elev', 'Panels', 'Setups', 'Assignee'] }, 'instant config');
    assertContains(setup.fields, 'Note', 'DesignQueueFields');
    assertEqual(setup.assignees, ['Alex', 'Sam Smith'], 'assignees');
    assertEqual(setup.assigneeColors, { Alex: 'red', 'Sam Smith': 'blue' }, 'assignee colour words');
    assertEqual(setup.types, await Requests.getColumnTypes('PROD_SCHED', 'Production Schedule'), 'the declared column types');
});

test('INSTANT WRITE', 'Ship shows the estimate (with year, from show dates when missing); transship uses the source end', async () => {
    const row = { Ship: '', 'S. Start': '3/20', 'S. End': '3/23', Year: '2026' };
    assertEqual(withShipDate(row).Ship, '03/06/2026', 'S. Start minus 14 days');
    assertEqual(withShipDate({ ...row, Ship: '3/1' }).Ship, '03/01/2026', 'sheet value gains its year');
    assertEqual(withShipDate({ ...row, AppData: { transshipSource: 'X', transshipSourceEndDate: '03/02/2026' } }).Ship, '03/02/2026', 'transship');
    assertEqual(estimateShipDate({ Year: '2026' }), null, 'no dates');
});

// ── Filters: same-column OR, is empty, checked / unchecked ───────────────────

test('FILTERS', 'filters on one column match rows meeting either; excludes still apply', async () => {
    const rows = [{ N: 'Bob' }, { N: '' }, { N: 'Ann' }, { N: 'Bobby' }];
    const sp = textFiltersToSearchParams([
        { column: 'N', values: ['bob'], type: 'contains' },
        { column: 'N', values: [], type: 'empty' },
        { column: 'N', values: ['bobby'], type: 'excludes' }
    ]);
    assertEqual(searchFilter(rows, sp).map(r => r.N), ['Bob', ''], 'Bob or empty, not Bobby');
    assertEqual(searchFilter(rows, textFiltersToSearchParams([{ column: 'N', values: [], type: 'empty' }])).map(r => r.N), [''], 'is empty alone');
    assertEqual(searchFilter(rows, textFiltersToSearchParams([{ column: 'N', values: [''], type: 'contains' }])).length, 4, 'a contains filter without a value is ignored');
});

test('FILTERS', 'checkbox filters: checked is X or TRUE, unchecked is anything else', async () => {
    const rows = [{ E: 'X' }, { E: '' }, { E: '-' }, { E: 'TRUE' }, { E: 'N/a' }];
    assertEqual(searchFilter(rows, textFiltersToSearchParams([{ column: 'E', type: 'checked' }])).map(r => r.E), ['X', 'TRUE'], 'checked');
    assertEqual(searchFilter(rows, textFiltersToSearchParams([{ column: 'E', type: 'unchecked' }])).map(r => r.E), ['', '-', 'N/a'], 'unchecked');
});

test('FILTERS', 'URL filter parameters keep same-column filters and value-less types', async () => {
    const sp = parseSearchParameters({ Col1: 'Client', Val1: 'a|b', Type1: 'contains', Col2: 'Client', Val2: '', Type2: 'empty' }).searchParams;
    assertEqual(sp, { Client: [{ values: ['a', 'b'], type: 'contains' }, { values: [], type: 'empty' }] }, 'grouped');
    const all = await Requests.getProductionScheduleData(null, null);
    const want = all.filter(r => isCheckedValue(r.Setups) && (/o/i.test(r.Client) || !String(r.Client).trim()));
    const data = await Requests.getProductionScheduleData(null, textFiltersToSearchParams([
        { column: 'Setups', type: 'checked' },
        { column: 'Client', values: ['o'], type: 'contains' },
        { column: 'Client', values: [], type: 'empty' }
    ]));
    assertEqual([data.length > 0, data.length], [true, want.length], 'schedule data filtered');
});

// ── Show notes: empty notes are removed, never appended ──────────────────────

function notesSheet() {
    return FakeGoogleSheetsService.mockData.CACHE.ShowNotes;
}
function notesSnapshot() {
    return notesSheet().map(r => r.slice());
}
function notesRestore(snap) {
    const s = notesSheet();
    s.length = 0;
    snap.forEach(r => s.push(r.slice()));
}

test('SHOW NOTES', "a schedule row's note comes from its show identifier and follows note saves", async () => {
    const snap = notesSnapshot();
    const id = 'CHAINCO 2026 SPRING EXPO';
    const row = { Show: 'Spring Expo', Client: 'ChainCo', Year: '2026' };
    try {
        await Requests.saveShowNote(id, 'first');
        assertEqual(await Requests.getShowNoteForRow(row), { identifier: id, note: 'first' }, 'note by identifier');
        await Requests.saveShowNote(id, 'second');
        assertEqual((await Requests.getShowNoteForRow(row)).note, 'second', 'a save refreshes the cached note');
        assertEqual(await Requests.getShowNoteForRow({ Show: null, Client: null, Year: null }), { identifier: '', note: '' }, 'no identifier');
    } finally {
        await Requests.saveShowNote(id, '');
        notesRestore(snap);
    }
});

test('SHOW NOTES', 'clearing a note removes its row; an empty note is never appended', async () => {
    const snap = notesSnapshot();
    try {
        const id = 'TESTCO 2099 CLEAR TEST';
        await Requests.saveShowNote(id, 'to be cleared');
        assertEqual(notesSheet().some(r => r[0] === id), true, 'created');
        const res = await Requests.saveShowNote(id, '   ');
        assertEqual([res.ok, notesSheet().some(r => r[0] === id)], [true, false], 'row removed');
        const len = notesSheet().length;
        const res2 = await Requests.saveShowNote('TESTCO 2099 NEVER', '');
        assertEqual([res2.ok, notesSheet().length], [true, len], 'nothing appended');
        assertEqual(notesSheet()[0], ['Identifier', 'Note', 'EditHistory'], 'header kept');
    } finally {
        notesRestore(snap);
    }
});

test('SHOW NOTES', 'any save removes rows with empty notes and keeps every other note', async () => {
    const snap = notesSnapshot();
    const s = notesSheet();
    try {
        s.push(['TESTCO 2099 EMPTY A', '', 'old history'], ['', '', ''], ['TESTCO 2099 KEEP', 'keep me', ''], ['TESTCO 2099 EMPTY B', ' ', '']);
        const res = await Requests.saveShowNote('TESTCO 2099 NEW', 'a new note');
        assertEqual(res.ok, true, 'ok');
        const ids = s.slice(1).map(r => r[0]);
        assertEqual(ids.filter(id => /EMPTY/.test(id)).length + ids.filter(id => !id).length, 0, 'empty rows removed');
        assertContains(ids, 'TESTCO 2099 KEEP', 'other note kept');
        assertEqual(s.find(r => r[0] === 'TESTCO 2099 NEW')?.[1], 'a new note', 'new note written');
        snap.slice(1).forEach(r => assertContains(ids, r[0], 'fixture note kept'));
    } finally {
        notesRestore(snap);
    }
});

test('SHOW NOTES', 'rows moving before a removal never lose a note', async () => {
    const snap = notesSnapshot();
    const s = notesSheet();
    try {
        s.push(['TESTCO 2099 EMPTY', '', ''], ['TESTCO 2099 A', 'note a', ''], ['TESTCO 2099 B', 'note b', '']);
        let fired = false;
        const res = await withFaults({
            // Another save inserts a note at the top just before the removal: positions shift by one
            beforeDelete: () => { if (!fired) { fired = true; s.splice(1, 0, ['TESTCO 2099 OTHER', 'other note', '']); } }
        }, () => Requests.saveShowNote('TESTCO 2099 A', 'note a, edited'));
        assertEqual(res.ok, true, 'ok');
        const notes = Object.fromEntries(s.slice(1).map(r => [r[0], r[1]]));
        assertEqual([notes['TESTCO 2099 A'], notes['TESTCO 2099 B'], notes['TESTCO 2099 OTHER']], ['note a, edited', 'note b', 'other note'], 'every note present');
        snap.slice(1).forEach(r => assertEqual(notes[r[0]], r[1], 'fixture note ' + r[0]));
    } finally {
        notesRestore(snap);
    }
});

test('SHOW NOTES', 'a note write that lands on a moved row is undone and retried', async () => {
    const snap = notesSnapshot();
    const s = notesSheet();
    try {
        s.push(['TESTCO 2099 FIRST', 'first note', ''], ['TESTCO 2099 TARGET', 'target note', '']);
        let fired = false;
        const res = await withFaults({
            beforeBatchWrite: (t) => { if (t === 'CACHE' && !fired) { fired = true; s.splice(1, 0, ['TESTCO 2099 INSERTED', 'inserted note', '']); } }
        }, () => Requests.saveShowNote('TESTCO 2099 TARGET', 'target, edited'));
        assertEqual(res.ok, true, 'ok');
        const notes = Object.fromEntries(s.slice(1).map(r => [r[0], r[1]]));
        assertEqual([notes['TESTCO 2099 TARGET'], notes['TESTCO 2099 FIRST'], notes['TESTCO 2099 INSERTED']], ['target, edited', 'first note', 'inserted note'], 'only the target changed');
    } finally {
        notesRestore(snap);
    }
});

// ── Cell edits (utils/cellEdits.js): batch and instant edits ─────────────────

const editWait = (ms) => new Promise(r => setTimeout(r, ms));

function batchHarness(rowKey = null) {
    const rows = [{ k: '1', A: 'x', metadata: 'm' }, { k: '2', A: 'y' }];
    const originals = rows.map(r => ({ ...r }));
    const emitted = [];
    const edits = useBatchEdits({
        rows: () => rows,
        originalRows: () => originals,
        rowKey: () => rowKey,
        undoRoute: () => null,
        // The page writes its rows on cell-edit
        emitEdit: (i, key, value) => { emitted.push([i, key, value]); rows[i][key] = value; }
    });
    return { rows, emitted, edits };
}

// A long ButtonBar splits where the wider of its two lines is narrowest; ties go to the middle
test('CELL EDITS', 'button bars: balancedSplit balances the two lines by width', async () => {
    assertEqual(balancedSplit([50, 50, 50, 50]), 2, 'equal widths: half each');
    assertEqual(balancedSplit([200, 40, 40, 40, 40]), 1, 'one wide control: alone on the first line');
    assertEqual(balancedSplit([40, 40, 40, 40, 200]), 4, 'a wide last control: alone on the second line');
    assertEqual(balancedSplit([60, 30, 30, 60, 30]), 3, 'mixed widths, a tie: 120 over 90 (the longer line first)');
    assertEqual(balancedSplit([30, 30, 30, 30, 30]), 3, 'odd count, equal widths: the longer line first');
});

test('CELL EDITS', 'batch: an edit marks the cell unsaved until it is back to the loaded value', async () => {
    const { edits, emitted } = batchHarness();
    edits.edit(0, 'A', 'z');
    assertEqual([edits.cellState(0, 'A'), edits.hasUnsaved.value, emitted.length], ['unsaved', true, 1], 'changed');
    edits.edit(0, 'A', 'x');
    assertEqual([edits.cellState(0, 'A'), edits.hasUnsaved.value], ['', false], 'back to loaded');
});

test('CELL EDITS', 'batch: revert, nested tables, and recompare (with metadata)', async () => {
    const { rows, edits, emitted } = batchHarness();
    edits.edit(1, 'A', 'q');
    edits.revert(1, 'A');
    assertEqual([rows[1].A, edits.cellState(1, 'A'), emitted[emitted.length - 1]], ['y', '', [1, 'A', 'y']], 'reverted');
    edits.setNested(0, 'Items', true);
    assertEqual([edits.cellState(0, 'Items'), edits.hasUnsaved.value], ['unsaved', true], 'nested changed');
    edits.setNested(0, 'Items', false);
    assertEqual(edits.hasUnsaved.value, false, 'nested back');
    rows[0].metadata = 'changed';
    edits.compareAll(['A']);
    assertEqual([edits.cellState(0, 'A'), edits.hasUnsaved.value], ['', true], 'metadata counts as a change');
});

test('CELL EDITS', 'batch: loaded values follow the row key when rows move', async () => {
    const { rows, edits } = batchHarness('k');
    rows.reverse();
    assertEqual([edits.originalValue(rows[0], 0, 'A'), edits.originalValue(rows[1], 1, 'A')], ['y', 'x'], 'by key');
});

test('CELL EDITS', 'batch with a row key: moved rows mark the table, not cells; edits compare by key', async () => {
    const { rows, edits } = batchHarness('k');
    rows.reverse();
    edits.compareAll(['A']);
    assertEqual([edits.cellState(0, 'A'), edits.cellState(1, 'A'), edits.hasUnsaved.value], ['', '', true], 'moved: unsaved, no cells');
    edits.edit(0, 'A', 'q');
    assertEqual(edits.cellState(0, 'A'), 'unsaved', 'edit after a move');
    edits.edit(0, 'A', 'y');
    assertEqual(edits.cellState(0, 'A'), '', 'back to its own loaded value');
    rows.reverse();
    edits.compareAll(['A']);
    assertEqual(edits.hasUnsaved.value, false, 'order restored');
    rows.pop();
    edits.compareAll(['A']);
    assertEqual(edits.hasUnsaved.value, true, 'a removed row counts as a change');
});

function instantHarness(commit) {
    const rows = [{ id: 'a', Elev: '', Note: '' }, { id: 'b', Elev: 'X', Note: 'n' }];
    const calls = { commits: [], errors: [], refreshes: 0 };
    const edits = useInstantEdits({
        enabled: () => true,
        rows: () => rows,
        rowId: (r) => r.id,
        commitCells: async (entries) => {
            calls.commits.push(entries.map(e => `${e.row.id}.${e.key}=${e.value}`));
            return commit(entries);
        },
        derive: (r) => ({ ...r, done: r.Elev === 'X' }),
        field: (key) => (key === 'Elev' ? { key, label: 'Elev', type: 'checkbox' } : { key, label: key }),
        delay: () => 20,
        modal: () => ({ error: (m) => calls.errors.push(m), alert: () => {} }),
        refresh: () => { calls.refreshes++; }
    });
    return { rows, calls, edits };
}
const allOk = async (entries) => entries.map(() => ({ ok: true }));

test('CELL EDITS', 'instant: edits show at once and nearby edits are written as one batch', async () => {
    const { rows, calls, edits } = instantHarness(allOk);
    edits.edit(rows[0], 'Elev', 'X');
    edits.edit(rows[1], 'Note', 'new');
    assertEqual([edits.cellState(rows[0], 'Elev'), edits.overlay(rows)[0]], ['unsaved', { id: 'a', Elev: 'X', Note: '', done: true }], 'shown and derived');
    await editWait(80);
    assertEqual(calls.commits, [['a.Elev=X', 'b.Note=new']], 'one batch');
    assertEqual(edits.cellState(rows[0], 'Elev'), '', 'saved');
    rows[0].Elev = 'X';
    rows[1].Note = 'new';
    edits.reconcile();
    assertEqual(Object.keys(edits.pending).length, 0, 'overlay dropped once the rows carry the values');
});

test('CELL EDITS', 'instant: a cell back to its loaded value within the delay is not written', async () => {
    const { rows, calls, edits } = instantHarness(allOk);
    edits.edit(rows[0], 'Elev', 'X');
    edits.edit(rows[0], 'Elev', '');
    edits.edit(rows[1], 'Elev', 'TRUE'); // checked, like the loaded X
    await editWait(80);
    assertEqual([calls.commits, Object.keys(edits.pending).length], [[], 0], 'nothing written');
});

test('CELL EDITS', 'instant: a failed write reverts, reports once and asks for a refresh', async () => {
    const { rows, calls, edits } = instantHarness(async (entries) => entries.map(() => ({ ok: false, reason: 'not-found' })));
    edits.edit(rows[0], 'Elev', 'X');
    await editWait(80);
    assertEqual([edits.cellState(rows[0], 'Elev'), edits.overlay(rows), calls.refreshes], ['failed', rows, 1], 'reverted');
    assertEqual(calls.errors.length === 1 && calls.errors[0].includes('Elev: the row was not found in the sheet'), true, 'message');
});

test('CELL EDITS', 'instant: an edit made while its cell is being written is written next', async () => {
    const { rows, calls, edits } = instantHarness(async (entries) => { await editWait(60); return entries.map(() => ({ ok: true })); });
    edits.edit(rows[0], 'Note', 'one');
    await editWait(40); // the write is in flight
    edits.edit(rows[0], 'Note', 'two');
    await editWait(250);
    assertEqual(calls.commits, [['a.Note=one'], ['a.Note=two']], 'two writes in order');
});

// ── Reactive stores: eviction ────────────────────────────────────────────────

test('REACTIVE STORES', 'an evicted store that is read loads again; an unread one stays evicted', async () => {
    const calls = { shown: 0, unread: 0 };
    const tag = Date.now();
    const shown = getReactiveStore(async () => { calls.shown++; return [{ a: 1 }]; }, null, [`evict-shown-${tag}`], null, false);
    const unread = getReactiveStore(async () => { calls.unread++; return [{ a: 1 }]; }, null, [`evict-unread-${tag}`], null, false);
    await shown.load();
    await unread.load();
    const el = document.createElement('div');
    const app = Vue.createApp({ render: () => Vue.h('span', String(shown.data.length)) });
    app.mount(el);
    try {
        shown.evict();
        unread.evict();
        await editWait(300);
        assertEqual([calls.shown, shown.data.length, el.textContent], [2, 1, '1'], 'rendered store reloaded');
        assertEqual([calls.unread, unread.needsReload], [1, true], 'unread store stays evicted');
    } finally {
        app.unmount();
    }
});

test('REACTIVE STORES', 'a keepWhileRefreshing analysis keeps its last result through reloads and re-runs', async () => {
    let rows = [{ k: 'a' }, { k: 'b' }];
    let gate = null; // while set, the analysis waits for it
    const analyze = async (k) => { const n = rows.length; if (gate) await gate; return `${k}${n}`; };
    const config = { ...createAnalysisConfig(analyze, 'res', 'test', ['k']), keepWhileRefreshing: true };
    const store = getReactiveStore(async () => rows.map(r => ({ ...r })), null, [`keep-${Date.now()}`], [config], false);
    await store.load();
    assertEqual(store.data.map(r => r.AppData.res), ['a2', 'b2'], 'analysed');
    let release;
    gate = new Promise(r => { release = r; });
    rows = [{ k: 'b' }, { k: 'c' }, { k: 'a' }];
    const reload = store.load();
    await editWait(50);
    assertEqual(store.data.map(r => r.AppData.res), ['b2', null, 'a2'], 'kept by input value while the re-run waits');
    gate = null;
    release();
    await reload;
    assertEqual(store.data.map(r => r.AppData.res), ['b3', 'c3', 'a3'], 'replaced by the re-run');
    store.clearSpecificAnalysisResults(['res']);
    assertEqual(store.data[0].AppData.res, 'b3', 'an invalidation does not clear it first');
});

// ── Batched verified writes, fault injection, sheet health ───────────────────
// writeCellsVerified writes any cells of one tab as one batch with the same safety steps as a
// single cell. FakeGoogleSheetsService.faults injects what a concurrent editor could do to the
// live sheet mid-save (insert, sort, drop, duplicate, rename); the randomized test checks that no
// cell outside the batch ever changes in rows the save could know about, and that a change it
// can't undo (a row or column added mid-save) is always reported.

const IW_WRITABLE = ['Elev', 'Panels', 'Setups', 'Assignee'];

function iwHeaderIndex(name, header = iwSheet()[0]) {
    return header.findIndex(h => String(h).replace(/\s+/g, ' ').trim().toLowerCase() === name.toLowerCase());
}
function iwIdentityKey(line) {
    return [line[0], line[1], line[2]].map(v => String(v ?? '').trim().toLowerCase()).join('|');
}
// Data rows (array references) whose Show + Client + Year is complete and unique
function iwUniqueRows() {
    const s = iwSheet();
    const counts = new Map();
    const complete = s.slice(1).filter(l => l && l[0] && l[1] && l[2]);
    complete.forEach(l => counts.set(iwIdentityKey(l), (counts.get(iwIdentityKey(l)) || 0) + 1));
    return complete.filter(l => counts.get(iwIdentityKey(l)) === 1);
}
function iwRowObj(line) {
    return { Show: line[0], Client: line[1], Year: String(line[2]) };
}
// Snapshot by row reference (faults move rows; writes change them in place) and restore in place
function iwSnapshot() {
    const s = iwSheet();
    return { rows: s.slice(), copies: s.map(r => r.slice()) };
}
function iwRestore(snap) {
    const s = iwSheet();
    s.length = 0;
    snap.rows.forEach((r, i) => { r.length = 0; r.push(...snap.copies[i]); s.push(r); });
}
// Fault hooks play another editor on the data sheets: change stamps on the Caching tab (written in
// the background after each data write) pass them by
const _isStampCall = (tableId, target) => tableId === 'CACHE' &&
    [].concat(target).every(t => String(t?.range ?? t).startsWith('Caching'));
async function withFaults(faults, fn) {
    FakeGoogleSheetsService.faults = Object.fromEntries(Object.entries(faults).map(([name, hook]) =>
        [name, (tableId, target, ...rest) => _isStampCall(tableId, target) ? undefined : hook(tableId, target, ...rest)]));
    try { return await fn(); } finally { FakeGoogleSheetsService.faults = null; }
}
function iwNewRow(label) {
    const row = new Array(iwSheet()[0].length).fill('');
    row[0] = `${label} Show`; row[1] = `${label} Client`; row[2] = '2025';
    return row;
}
// Deterministic RNG (mulberry32) so a failing run can be replayed from its seed
function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

test('INSTANT WRITE', 'writeCellsVerified writes cells on several rows with one write request', async () => {
    const snap = iwSnapshot();
    const [a, b] = iwUniqueRows();
    let batches = 0, fullReads = 0;
    try {
        const res = await withFaults({
            beforeBatchWrite: () => { batches++; },
            beforeRead: (t, range) => { if (t === IW_DB && !range.includes('!')) fullReads++; }
        }, () => Requests.writeCellsVerified(IW_DB, IW_TAB, [
            { row: iwRowObj(a), column: 'Elev', value: 'X' },
            { row: iwRowObj(a), column: 'Panels', value: '-' },
            { row: iwRowObj(b), column: 'Setups', value: 'X' }
        ]));
        assertEqual(res.map(r => r.ok), [true, true, true], 'all ok');
        assertEqual([a[iwHeaderIndex('Elev')], a[iwHeaderIndex('Panels')], b[iwHeaderIndex('Setups')]], ['X', '-', 'X'], 'written');
        assertEqual([batches, fullReads], [1, 1], 'one write request, one full read');
    } finally {
        iwRestore(snap);
    }
});

test('INSTANT WRITE', 'batch results are per cell: refused and unmatched cells do not stop the others', async () => {
    const snap = iwSnapshot();
    const [a, b] = iwUniqueRows();
    try {
        const res = await Requests.writeCellsVerified(IW_DB, IW_TAB, [
            { row: iwRowObj(a), column: 'Elev', value: 'X' },
            { row: iwRowObj(a), column: 'City', value: 'X' },
            { row: { Show: 'Nope', Client: 'Nobody', Year: '2099' }, column: 'Elev', value: 'X' },
            { row: iwRowObj(b), column: 'Elev', value: 'X' }
        ]);
        assertEqual(res.map(r => r.ok ? 'ok' : r.reason), ['ok', 'column-not-writable', 'not-found', 'ok'], 'results');
        assertEqual([a[iwHeaderIndex('Elev')], b[iwHeaderIndex('Elev')]], ['X', 'X'], 'written');
    } finally {
        iwRestore(snap);
    }
});

test('INSTANT WRITE', 'rows shifted just before the write: the displaced value is restored and the target retried', async () => {
    const snap = iwSnapshot();
    const s = iwSheet();
    const target = iwUniqueRows()[2];
    const col = iwHeaderIndex('Panels');
    const neighbour = s[s.indexOf(target) - 1];
    const neighbourValue = neighbour[col];
    const inserted = iwNewRow('Inserted');
    let fired = false;
    try {
        const res = await withFaults({
            beforeBatchWrite: () => { if (!fired) { fired = true; s.splice(1, 0, inserted); } }
        }, () => Requests.writeCellsVerified(IW_DB, IW_TAB, [{ row: iwRowObj(target), column: 'Panels', value: neighbourValue === 'X' ? '-' : 'X' }]));
        const want = neighbourValue === 'X' ? '-' : 'X';
        assertEqual([res[0].ok, res[0].warning], [true, undefined], 'ok without warning');
        assertEqual(target[col], want, 'target written');
        assertEqual(neighbour[col], neighbourValue, 'neighbour restored');
        assertEqual(inserted[col], '', 'inserted row untouched');
    } finally {
        iwRestore(snap);
    }
});

test('INSTANT WRITE', 'a row added at the target mid-write is reported, and the target still written', async () => {
    const snap = iwSnapshot();
    const s = iwSheet();
    const target = iwUniqueRows()[2];
    const col = iwHeaderIndex('Elev');
    const inserted = iwNewRow('Added');
    let fired = false;
    try {
        const res = await withFaults({
            beforeBatchWrite: () => { if (!fired) { fired = true; s.splice(s.indexOf(target), 0, inserted); } }
        }, () => Requests.writeCellsVerified(IW_DB, IW_TAB, [{ row: iwRowObj(target), column: 'Elev', value: 'X' }]));
        assertEqual(res[0].ok, true, 'ok');
        assertEqual(target[col], 'X', 'target written');
        assertEqual(/Added Show/.test(res[0].warning || '') && /added while saving/.test(res[0].warning), true, 'warning names the added row');
    } finally {
        iwRestore(snap);
    }
});

test('INSTANT WRITE', 'a dropped write fails verification and is retried', async () => {
    const snap = iwSnapshot();
    const target = iwUniqueRows()[1];
    const want = target[iwHeaderIndex('Setups')] === 'X' ? '-' : 'X';
    let drops = 0;
    try {
        const res = await withFaults({
            beforeBatchWrite: () => (drops++ === 0 ? 'drop' : undefined)
        }, () => Requests.writeCellsVerified(IW_DB, IW_TAB, [{ row: iwRowObj(target), column: 'Setups', value: want }]));
        assertEqual([res[0].ok, drops, target[iwHeaderIndex('Setups')]], [true, 2, want], 'retried and written');
    } finally {
        iwRestore(snap);
    }
});

test('INSTANT WRITE', 'randomized faults never change cells outside the batch (seeded)', async () => {
    const SEED = 20261031;
    const RUNS = 60;
    const rng = seededRandom(SEED);
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const once = (fn) => { let done = false; return (...args) => { if (done) return undefined; const r = fn(...args); if (r !== false) done = true; return r === false ? undefined : r; }; };

    // Each fault plays one concurrent editor action at a moment the save can't control
    const FAULTS = {
        none: () => ({}),
        insertAbove: (ctx) => ({ beforeBatchWrite: once(() => { const s = iwSheet(); const row = iwNewRow('Rand'); ctx.added.push([row, row.slice()]); s.splice(1 + Math.floor(rng() * (s.length - 1)), 0, row); }) }),
        insertAtTarget: (ctx) => ({ beforeBatchWrite: once(() => { const s = iwSheet(); const row = iwNewRow('Rand'); ctx.added.push([row, row.slice()]); s.splice(s.indexOf(pick(ctx.targets)), 0, row); }) }),
        shuffle: () => ({ beforeBatchWrite: once(() => { const s = iwSheet(); const body = s.slice(1); for (let i = body.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [body[i], body[j]] = [body[j], body[i]]; } s.splice(1, body.length, ...body); }) }),
        dropAll: () => ({ beforeBatchWrite: once(() => 'drop') }),
        dropSome: () => ({ beforeBatchWrite: once(() => new Set([0])) }),
        moveAfterWrite: (ctx) => { let written = false; return { beforeBatchWrite: () => { written = true; }, beforeRead: once((t, range) => { if (!written || !range.includes('!')) return false; const row = iwNewRow('Late'); ctx.added.push([row, row.slice()]); iwSheet().splice(1, 0, row); }) }; },
        duplicate: (ctx) => ({ beforeRead: once((t, range) => { if (range.includes('!')) return false; const copy = pick(ctx.targets).slice(); ctx.added.push([copy, copy.slice()]); iwSheet().push(copy); }) }),
        renameHeader: () => ({ beforeRead: once((t, range) => { if (range.includes('!')) return false; iwSheet()[0][1] = 'Customer'; }) }),
        insertColumn: (ctx) => ({ beforeBatchWrite: once(() => { const s = iwSheet(); const c = iwHeaderIndex(pick(ctx.columns)); ctx.insertedCol = c; s.forEach((r, i) => r.splice(c, 0, i === 0 ? 'Inserted' : '')); }) })
    };
    const faultNames = Object.keys(FAULTS);
    const failures = [];

    for (let run = 0; run < RUNS; run++) {
        const snap = iwSnapshot();
        const header = snap.copies[0];
        const faultName = faultNames[run % faultNames.length];
        const unique = iwUniqueRows();
        // 1–4 distinct cells
        const cells = new Map();
        const n = 1 + Math.floor(rng() * 4);
        while (cells.size < n) {
            const ref = pick(unique);
            const column = pick(IW_WRITABLE);
            const value = column === 'Assignee' ? pick(['Ann', 'Bo', '']) : pick(['X', '', '-']);
            cells.set(snap.rows.indexOf(ref) + ':' + column, { ref, column, value });
        }
        const items = [...cells.values()];
        const ctx = { targets: items.map(i => i.ref), columns: items.map(i => i.column), added: [], insertedCol: -1 };
        let results;
        try {
            results = await withFaults(FAULTS[faultName](ctx), () =>
                Requests.writeCellsVerified(IW_DB, IW_TAB, items.map(i => ({ row: iwRowObj(i.ref), column: i.column, value: i.value }))));
        } catch (e) {
            failures.push(`run ${run} (${faultName}): threw ${e?.message || e}`);
            iwRestore(snap);
            continue;
        }

        const warned = results.some(r => r.warning);
        const mapCol = (c) => (ctx.insertedCol >= 0 && c >= ctx.insertedCol ? c + 1 : c);
        const problems = [];
        // Rows known before the save: only cells of successful items may change, to their value
        for (let i = 1; i < snap.rows.length; i++) {
            const ref = snap.rows[i];
            const copy = snap.copies[i];
            for (let c = 0; c < copy.length; c++) {
                let expected = copy[c] ?? '';
                items.forEach((it, k) => { if (it.ref === ref && results[k].ok && iwHeaderIndex(it.column, header) === c) expected = it.value; });
                const actual = ref[mapCol(c)] ?? '';
                if (String(actual) !== String(expected)) problems.push(`${copy[1]} / ${copy[0]} ${normalize(header[c])}: "${copy[c] ?? ''}" became "${actual}" (expected "${expected}")`);
            }
        }
        // Rows and columns added mid-save may change only when the save reported it
        if (!warned) {
            ctx.added.forEach(([row, original]) => {
                const now = ctx.insertedCol >= 0 ? row.filter((_, c) => c !== ctx.insertedCol) : row;
                if (JSON.stringify(now.map(v => v ?? '')) !== JSON.stringify(original.map(v => v ?? ''))) problems.push(`added row ${original[0]} changed without a warning`);
            });
            if (ctx.insertedCol >= 0 && iwSheet().slice(1).some(r => String(r[ctx.insertedCol] ?? '') !== '')) problems.push('inserted column changed without a warning');
        }
        if (faultName === 'none' && results.some(r => !r.ok)) problems.push('a clean save failed: ' + results.map(r => r.reason).join(','));
        if (problems.length) failures.push(`run ${run} (${faultName}, seed ${SEED}): ${problems.join('; ')}`);
        iwRestore(snap);
    }
    assertEqual(failures, [], `${RUNS} randomized saves`);

    function normalize(h) { return String(h ?? '').replace(/\s+/g, ' ').trim(); }
});

test('INSTANT WRITE', 'sheet health (test only) reports duplicate identities, duplicate headers and missing columns', async () => {
    const snap = iwSnapshot();
    const s = iwSheet();
    try {
        s.push(iwUniqueRows()[0].slice());
        s[0][iwHeaderIndex('Setups')] = 'Elev';
        const health = await checkSheetHealth(IW_DB, IW_TAB);
        const kinds = health.issues.map(i => i.kind);
        assertEqual(health.ok, false, 'not ok');
        ['duplicate-identity', 'duplicate-header', 'missing-writable-column'].forEach(k => assertContains(kinds, k, k));
        const dup = health.issues.find(i => i.kind === 'duplicate-identity');
        assertEqual(dup.rows.length, 2, 'both rows listed');
        const noIdentity = await checkSheetHealth(IW_DB, IW_TAB, { identity: [], columns: [] });
        assertEqual(noIdentity.issues.map(i => i.kind), ['duplicate-header'], 'a spec without identity skips identity rules');
    } finally {
        iwRestore(snap);
    }
});

// ── Shortage alerts, persisted results, date rollover ────────────────────────
// Today is pinned to 2025-01-01 (setTestToday) and the InventoryShortageAlertDays fixture is 120,
// so the alerts cover shows dated 2025-01-01 through 2025-05-01. CAB-004 (10 in stock) ships 11 to
// GEARFIRE 2025 SHOT and 11 to ATSC 2025 NAB, both 1/10/2025 to 1/31: one alert, in CABINETS,
// minimum -12 from 2025-01-10 to 2025-01-31. getInventoryShortageAlerts is persisted to
// CACHE/Analytics; the restore tests edit its saved row, then clear memory as a new session would.

const ALERTS_KEY = 'api:getInventoryShortageAlerts:';
const ALERTS_TODAY = '2025-01-01';
const CAB_004_ALERT = { itemId: 'CAB-004', tabName: 'CABINETS', startDate: '2025-01-10', endDate: '2025-01-31', minQty: -12, shows: ['GEARFIRE 2025 SHOT', 'ATSC 2025 NAB'] };
const RESTORED_MARKER = [{ ...CAB_004_ALERT, minQty: -99 }];
let _alertSources = []; // the saved row's real source keys, read by the first PERSISTED RESULTS test

// Pin today and roll the cached date over to it
function pinToday(isoDate) {
    setTestToday(isoDate);
    checkDateRollover();
}

// The saved alerts row once it holds `expected` (saving follows a computation without being awaited)
async function savedAlertsRow(expected) {
    for (let i = 0; i < 100; i++) {
        const row = (FakeGoogleSheetsService.mockData.CACHE.Analytics || []).find(r => r[0] === ALERTS_KEY);
        if (row && row[3] === JSON.stringify(expected)) return row;
        await new Promise(r => setTimeout(r, 20));
    }
    throw new Error(`the saved alerts row never held ${JSON.stringify(expected)}`);
}

function setSavedAlertsRow(savedAt, sources, value) {
    const rows = FakeGoogleSheetsService.mockData.CACHE.Analytics;
    const line = [ALERTS_KEY, savedAt, JSON.stringify(sources), JSON.stringify(value)];
    const index = rows.findIndex(r => r[0] === ALERTS_KEY);
    if (index === -1) rows.push(line); else rows[index] = line;
}

// A new session's first read: empty memory, so a valid saved row is restored
async function restoreAlerts() {
    clearCache();
    return await Requests.getInventoryShortageAlerts();
}

async function setPreference(id, value) {
    const prefs = (await Requests.getPreferences()).map(p => ({ ...p, value: p.id === id ? value : p.value }));
    await _asUser(() => Requests.savePreferences(prefs));
}

const setAlertDays = (value) => setPreference('InventoryShortageAlertDays', value);

test('SHORTAGE ALERTS', 'resolveShortageAlertDays reads the preference; missing, 0 or invalid turns alerts off', async () => {
    const pref = (value) => [{ id: 'InventoryShortageAlertDays', value }];
    assertEqual(resolveShortageAlertDays(pref('120')), 120, 'integer value');
    assertEqual([null, [], pref('0'), pref('abc'), pref('-5')].map(resolveShortageAlertDays), [0, 0, 0, 0, 0], 'off');
    assertEqual(shortageAlertDateFilters(30), [{ column: 'Date', value: 0, type: 'after' }, { column: 'Date', value: 30, type: 'before' }], 'window filters');
});

test('SHORTAGE ALERTS', 'alerts list the periods where an item runs out in the window', async () => {
    pinToday(ALERTS_TODAY);
    assertEqual(await Requests.getInventoryShortageAlerts(), [CAB_004_ALERT], 'CAB-004 runs short');
});

// A "Short N" card opens the item's timeline over its shortage (CAB-004: 1/10 to 1/31/2025), as
// pack list shortage alerts do
test('SHORTAGE ALERTS', 'a Short card opens the item timeline over its shortage', async () => {
    const opened = [];
    const [card] = itemShortageCards([CAB_004_ALERT], 120, path => opened.push(NavigationRegistry.parsePath(path)));
    card.action();
    assertEqual(opened.map(({ path, parameters }) => [path, parameters]), [['inventory/cabinets/CAB-004', {
        dateFilters: [{ column: 'Date', value: '2025-01-10', type: 'after' }, { column: 'Date', value: '2025-01-31', type: 'before' }]
    }]], 'timeline over the shortage');
    assertEqual(itemShortageCards([CAB_004_ALERT], 120)[0].action, null, 'no navigator, no action');
});

test('SHORTAGE ALERTS', 'a preference of 0 turns the alerts off, and saving it refreshes them', async () => {
    await setAlertDays('0');
    try {
        assertEqual(await Requests.getInventoryShortageAlerts(), [], 'off');
    } finally {
        await setAlertDays('120');
    }
    assertEqual(await Requests.getInventoryShortageAlerts(), [CAB_004_ALERT], 'back on');
});

test('PERSISTED RESULTS', 'a computed result is saved with its value and source keys', async () => {
    const row = await savedAlertsRow([CAB_004_ALERT]);
    const sources = _alertSources = JSON.parse(row[2]);
    assertContains(sources, 'app_utils:getToday:', 'the clock is a source');
    for (const prefix of ['database:getData:"CACHE","Preferences"', 'database:getData:"INVENTORY","CABINETS"', 'database:getData:"PACK_LISTS","ATSC 2025 NAB"', 'database:getData:"PROD_SCHED","Production Schedule"']) {
        if (!sources.some(source => source.startsWith(prefix))) throw new Error(`no source under ${prefix}`);
    }
    if (isNaN(new Date(row[1]).getTime())) throw new Error(`SavedAt is not a date: ${row[1]}`);
});

test('PERSISTED RESULTS', 'only data reads and app_utils sources are saved, not pure cached leaves', async () => {
    // findBestProjectIdentifierMatch keys embed every show name; saving them overflowed the cell
    const sources = JSON.parse((await savedAlertsRow([CAB_004_ALERT]))[2]);
    const other = sources.filter(source => !source.startsWith('database:') && !source.startsWith('app_utils:'));
    assertEqual(other, [], 'no other sources');
});

test('PERSISTED RESULTS', 'a new session restores a row no source has changed since', async () => {
    setSavedAlertsRow(new Date(Date.now() + 60000).toISOString(), _alertSources, RESTORED_MARKER);
    assertEqual(await restoreAlerts(), RESTORED_MARKER, 'restored');
});

test('PERSISTED RESULTS', 'a source stamped after the row is saved means a recompute', async () => {
    // The preference saves above stamped CACHE/Preferences on the Caching tab
    const stamps = await ApplicationUtils.readCacheTimestamps();
    if (!stamps.some(s => s.key === 'database:getData:"CACHE","Preferences"')) throw new Error('precondition: no Preferences stamp');
    setSavedAlertsRow(new Date(Date.now() - 3600000).toISOString(), _alertSources, RESTORED_MARKER);
    assertEqual(await restoreAlerts(), [CAB_004_ALERT], 'recomputed');
    await savedAlertsRow([CAB_004_ALERT]); // the recompute is saved again
});

test('PERSISTED RESULTS', 'a row saved before today is stale; one saved today is restored', async () => {
    const midnight = startOfTodayMs();
    setSavedAlertsRow(new Date(midnight - 3600000).toISOString(), ['app_utils:getToday:'], RESTORED_MARKER);
    assertEqual(await restoreAlerts(), [CAB_004_ALERT], 'yesterday: recomputed');
    await savedAlertsRow([CAB_004_ALERT]);
    setSavedAlertsRow(new Date(midnight + 3600000).toISOString(), ['app_utils:getToday:'], RESTORED_MARKER);
    assertEqual(await restoreAlerts(), RESTORED_MARKER, 'today: restored');
});

test('PERSISTED RESULTS', 'a local save invalidates a restored result through its relinked sources', async () => {
    setSavedAlertsRow(new Date(Date.now() + 60000).toISOString(), _alertSources, RESTORED_MARKER);
    assertEqual(await restoreAlerts(), RESTORED_MARKER, 'restored');
    const fired = new Set();
    const handler = (e) => fired.add(e.methodName);
    CacheInvalidationBus.on('api', handler);
    try {
        await _asUser(async () => Requests.savePreferences(await Requests.getPreferences())); // round trip
    } finally {
        CacheInvalidationBus.off('api', handler);
    }
    assertContains([...fired], 'getInventoryShortageAlerts', 'restored alerts invalidated');
    assertEqual(await Requests.getInventoryShortageAlerts(), [CAB_004_ALERT], 'recomputed after the save');
});

test('PERSISTED RESULTS', 'a stale row\'s sources are read in one request per spreadsheet', async () => {
    const tabsByTable = {};
    for (const source of _alertSources.filter(s => s.startsWith('database:getData:'))) {
        const [tableId, tabName] = JSON.parse(`[${source.slice('database:getData:'.length)}]`);
        (tabsByTable[tableId] ||= new Set()).add(tabName);
    }
    // Saved before today, and the clock is a source: stale
    setSavedAlertsRow(new Date(startOfTodayMs() - 3600000).toISOString(), _alertSources, RESTORED_MARKER);
    let alerts;
    const requests = await _recordTabReads(async () => { alerts = await restoreAlerts(); });
    assertEqual(alerts, [CAB_004_ALERT], 'recomputed');
    for (const [tableId, tabs] of Object.entries(tabsByTable)) {
        const first = requests.find(r => r.tableId === tableId && r.ranges.some(range => tabs.has(range)));
        const missing = [...tabs].filter(tab => !first?.ranges.includes(tab));
        assertEqual(missing, [], `${tableId} sources missing from its first request`);
    }
    await savedAlertsRow([CAB_004_ALERT]);
});

test('DATE ROLLOVER', 'the rollover invalidates results computed from today, once', async () => {
    try {
        pinToday(ALERTS_TODAY);
        await Requests.getInventoryShortageAlerts();
        const fired = new Set();
        const handler = (e) => fired.add(e.methodName);
        CacheInvalidationBus.on('api', handler);
        try {
            setTestToday('2025-01-02');
            checkDateRollover();
            assertContains([...fired], 'getInventoryShortageAlerts', 'alerts invalidated');
            assertContains([...fired], 'getMultipleShowsItemsSummary', 'report invalidated');
            fired.clear();
            checkDateRollover();
            assertEqual([...fired], [], 'no second invalidation for the same date');
        } finally {
            CacheInvalidationBus.off('api', handler);
        }
    } finally {
        pinToday(null);
    }
});

// ── Inventory tab preferences: the only source of per-tab inventory settings ──
// InventorySuppressCategoryAnalysis, InventoryCustomItemNumbers and InventoryDescriptionOnly list
// tab names; the inventory index has no flags. Fixture values: skip FURNITURE, MONITORS, LIGHTING,
// ELECTRONICS, ADDITIONS; custom item numbers HARDWARE; description only ADDITIONS.
// With today pinned to 2025-01-01, the 120-day report holds CAB-004 (CABINETS, runs short during
// ATSC 2025 NAB; see SHORTAGE ALERTS) and CHAIR-WHITE (FURNITURE, skipped by the fixture list).

const SKIP_TABS = '["FURNITURE","MONITORS","LIGHTING","ELECTRONICS","ADDITIONS"]';

test('INVENTORY TAB PREFERENCES', 'resolveInventoryTabList reads a JSON list of tab names', async () => {
    const id = INVENTORY_TAB_PREFERENCES.descriptionOnly;
    const pref = (value) => [{ id, value }];
    assertEqual(resolveInventoryTabList(pref('["ADDITIONS","SIGNS"]'), id), ['ADDITIONS', 'SIGNS'], 'list');
    assertEqual([null, [], pref(''), pref('not json'), pref('{"a":1}')].map(p => resolveInventoryTabList(p, id)), [[], [], [], [], []], 'missing or invalid');
    assertEqual(await InventoryUtils.getPreferenceTabs(INVENTORY_TAB_PREFERENCES.skipAnalysis), JSON.parse(SKIP_TABS), 'fixture skip list');
});

test('INVENTORY TAB PREFERENCES', 'the index carries no settings', async () => {
    // thumbnail is data (the prefix's category image), not a setting
    const index = await Requests.getInventoryIndexData();
    assertEqual(Object.keys(index[0]).sort(), ['folder', 'prefix', 'tab', 'thumbnail'], 'index row keys');
});

test('INVENTORY TAB PREFERENCES', 'a skipped tab leaves the reports, alerts and pack list checks', async () => {
    const reportItems = async () => (await Requests.getMultipleShowsItemsSummary({ dateFilters: shortageAlertDateFilters(120) }, {}, null, false)).map(row => row.itemId);
    try {
        pinToday(ALERTS_TODAY);
        const before = await reportItems();
        assertContains(before, 'CAB-004', 'fixture list: CABINETS reported');
        assertNotContains(before, 'CHAIR-WHITE', 'fixture list: FURNITURE skipped');
        await setPreference(INVENTORY_TAB_PREFERENCES.skipAnalysis, '["CABINETS"]');
        assertEqual(await reportItems(), ['CHAIR-WHITE'], 'report: CABINETS skipped, FURNITURE back');
        assertEqual(await Requests.getInventoryShortageAlerts(), [], 'alerts skip CABINETS');
        assertEqual(await Requests.checkInventoryLevel({ 'Extracted Item': 'CAB-004' }, 'ATSC 2025 NAB'), null, 'pack list check skips CABINETS');
    } finally {
        await setPreference(INVENTORY_TAB_PREFERENCES.skipAnalysis, SKIP_TABS);
        pinToday(null);
    }
});

test('INVENTORY TAB PREFERENCES', 'every tab listed for custom item numbers is scanned', async () => {
    const text = '(2) CAB-004 Curved-bottom counters';
    const hardware = '(10) 901 00 030 MKII brackets';
    assertEqual((await Requests.extractCustomItemFromText(text)).itemNumber, null, 'CABINETS not listed');
    await setPreference(INVENTORY_TAB_PREFERENCES.customItemNumbers, '["HARDWARE","CABINETS"]');
    try {
        const found = await Requests.extractCustomItemFromText(text);
        assertEqual([found.itemNumber, found.quantity], ['CAB-004', 2], 'CABINETS scanned');
        assertEqual((await Requests.extractCustomItemFromText(text, ['HARDWARE'])).itemNumber, null, 'category filter respected');
        assertEqual((await Requests.extractCustomItemFromText(hardware)).itemNumber, '901 00 030 MKII', 'HARDWARE still scanned');
    } finally {
        await setPreference(INVENTORY_TAB_PREFERENCES.customItemNumbers, '["HARDWARE"]');
    }
    await setPreference(INVENTORY_TAB_PREFERENCES.customItemNumbers, '[]');
    try {
        assertEqual(await Requests.getTabNameForItem('VUE-V2C-LP'), null, 'no tabs listed: hardware item numbers no longer resolve');
        assertEqual((await Requests.extractCustomItemFromText(hardware)).itemNumber, null, 'no tabs listed: nothing scanned');
    } finally {
        await setPreference(INVENTORY_TAB_PREFERENCES.customItemNumbers, '["HARDWARE"]');
    }
    assertEqual(await Requests.getTabNameForItem('VUE-V2C-LP'), 'HARDWARE', 'restored');
});

// Custom item numbers match whole item numbers only, longest first, so custom tabs have no
// item variants. With CABINETS listed, its rows CAB-006 and CAB-006a are custom item numbers:
// CAB-006a once matched CAB-006, the earlier row; CAB-006b and CAB-005b matched their bases.
test('INVENTORY TAB PREFERENCES', 'custom item numbers match whole item numbers only', async () => {
    const custom = async (text) => {
        const found = await Requests.extractCustomItemFromText(text);
        return [found.itemNumber, found.quantity];
    };
    assertEqual(await custom('(3) VUE-V2C-LP, spare'), ['VUE-V2C-LP', 3], 'followed by punctuation');
    assertEqual(await custom('(3) VUE-V2C-LPb connectors'), [null, 1], 'a letter appended is not the item');
    await setPreference(INVENTORY_TAB_PREFERENCES.customItemNumbers, '["HARDWARE","CABINETS"]');
    try {
        assertEqual(await custom('(3) CAB-006a Rolling demo cabinet'), ['CAB-006a', 3], 'longer item number wins');
        assertEqual(await custom('(1) CAB-006b Rolling demo cabinet'), [null, 1], 'no variant fallback');
        assertEqual(await Requests.extractItemNumber('(2) CAB-005b Tall gray storage cabinet'), null, 'extraction: no variants in custom tabs');
        assertEqual(await Requests.extractItemNumber('(3) CAB-006a Rolling demo cabinet'), 'CAB-006a', 'extraction: whole item number');
    } finally {
        await setPreference(INVENTORY_TAB_PREFERENCES.customItemNumbers, '["HARDWARE"]');
    }
});

// ── App update: an out-of-date session refuses data writes ───────────────────
// A newer deploy is simulated by changing the version this session loaded (window.__deployedVersion),
// so version.json no longer matches it. Expected: isAppOutdated() is true and a write is refused with
// code APP_OUTDATED before it reaches the sheets; with the versions matching again, isAppOutdated()
// is false.

test('APP UPDATE', 'a data write is refused while a newer version is deployed', async () => {
    const loaded = window.__deployedVersion;
    window.__deployedVersion = 'test-older-version';
    let code = null;
    try {
        await checkAppVersion();
        assertEqual(isAppOutdated(), true, 'outdated');
        try {
            await Requests.saveData('CACHE', 'AppUpdateTest', [{ a: '1' }], { a: 'A' });
        } catch (error) {
            code = error.code;
        }
    } finally {
        window.__deployedVersion = loaded;
        await checkAppVersion();
    }
    assertEqual(code, 'APP_OUTDATED', 'refusal code');
    assertEqual(isAppOutdated(), false, 'current again');
});

// ── Runner export ─────────────────────────────────────────────────────────────

// ── Sheet health: last, after every test that writes to the fixture sheets ─────
// A test (or the process it covers) that leaves a sheet in a state the app can't rely on fails
// here before it is deployed. tests/sheetHealth.js is test-only and never loads on the live site.

// The fake schedule deliberately holds multi-booth shows (two rows, one Client + Year + Show);
// writes to those rows are refused. Any other issue means the fixture data is in a bad state.
const IW_KNOWN_DUPLICATES = ['multiboothco / 2026 / multi booth', 'qgenda / 2024 / himss', 'qgenda / 2025 / himss'];

test('SHEET HEALTH', 'the Production Schedule has only its known multi-booth duplicates', async () => {
    const health = await checkSheetHealth(IW_DB, IW_TAB);
    const other = health.issues.filter(i => i.kind !== 'duplicate-identity').map(i => i.message);
    assertEqual(other, [], 'no other issues');
    const dups = health.issues.filter(i => i.kind === 'duplicate-identity').map(i => i.message.replace(/^Rows [\d, ]+ share the identity /, '')).sort();
    assertEqual(dups, IW_KNOWN_DUPLICATES, 'known duplicates only');
});

test('SHEET HEALTH', 'ShowNotes has one row per show identifier', async () => {
    const health = await checkSheetHealth('CACHE', 'ShowNotes', { identity: ['Identifier'], columns: ['Identifier', 'Note', 'EditHistory'] });
    assertEqual(health.issues.map(i => i.message), [], 'no issues');
});

export async function runTests() {
    setFakeDelaysEnabled(false);
    // Run against pristine fixtures; local data (saved across reloads) is restored afterwards
    const endSandbox = FakeGoogleState.beginSandbox();
    refreshAppData();
    try {
        // Ensure authenticated before any API-dependent tests run.
        // Auth tests below start with logout() so they still test from an unauthenticated state.
        await FakeGoogleSheetsAuth.authenticate();

        console.group('%c TopShelf Test Suite', 'font-weight:bold;color:#6366f1');

        let lastGroup = null;
        const failed = [];

        for (const { group, name, fn } of _tests) {
            if (group !== lastGroup) {
                if (lastGroup !== null) console.groupEnd();
                console.group(`[${group}]`);
                lastGroup = group;
            }
            try {
                await fn();
                console.log(`%c ✓ ${name}`, 'color:#22c55e');
            } catch (e) {
                console.error(`%c ✗ ${name}`, 'color:#ef4444', '\n  ', e.message);
                failed.push({ group, name, error: e.message });
            }
        }

        if (lastGroup !== null) console.groupEnd();

        const passed = _tests.length - failed.length;
        const style = failed.length ? 'color:#ef4444;font-weight:bold' : 'color:#22c55e;font-weight:bold';
        console.log(`%c ${passed} passed, ${failed.length} failed`, style);
        console.groupEnd();

        return { passed, failed };
    } finally {
        endSandbox();
        refreshAppData();
        setFakeDelaysEnabled(true);
    }
}
