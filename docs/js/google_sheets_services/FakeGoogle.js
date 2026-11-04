/**
 * Fake Google Sheets implementations for testing purposes
 * Provides dummy data and authentication objects that mirror the real GoogleSheetsAuth and GoogleSheetsService
 */

import { SheetSql } from './sheetSql.js';
import { BaseTokenManager } from './GoogleSheetsAuth.js';
import { normalizeHeaderName, isLocalhost } from '../data_management/utils/helpers.js';

// A1 column letters → 0-based index ("A" → 0, "Z" → 25, "AA" → 26)
function _colToIndex(letters) {
    let n = 0;
    for (const ch of String(letters)) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

let _delaysEnabled = true;

// Serialize an EditHistory/MetaData fixture (contract: docs/notes/metadata-implementation.md)
const _json = (value) => JSON.stringify(value);

// ── Local dev state (see FakeGoogleState at the end of this file) ──
const DEFAULT_FAKE_USER = 'test@example.com';
const STATE_STORAGE_KEY = 'fakeGoogle:state';      // localStorage: persisted mockData/mockTabs
const PERSIST_STORAGE_KEY = 'fakeGoogle:persist';  // localStorage: '0' disables persistence
const USER_STORAGE_KEY = 'fakeGoogle:user';        // sessionStorage: per-browser-tab fake user
let _sandboxed = false;                            // true while the test suite runs on pristine fixtures

function _storageGet(area, key) {
    try { return window[area].getItem(key); } catch { return null; }
}
function _storageSet(area, key, value) {
    try {
        if (value === null) window[area].removeItem(key);
        else window[area].setItem(key, value);
        return true;
    } catch (error) {
        console.warn(`[FakeGoogle] Could not write ${area} "${key}":`, error);
        return false;
    }
}

/** The fake signed-in user: per-tab override, or the default test account (always the default in the test sandbox) */
function _configuredEmail() {
    if (_sandboxed) return DEFAULT_FAKE_USER;
    return _storageGet('sessionStorage', USER_STORAGE_KEY) || DEFAULT_FAKE_USER;
}
export function setFakeDelaysEnabled(enabled) { _delaysEnabled = enabled; }

// A1 sheet names may be quoted ('Production Schedule'!A5:Z5); quotes inside are doubled
function _unquoteSheetName(name) {
    const m = /^'(.*)'$/.exec(name || '');
    return m ? m[1].replace(/''/g, "'") : name;
}

export class FakeGoogleSheetsAuth {
    static userEmail = _configuredEmail();
    static isInitialized = false;
    static isAuthenticatedState = false;
    static _authenticatePromise = null;

    static async initialize() {
        await this.delay(100); // Simulate async initialization
        this.isInitialized = true;
        return true;
    }

    static async authenticate() {
        if (this._authenticatePromise) {
            return this._authenticatePromise;
        }

        this._authenticatePromise = this._authenticateInternal()
            .finally(() => {
                this._authenticatePromise = null;
            });

        return this._authenticatePromise;
    }

    static async _authenticateInternal() {
        await this.delay(200); // Simulate authentication delay
        this.isAuthenticatedState = true;
        this.userEmail = _configuredEmail(); // Reset email on re-authentication
        
        // Create fresh token with current timestamp
        const mockToken = {
            access_token: 'fake_access_token_' + Date.now(),
            token_type: 'Bearer',
            expires_in: 3600,
            timestamp: Date.now()
        };
        BaseTokenManager.storeToken(mockToken);
        return true;
    }

    static async checkAuth() {
        if (!this.isInitialized) {
            await this.initialize();
        }
        return this.isAuthenticatedState && !BaseTokenManager.isTokenExpired(BaseTokenManager.getStoredToken());
    }

    static async silentRefresh() {
        if (!this.isAuthenticatedState) return false;
        // Simulate a silent token renewal — refresh the stored token timestamp
        const mockToken = {
            access_token: 'fake_access_token_' + Date.now(),
            token_type: 'Bearer',
            expires_in: 3600,
            timestamp: Date.now()
        };
        BaseTokenManager.storeToken(mockToken);
        return true;
    }

    static getTokenSecondsRemaining() {
        const token = BaseTokenManager.getStoredToken();
        if (!token || !token.timestamp) return 0;
        const tokenAge = (Date.now() - token.timestamp) / 1000;
        return Math.max(0, 3500 - tokenAge);
    }

    static isAuthenticated() {
        return this.isAuthenticatedState && !BaseTokenManager.isTokenExpired(BaseTokenManager.getStoredToken());
    }

    static async getUserEmail() {
        await this.delay(50);
        return this.userEmail;
    }

    static async logout() {
        this.userEmail = null;
        this.isAuthenticatedState = false;
        BaseTokenManager.clearStoredToken();
        await this.delay(100);
    }

    static getMissingScopes() {
        return [];
    }

    // Utility method to simulate async delays
    static delay(ms) {
        if (!_delaysEnabled) return Promise.resolve();
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export class FakeGoogleSheetsService {
    /**
     * Transform raw sheet data to JS objects using mapping
     */
    static transformSheetData(rawData, mapping, sheetName = null) {
        if (!rawData || rawData.length < 2 || !mapping) return [];
        
        // Normalize headers to remove carriage returns and extra whitespace
        const headers = Array.isArray(rawData[0])
            ? rawData[0].map(h => normalizeHeaderName(h))
            : [];
        const rows = rawData.slice(1);
        const headerIdxMap = {};
        Object.entries(mapping).forEach(([key, headerName]) => {
            // Skip _orderedHeaders metadata property (used only for reverseTransformSheetData)
            if (key === '_orderedHeaders') return;
            
            const normalizedHeaderName = normalizeHeaderName(headerName);
            const idx = headers.findIndex(h => h === normalizedHeaderName);
            if (idx !== -1) headerIdxMap[key] = idx;
        });
        return rows.map(row => {
            const obj = {};
            Object.keys(mapping).forEach(key => {
                obj[key] = row[headerIdxMap[key]] ?? '';
            });
            return obj;
        }).filter(obj => Object.values(obj).some(val => val !== ''));
    }

    /**
     * Reverse transform JS objects to sheet data using mapping
     */
    static reverseTransformSheetData(mapping, mappedData) {
        if (!mappedData || mappedData.length === 0) return [];
        
        // Use _orderedHeaders if provided (to preserve column order), otherwise fall back to Object.values
        const headers = mapping._orderedHeaders || Object.values(mapping).filter(v => v !== mapping._orderedHeaders);
        
        const rows = mappedData.map(obj => headers.map(h => {
            const key = Object.keys(mapping).find(k => mapping[k] === h);
            return key ? obj[key] ?? '' : '';
        }));
        return [headers, ...rows];
    }
    static ENDPOINT_IDS = {
        'INVENTORY': 'fake_inventory_sheet_id',
        'PACK_LISTS': 'fake_pack_lists_sheet_id',
        'PROD_SCHED': 'fake_prod_sched_sheet_id',
        'CACHE': 'fake_cache_sheet_id'
    };

    // Mock data for different sheets
    // NOTE: CACHE/Caching tab is dynamically initialized on first access in getSheetData, not pre-defined here.
    // This allows writeCacheTimestamp to write updated timestamps that are actually read by the poller,
    // enabling proper testing of cache invalidation flows in localhost development.
    static mockData = {
        'INVENTORY': {
            'ADDITIONS': [
                ['ITEM#', 'THUMBNAIL', 'QTY', 'EditHistory', 'MetaData', 'NOTES', 'Description', 'Packing/shop notes'],
                ['ADD-001', '', '', '', '', '', 'Custom Branded Tablecloth', ''],
                ['ADD-002', '', '', '', '', '', 'Hanging Banner Print', '']
            ],
            'HARDWARE': [
                ['ITEM#', 'THUMBNAIL', 'QTY', 'EditHistory', 'MetaData', 'NOTES', 'Description', 'Packing/shop notes'],
                ['M8x16', '', '500', '', '', '', 'M8 x 16mm bolt', ''],
                ['M8x20', '', '300', '', '', '', 'M8 x 20mm bolt', ''],
                ['FOOT-L', '', '100', '', '', '', 'Large leveling foot', '']
            ],
            'FURNITURE': [
                ['ITEM#', 'THUMBNAIL', 'QTY', 'EditHistory', 'MetaData', 'NOTES', 'Description', 'Packing/shop notes'],
                ['TABLE-001', '', '2', '', '', '', 'Conference room table black 30 x 76 x 30', ''],
                ['TABLE-002', '', '2', '', '', '', 'Glass-top square end table w/ metal bases 18x18x16', ''],
                ['TABLE-003', '', '2', '', '', '', 'Glass-top rectangular coffee table w/ metal bases 42x18x16', ''],
                ['CHAIR-001', '', '20', '', '', '', 'Stack Chair ( Black & Black ) w/ Arms', ''],
                ['CHAIR-002', '', '15', '', '', '', 'Lounge Chair (White Leather) Swivel Barrel', ''],
                // CHAIR-003: three history entries and a future scheduled restock
                ['CHAIR-003', '', '12', _json({
                    i: 4,
                    h: [
                        { u: 'dan', t: 17912947200, s: 'restock', c: [{ n: 'quantity', o: '10' }] },
                        { u: 'sam', t: 17894019000, s: 'web', c: [{ n: 'description', o: 'Cube chair (black) collapsible' }] },
                        { u: 'dan', t: 17857668000, s: 'web', c: [{ n: 'quantity', o: '8' }, { n: 'notes', o: 'check legs' }] }
                    ],
                    p: [{ u: 'dan', t: 18118224000, d: 17912940000, s: 'summer order', c: [{ n: 'quantity', ne: '+6' }] }]
                }), '', '', 'Cube chair (black?) collapsible', ''],
                // CHAIR-004: past-due scheduled change, applied when the FURNITURE table is opened
                ['CHAIR-004', '', '', _json({
                    i: 5,
                    h: [],
                    p: [{ u: 'sam', t: 17684532000, d: 17680000000, s: 'new stock', c: [{ n: 'quantity', ne: '+5' }] }]
                }), '', '', 'Conference swivel chair (white)', ''],
                ['STOOL-001', '', '12', '', '', '', 'Ikea Glenn Stool, stacking bar-height (White)', ''],
                ['STOOL-002', '', '12', '', '', '', 'Square Stool, stacking bar-height (White Leather)', ''],
                ['STOOL-003', '', '20', '', '', '', 'Square Hi-back Stool, stacking bar-height (White Leather)', ''],
                ['COUCH-001', '', '2', '', '', '', 'white leather curved sofa sections', ''],
                ['TTOP-001', '', '15', '', '', '', '30" white cocktail table tops-round', ''],
                ['TBASE-001', '', '8', '', '', '', 'cocktail table bases', '']
            ],
            'CABINETS': [['ITEM#', 'THUMBNAIL', 'QTY', 'EditHistory', 'MetaData', 'NOTES', 'Description', 'Packing/shop notes'],['CAB-004', '', '10', '', '', '', 'Curved-bottom white demo counter with 30" wide top and LED lighting. (4) standoffs on front and top. Test LED lights', '']],
            'HANGING SIGNS': [['ITEM#', 'THUMBNAIL', 'QTY', 'EditHistory', 'MetaData', 'Description', 'Packing/shop notes'],['HS-001', '', '0', '', '', 'This is a sign', '']],
            'CEILING TILES': [['ITEM#', 'THUMBNAIL', 'QTY', 'EditHistory', 'MetaData', 'NOTES', 'Description', 'Packing/shop notes'],['C1', '', '0', '', '', '', 'Blah blah blah', '']],
            'CEILING TRIM': [['ITEM#', 'THUMBNAIL', 'QTY', 'EditHistory', 'MetaData', 'NOTES', 'Description', 'Packing/shop notes'],['S1', '', '0', '', '', '', 'Blah blah blah', '']],
            'LIGHTBOXES': [['ITEM#', 'THUMBNAIL', 'QTY', 'EditHistory', 'MetaData', 'NOTES', 'Description', 'Packing/shop notes'],['LB-001', '', '0', '', '', '', 'Blah blah blah', '']],
            'COUNTERTOPS': [['ITEM#', 'THUMBNAIL', 'QTY', 'EditHistory', 'MetaData', 'NOTES', 'Description', 'Packing/shop notes'],['CNTR-001', '', '0', '', '', '', 'Blah blah blah', '']],
            'SHELVES': [['ITEM#', 'THUMBNAIL', 'QTY', 'EditHistory', 'MetaData', 'NOTES', 'Description', 'Packing/shop notes'],['SHLF-001', '', '0', '', '', '', 'Blah blah blah', '']],
            // New inventory tabs for enhanced item types
            'PANELS': [
                ['ITEM#', 'THUMBNAIL', 'QTY', 'EditHistory', 'MetaData', 'NOTES', 'Description', 'Packing/shop notes'],
                // Standard rectangular panels
                ['BX-16x39', '', '10', '', '', '', 'Standard rectangular panel 16" x 39"', 'Pack flat'],
                ['BX-16x47', '', '8', '', '', '', 'Standard rectangular panel 16" x 47"', 'Pack flat'],
                ['BX-15x39', '', '12', '', '', '', 'Standard rectangular panel 15" x 39"', 'Pack flat'],
                // Circular panels
                ['BX-○39', '', '5', '', '', '', 'Circular panel 39" diameter', 'Protect edges'],
                ['BX-○19', '', '8', '', '', '', 'Circular panel 19" diameter', 'Protect edges'],
                ['BX-○16', '', '10', '', '', '', 'Circular panel 16" diameter', 'Protect edges'],
                // Special panels
                ['BX-M8○5', '', '3', '', '', '', 'Metric circular panel M8, 5 units', 'Special order'],
                ['BX-10Rx39P', '', '4', '', '', '', 'Curved panel 10R x 39" with pole', 'Poles separate'],
                // Curved panels
                ['BX-2Rx8', '', '6', '', '', '', 'Small curved panel 2R x 8"', 'Pack carefully'],
                ['BX-2Rx16', '', '5', '', '', '', 'Small curved panel 2R x 16"', 'Pack carefully'],
                ['BX-2Rx39', '', '3', '', '', '', 'Large curved panel 2R x 39"', 'Pack carefully'],
                // Angled curved panels
                ['BX-3Rx8_45°', '', '4', '', '', '', 'Curved panel 3R x 8" at 45° angle', 'Note angle'],
                ['BX-3Rx8', '', '6', '', '', '', 'Curved panel 3R x 8"', 'Standard curve'],
                ['BX-3Rx19_45°', '', '3', '', '', '', 'Curved panel 3R x 19" at 45° angle', 'Note angle'],
                ['BX-3Rx39_45°', '', '2', '', '', '', 'Large curved panel 3R x 39" at 45° angle', 'Note angle'],
                // VUE brand panels
                ['VU-8x39', '', '7', '', '', '', 'VUE brand panel 8" x 39"', 'VUE specific'],
                ['VU-16x39', '', '5', '', '', '', 'VUE brand panel 16" x 39"', 'VUE specific']
            ],
            'HARDWARE': [
                ['ITEM#', 'THUMBNAIL', 'QTY', 'EditHistory', 'MetaData', 'NOTES', 'Description', 'Packing/shop notes'],
                // VUE multi-segment alphanumeric
                ['VUE-V2C-LP', '', '20', '', '', '', 'VUE V2C low profile connector', 'Small parts'],
                // 901 series spaced numeric hardware
                ['901 00 030 MKII', '', '50', '', '', '', '901 series mounting bracket Mark II', 'Hardware kit'],
                ['901 00 033', '', '45', '', '', '', '901 series mounting bracket', 'Hardware kit'],
                ['901 10 08 G', '', '100', '', '', '', '901 series galvanized connector', 'Bulk item'],
                ['901 11 09 2X TG', '', '75', '', '', '', '901 series 2X TG fastener', 'Bulk item'],
                ['901 2018 0062 ECO', '', '30', '', '', '', '901 ECO series connector 2018', 'Eco line'],
                ['901 2025 0132 POM', '', '25', '', '', '', '901 POM series part 2025', 'New stock'],
                ['901 28 0222 INOX', '', '60', '', '', '', '901 INOX stainless steel fastener', 'Corrosion resistant'],
                ['901 28 0224 GALVA', '', '55', '', '', '', '901 galvanized fastener', 'Outdoor use'],
                ['901 28 0341 E', '', '80', '', '', '', '901 E-series connector', 'Standard'],
                ['901 28 0342 E', '', '75', '', '', '', '901 E-series connector variant', 'Standard'],
                // 250 series LED hardware
                ['250 05 50 LED - LED50WW', '', '25', '', '', '', 'LED strip 50WW warm white', 'Fragile'],
                // LED controllers
                ['LED-EXL21-SL', '', '10', '', '', '', 'LED controller EXL21 silver', 'Electronics'],
                // 615 series hardware
                ['615 11 01 ANO', '', '200', '', '', '', '615 series anodized fastener', 'Bulk item'],
                // HH brand text-based hardware
                ['HH BOLTHOG 1-4 20 x 2.5', '', '150', '', '', '', 'HH bolt M4-20 x 2.5mm', 'Hardware kit'],
                ['HH BOLTHOG 1-4 20 x 3', '', '120', '', '', '', 'HH bolt M4-20 x 3mm', 'Hardware kit'],
                ['HH BOLTHOG M8 LONG', '', '100', '', '', '', 'HH bolt M8 long size', 'Hardware kit'],
                ['HH BRACKET UPPER 62', '', '40', '', '', '', 'HH upper mounting bracket size 62', 'Mounting hardware']
            ],
            // Archive of deleted rows (written by Database._archiveDeletedRows)
            '_EditHistory': [
                ['SourceTable', 'SourceTab', 'RowIdentifier', 'Username', 'Timestamp', 'Operation', 'RowData'],
                ['INVENTORY', 'FURNITURE', '9', 'dan@example.com', '17899164000', 'delete', _json({
                    itemNumber: 'CHAIR-099', quantity: '4', description: 'Folding chair (retired)', notes: '',
                    edithistory: _json({ i: 9, h: [{ u: 'dan', t: 17857668000, s: 'web', c: [{ n: 'quantity', o: '6' }] }] })
                })]
            ]
        },
        'PACK_LISTS': {
            '_TEMPLATE': [
                ['Piece #', 'Type', 'L', 'W', 'H', 'Weight', 'Pack', 'Check', 'Description', 'Packing/shop notes', 'EditHistory', 'MetaData'],
                ['1', '', '', '', '', '', '', '', '', '', '', '']
            ],
            'ATSC 2025 NAB': [
                ['Piece #', 'Type', 'L', 'W', 'H', 'Weight', 'Pack', 'Check', 'Description', 'Packing/shop\nnotes', 'EditHistory', 'MetaData'],
                ['1', 'Skid', '72', '32', '48', '800', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(1) straight-section reception counter', 'Sintra logo- last CES 2025', '{"h":[{"u":"cadbot","t":17309064100,"s":"cad","c":[{"n":"Description","o":"(1) straight-section reception counter (one of two sections). Test lighting"}]},{"u":"dan","t":17309064000,"s":"web","c":[{"n":"Description","o":"(1) straight-section reception counter (one of two sections)"}]}]}', ''],
                ['', '', '', '', '', '', '', '', 'Client junk', '', '', ''],
                ['2', 'Skid', '120', '48', '48', '1200', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(3) rolls 10\'x70\' SLATE gray carpeting', '', '', ''],
                ['3', 'Skid', '120', '48', '48', '600', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Padding for 30x70', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Padding For Triveni', 'Booth # W3067', '', ''],
                ['4', 'Crate', '72', '48', '48', '800', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(4) CAB-004 Curved-bottom white demo counter with 30" wide top and LED lighting. (4) standoffs on front and top. Test LED lights', '', '', ''],
                ['', '', '', '', '', '', '', '', 'SEG\'s', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Blank SEG\'s', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Client Packages', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Front office items and other inbound client items', '', '', ''],
                ['', '', '', '', '', '', '', '', 'All Sintra/foamcore signs', 'New from Olympus', '', ''],
                ['', '', '', '', '', '', '', '', 'Set top graphics (paper or foamcore)', 'New from Olympus', '', ''],
                ['', '', '', '', '', '', '', '', 'Package (all) cardboard easelbacks prints', 'Office', '', ''],
                ['', '', '', '', '', '', '', '', '5" carboard easelbacks packet', 'Inbound purchase', '', ''],
                ['', '', '', '', '', '', '', '', '(6) Acrylic wedge blocks/frames 3"x10"', 'Office. Add new prints prior to packing', '', ''],
                ['5', 'Crate', '72', '48', '48', '800', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(4) CAB-004 Curved-bottom white demo counter with 30" wide top and LED lighting. (4) standoffs on front and top. Test LED lights', '', '', ''],
                ['', '', '', '', '', '', '', '', 'TEJAS ITEMS- AS RECEIVED', '', '', ''],
                ['6', 'Crate', '72', '48', '48', '800', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(3) CAB-004 Curved-bottom white demo counter with 30" wide top and LED lighting. (4) standoffs on front and top. Test LED lights', '', '', ''],
                ['7', 'Coffin Crate', '', '', '', '', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', 'On Top: Hanging sign frame 18\'x18\'x5\'', '32 horizontal members; 4 corner posts (54") 12 spreaders (54"+); 8 corner blocks, eye bolts and connectors', '', ''],
                ['', '', '', '', '', '', '', '', 'On Top: Hangiing sign fabric cover- ATSC', 'Last- CES 2025', '', ''],
                ['', '', '', '', '', '', '', '', 'Sintra prints- all elevations', 'New from Olympus', '', ''],
                ['', '', '', '', '', '', '', '', 'Sintra prints existing', 'From CES/NAB', '', ''],
                ['', '', '', '', '', '', '', '', 'BeMatrix H/W', '', '', ''],
                ['', '', '', '', '', '', '', '', '(10) extra blocking boards for 992 frames', 'Not on BeMatrix pick list', '', ''],
                ['', '', '', '', '', '', '', '', '(24) extra metal drop in brackets', 'Not on BeMatrix pick list', '', ''],
                ['', '', '', '', '', '', '', '', '(1) Yamaha powered speakers with cords', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Corded microphone kit', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Wireless presenter\'s kit', '', '', ''],
                ['', '', '', '', '', '', '', '', 'White demo counter top @ 48" wide x 20" deep', '3/4"; cut down from a larger oversized top. Drill holes for standoffs for demo cabinet', '', ''],
                ['', '', '', '', '', '', '', '', 'Grey countertop with existing grommet caps (black) all in place and taped down', 'Last-CES. Verify size vs. drawing', '', ''],
                ['', '', '', '', '', '', '', '', '(2) white counter sections @ 95"x18" for hospitality bar', '', '', ''],
                ['', '', '', '', '', '', '', '', '(16) heavy L brackets for shelf supports', 'Packed with Hardware', '', ''],
                ['', '', '', '', '', '', '', '', '8.5x11 lit acrylic lit pockets (6)', 'Clean/matching', '', ''],
                ['', '', '', '', '', '', '', '', '(6) 19" TV\'s with small mount kits', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Square glass cocktail table kit', '', '', ''],
                ['', '', '', '', '', '', '', '', '(1) laminated riser from MOJO SHOT show', '30"x30"x12"', '', ''],
                ['', '', '', '', '', '', '', '', '(2) 55" Samsung TV screen', 'Top Shelf rentals', '', ''],
                ['', '', '', '', '', '', '', '', 'Power cord', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Remote with batteries', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Wall mount (large)', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Arms (for large)', '', '', ''],
                ['', '', '', '', '', '', '', '', '(8) 48" sticks @ 3/4" for Sintra posters', 'Cut new', '', ''],
                ['', '', '', '', '', '', '', '', '(10) Sintra placard logos', 'New from Olympus', '', ''],
                ['', '', '', '', '', '', '', '', 'Existing Sintra logos', 'Office', '', ''],
                ['', '', '', '', '', '', '', '', '(2) cocktail table bases', '', '', ''],
                ['', '', '', '', '', '', '', '', '(1) 36" white round table tops', '', '', ''],
                ['', '', '', '', '', '', '', '', '(3) 30" white round table tops', '', '', ''],
                ['', '', '', '', '', '', '', '', '(4) 24" white round tops', '', '', ''],
                ['', '', '', '', '', '', '', '', '(4) SEATED table bases (three-piece from Nuance)', 'Collar, base pairs and posts. Check for the metric bolts in the table legs (both ends)', '', ''],
                ['', '', '', '', '', '', '', '', 'General supplies', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Electrical supplies', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Pouch with setups/keys', '', '', ''],
                ['8', 'Skid', '96', '48', '60', '', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(3) Rectangular U-shaped white demo desk with grommet holes top and bottom-back and removable access cover (Sintra). Tape down grommet caps', 'Repair laminate/touch up as needed. Must be finished on both ends. Skin with clean new white Sintra. Matching widths (20")', '', ''],
                ['', '', '', '', '', '', '', '', '(5) full size storage racks', '', '', ''],
                ['', '', '', '', '', '', '', '', '(2) cocktail table bases', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Bar fridge for reception tower', 'Larger bar size. Cleaned.', '', ''],
                ['', '', '', '', '', '', '', '', '(1) bar fridge', '', '', ''],
                ['', '', '', '', '', '', '', '', '(12) Black fabric arm chairs', '', '', ''],
                ['9', 'Skid', '120', '48', '48', '800', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', 'All client-supplied TV\'s', 'Inbound/marked', '', ''],
                ['', '', '', '', '', '', '', '', 'Top Shelf TV\'s/accessories:', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Box of small wall mounts and paired arms', '6 Sets', '', ''],
                ['', '', '', '', '', '', '', '', 'Box of large wall mounts and paired arms', '16 sets', '', ''],
                ['10', 'Skid', '96', '48', '72', '800', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(6) IKEA counter-height white stools', 'Tighten foot rests/seats and clean', '', ''],
                ['', '', '', '', '', '', '', '', '(22) IKEA BAR-height white stools', 'Tighten foot rests/seats and clean', '', ''],
                ['', '', '', '', '', '', '', '', '(3) CURVED LOUNGE CLUB CHAIR-WHITE WITH LEGS', '', '', ''],
                ['11', 'Skid', '96', '48', '72', '800', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', 'BeMatrix frames/accessories', 'Per separate pack list', '', ''],
                ['', '', '', '', '', '', '', '', '(4) 4\'x8\' sheets white Sintra', 'New- for misc. use onsite', '', ''],
                ['', '', '', '', '', '', '', '', 'Sintra Graphics', '', '', ''],
                ['12', 'Skid', '96', '48', '72', '800', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', 'BeMatrix frames/accessories', 'Per separate pack list', '', ''],
                ['13', 'Skid', '96', '48', '72', '800', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', 'BeMatrix frames/accessories', 'Per separate pack list', '', ''],
                ['14', 'Skid', '96', '48', '72', '800', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', 'BeMatrix frames/accessories', 'Per separate pack list', '', ''],
                ['15', 'Skid', '96', '48', '72', '800', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', 'BeMatrix frames/accessories', 'Per separate pack list', '', '']
            ],
            'TULIP 2025 NRF': [
                ['Piece #', 'Type', 'L', 'W', 'H', 'Weight', 'Pack', 'Check', 'Description', 'Packing/shop notes', 'EditHistory', 'MetaData'],
                ['1', 'Skid', '72', '32', '48', '800', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(1) straight-section reception counter (one of two sections). Test lighting', 'Sintra logo- last CES 2025', '', ''],
                ['', '', '', '', '', '', '', '', 'Client junk', '', '', ''],
                ['2', 'Skid', '120', '48', '48', '1200', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(3) rolls 10\'x70\' SLATE gray carpeting', '', '', ''],
                // Crate 3: row identities, a grouped pair, and a CAD edit over a web edit
                ['3', 'Skid', '120', '48', '48', '600', '', '', '', '', _json({ i: 1, h: [] }), ''],
                ['', '', '', '', '', '', '', '', 'Padding for 30x70', '', _json({
                    i: 2,
                    h: [{ u: 'dan', t: 17908794000, s: 'web', c: [{ n: 'metadata', o: '' }] }]
                }), _json({ grouping: { groupId: 'fixture-padding', isGroupMaster: true } })],
                ['', '', '', '', '', '', '', '', 'Padding For Triveni', 'Booth # W3067', _json({
                    i: 3,
                    h: [{ u: 'dan', t: 17908794000, s: 'web', c: [{ n: 'metadata', o: '' }, { n: 'Packing/shop notes', o: '' }] }]
                }), _json({ grouping: { groupId: 'fixture-padding', isGroupMaster: false } })],
                ['', '', '', '', '', '', '', '', 'SEG\'s', '', _json({
                    i: 4,
                    h: [
                        { u: 'cadbot', t: 17912940000, s: 'cad', c: [{ n: 'Description', o: 'SEGs (12)' }] },
                        { u: 'sam', t: 17899164000, s: 'web', c: [{ n: 'Description', o: 'SEGs' }] }
                    ]
                }), ''],
                ['', '', '', '', '', '', '', '', 'Blank SEG\'s', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Client Packages', '', '', '']
            ],
            'LOCKHEED MARTIN 2025 NGAUS': [
                ['Piece #', 'Type', 'L', 'W', 'H', 'Weight', 'Pack', 'Check', 'Description', 'Packing/shop notes', 'EditHistory', 'MetaData'],
                ['1', 'Skid', '72', '32', '48', '800', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(1) straight-section reception counter (one of two sections). Test lighting', 'Sintra logo- last CES 2025', '', ''],
                ['', '', '', '', '', '', '', '', 'TABLE-001 Client junk', '', '', ''],
                ['2', 'Skid', '120', '48', '48', '1200', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(3) rolls 10\'x70\' SLATE gray carpeting', '', '', ''],
                ['3', 'Skid', '120', '48', '48', '600', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(4) CAB-004 Curved-bottom white demo counter with 30" wide top and LED lighting. (4) standoffs on front and top. Test LED lights', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Padding For Triveni', 'Booth # W3067', '', ''],
                ['', '', '', '', '', '', '', '', 'SEG\'s', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Blank SEG\'s', '', '', ''],
                ['', '', '', '', '', '', '', '', 'TABLE-001 Conference room table black 30 x 76 x 30', '', '', '']
            ],
            'LOCKHEED MARTIN 2025 NGAUS VIP LOUNGE': [
                ['Piece #', 'Type', 'L', 'W', 'H', 'Weight', 'Pack', 'Check', 'Description', 'Packing/shop notes', 'EditHistory', 'MetaData'],
                ['1', 'Crate', '48', '32', '36', '400', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(2) CHAIR-102 Executive leather chairs', 'Black leather', '', ''],
                ['', '', '', '', '', '', '', '', '(3) CAB-004 Curved-bottom white demo counter', 'Additional VIP counters', '', ''],
                ['2', 'Box', '24', '24', '24', '100', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(1) TABLE-012 Coffee table walnut finish', 'VIP lounge area', '', ''],
                ['', '', '', '', '', '', '', '', 'LIGHT-055 LED strip lighting kit', 'For accent lighting', '', ''],
                ['3', 'Crate', '60', '40', '40', '500', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(2) PANEL-210 Privacy screens 6ft tall', 'Black fabric panels', '', ''],
                ['', '', '', '', '', '', '', '', '(1) SHELF-075 Wall mounted display shelf', 'Chrome finish', '', '']
            ],
            'QGENDA 2025 HIMSS': [
                ['Piece #', 'Type', 'L', 'W', 'H', 'Weight', 'Pack', 'Check', 'Description', 'Packing/shop notes', 'EditHistory', 'MetaData'],
                ['1', 'Crate', '72', '48', '48', '600', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(2) TABLE-001 Standard Tables', 'Main booth display', '', ''],
                ['', '', '', '', '', '', '', '', '(6) CHAIR-102 Executive Chairs', 'Meeting area', '', ''],
                ['2', 'Box', '36', '36', '36', '200', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(4) LIGHT-055 LED Light Panels', 'Booth lighting', '', '']
            ],
            'TEST CLIENT 2025 HIMSS': [
                ['Piece #', 'Type', 'L', 'W', 'H', 'Weight', 'Pack', 'Check', 'Description', 'Packing/shop notes', 'EditHistory', 'MetaData'],
                ['1', 'Crate', '72', '48', '48', '600', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(3) TABLE-001 Standard Tables', 'Main booth display', '', ''],
                ['', '', '', '', '', '', '', '', '(6) CHAIR-102 Executive Chairs', 'Meeting area', '', ''],
                ['2', 'Box', '36', '36', '36', '200', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(4) LIGHT-055 LED Light Panels', 'Booth lighting', '', '']
            ],
            'AUSTAL 2026 SNA': [
                ['Piece #', 'Type', 'L', 'W', 'H', 'Weight', 'Pack', 'Check', 'Description', 'Packing/shop notes', 'EditHistory', 'MetaData'],
                ['1', 'Crate', '96', '48', '48', '800', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(4) TABLE-001 Display Tables', 'Navy exhibition', '', ''],
                ['', '', '', '', '', '', '', '', '(8) CHAIR-102 Seating', 'Meeting area', '', ''],
                ['2', 'Skid', '120', '60', '48', '1000', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Ship model display case', 'Custom built showcase', '', ''],
                ['', '', '', '', '', '', '', '', 'Marketing materials and brochures', 'Navy specs', '', '']
            ],
            'LOCKHEED MARTIN 2025 NGAUS MEETING ROOM': [
                ['Piece #', 'Type', 'L', 'W', 'H', 'Weight', 'Pack', 'Check', 'Description', 'Packing/shop notes', 'EditHistory', 'MetaData'],
                ['1', 'Skid', '96', '48', '48', '1000', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(8) CHAIR-102 Executive leather chairs', 'Conference seating', '', ''],
                ['', '', '', '', '', '', '', '', '(2) TABLE-001 Conference room tables', 'Black 30 x 76 x 30 - can link together', '', ''],
                ['2', 'Box', '36', '36', '24', '150', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', 'TV-065 65" Display monitor with mount', 'For presentations', '', ''],
                ['', '', '', '', '', '', '', '', 'AV equipment and cables', 'HDMI, power strips', '', ''],
                ['3', 'Crate', '48', '48', '48', '300', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(1) CAB-004 Storage cabinet', 'For supplies', '', ''],
                ['', '', '', '', '', '', '', '', 'LIGHT-055 LED lighting kit', 'Room lighting', '', ''],
                ['', '', '', '', '', '', '', '', '(4) PANEL-210 Room divider panels', 'Create enclosed meeting space', '', '']
            ],
            'GEARFIRE 2025 SHOT': [
                ['Piece #', 'Type', 'L', 'W', 'H', 'Weight', 'Pack', 'Check', 'Description', 'Packing/shop notes', 'EditHistory', 'MetaData'],
                ['1', 'Skid', '72', '32', '48', '800', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(1) straight-section reception counter (one of two sections). Test lighting', 'Sintra logo- last CES 2025', '', ''],
                ['', '', '', '', '', '', '', '', 'Client junk', '', '', ''],
                ['2', 'Skid', '120', '48', '48', '1200', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(3) rolls 10\'x70\' SLATE gray carpeting', '', '', ''],
                ['3', 'Skid', '120', '48', '48', '600', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Padding for 30x70', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Padding For Triveni', 'Booth # W3067', '', ''],
                ['4', 'Crate', '72', '48', '48', '800', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(4) CAB-004 Curved-bottom white demo counter with 30" wide top and LED lighting. (4) standoffs on front and top. Test LED lights', '', '', ''],
                ['', '', '', '', '', '', '', '', 'SEG\'s', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Blank SEG\'s', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Client Packages', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Front office items and other inbound client items', '', '', ''],
                ['', '', '', '', '', '', '', '', 'All Sintra/foamcore signs', 'New from Olympus', '', ''],
                ['', '', '', '', '', '', '', '', 'Set top graphics (paper or foamcore)', 'New from Olympus', '', ''],
                ['', '', '', '', '', '', '', '', 'Package (all) cardboard easelbacks prints', 'Office', '', ''],
                ['', '', '', '', '', '', '', '', '5" carboard easelbacks packet', 'Inbound purchase', '', ''],
                ['', '', '', '', '', '', '', '', '(6) Acrylic wedge blocks/frames 3"x10"', 'Office. Add new prints prior to packing', '', ''],
                ['5', 'Crate', '72', '48', '48', '800', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(4) CAB-004 Curved-bottom white demo counter with 30" wide top and LED lighting. (4) standoffs on front and top. Test LED lights', '', '', ''],
                ['', '', '', '', '', '', '', '', 'TEJAS ITEMS- AS RECEIVED', '', '', ''],
                ['6', 'Crate', '72', '48', '48', '800', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(3) CAB-004 Curved-bottom white demo counter with 30" wide top and LED lighting. (4) standoffs on front and top. Test LED lights', '', '', ''],
                ['7', 'Coffin Crate', '', '', '', '', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', 'On Top: Hanging sign frame 18\'x18\'x5\'', '32 horizontal members; 4 corner posts (54") 12 spreaders (54"+); 8 corner blocks, eye bolts and connectors', '', ''],
                ['', '', '', '', '', '', '', '', 'On Top: Hangiing sign fabric cover- ATSC', 'Last- CES 2025', '', ''],
                ['', '', '', '', '', '', '', '', 'Sintra prints- all elevations', 'New from Olympus', '', ''],
                ['', '', '', '', '', '', '', '', 'Sintra prints existing', 'From CES/NAB', '', ''],
                ['', '', '', '', '', '', '', '', 'BeMatrix H/W', '', '', ''],
                ['', '', '', '', '', '', '', '', '(10) extra blocking boards for 992 frames', 'Not on BeMatrix pick list', '', ''],
                ['', '', '', '', '', '', '', '', '(24) extra metal drop in brackets', 'Not on BeMatrix pick list', '', ''],
                ['', '', '', '', '', '', '', '', '(1) Yamaha powered speakers with cords', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Corded microphone kit', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Wireless presenter\'s kit', '', '', ''],
                ['', '', '', '', '', '', '', '', 'White demo counter top @ 48" wide x 20" deep', '3/4"; cut down from a larger oversized top. Drill holes for standoffs for demo cabinet', '', ''],
                ['', '', '', '', '', '', '', '', 'Grey countertop with existing grommet caps (black) all in place and taped down', 'Last-CES. Verify size vs. drawing', '', ''],
                ['', '', '', '', '', '', '', '', '(2) white counter sections @ 95"x18" for hospitality bar', '', '', ''],
                ['', '', '', '', '', '', '', '', '(16) heavy L brackets for shelf supports', 'Packed with Hardware', '', ''],
                ['', '', '', '', '', '', '', '', '8.5x11 lit acrylic lit pockets (6)', 'Clean/matching', '', ''],
                ['', '', '', '', '', '', '', '', '(6) 19" TV\'s with small mount kits', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Square glass cocktail table kit', '', '', ''],
                ['', '', '', '', '', '', '', '', '(1) laminated riser from MOJO SHOT show', '30"x30"x12"', '', ''],
                ['', '', '', '', '', '', '', '', '(2) 55" Samsung TV screen', 'Top Shelf rentals', '', ''],
                ['', '', '', '', '', '', '', '', 'Power cord', '', '', '']
            ],
            // Test pack list with new item code formats
            'TEST 2025 ENHANCED': [
                ['Piece #', 'Type', 'L', 'W', 'H', 'Weight', 'Pack', 'Check', 'Description', 'Packing/shop\nnotes', 'EditHistory', 'MetaData'],
                ['1', 'Crate', '72', '48', '48', '400', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(2) TABLE-001 Conference tables', 'Standard items', '', ''],
                ['', '', '', '', '', '', '', '', '(5) CHAIR-002 Lounge chairs', '', '', ''],
                ['', '', '', '', '', '', '', '', 'STOOL-001 Bar stool', '', '', ''],
                ['2', 'Crate', '96', '48', '12', '200', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(3) BX-16x39 Standard rectangular panels', 'Pack flat, protect edges', '', ''],
                ['', '', '', '', '', '', '', '', '(2) BX-16x47 Large rectangular panels', '', '', ''],
                ['', '', '', '', '', '', '', '', 'BX-○39 Circular panel 39" diameter', '', '', ''],
                ['', '', '', '', '', '', '', '', '(2) BX-3Rx8_45° Curved panels with 45° angle', '', '', ''],
                ['', '', '', '', '', '', '', '', '(4) VU-8x39 VUE brand panels', '', '', ''],
                ['3', 'Box', '24', '18', '12', '50', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(10) 901 00 030 MKII Mounting brackets', 'Hardware kit', '', ''],
                ['', '', '', '', '', '', '', '', '(20) 901 28 0341 E E-series connectors', '', '', ''],
                ['', '', '', '', '', '', '', '', '(50) 615 11 01 ANO Anodized fasteners', 'Bulk item', '', ''],
                ['', '', '', '', '', '', '', '', '(5) 250 05 50 LED - LED50WW LED strips', 'Fragile electronics', '', ''],
                ['4', 'Box', '18', '12', '8', '15', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(3) VUE-V2C-LP Low profile connectors', 'Small parts', '', ''],
                ['', '', '', '', '', '', '', '', '(2) LED-EXL21-SL LED controllers', 'Electronics', '', ''],
                ['5', 'Box', '36', '24', '18', '80', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(25) HH BOLTHOG M8 LONG Long bolts', 'Hardware kit', '', ''],
                ['', '', '', '', '', '', '', '', '(15) HH BOLTHOG 1-4 20 x 2.5 Small bolts', '', '', ''],
                ['', '', '', '', '', '', '', '', '(8) HH BRACKET UPPER 62 Mounting brackets', '', '', ''],
                ['6', 'Crate', '60', '40', '40', '300', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', 'Mixed items: (2) BX-16x39, TABLE-001, (5) 901 00 030 MKII', 'Multiple item types', '', ''],
                ['', '', '', '', '', '', '', '', 'Also includes: VU-8x39 and (3) CHAIR-002', '', '', '']
            ],
            // Multi-booth test: primary packlist (natural match), CHAIR-001=5
            // Expected combined: CHAIR-001=7 (5+2), STOOL-002=4 (secondary only)
            'MULTIBOOTHCO 2026 MULTI BOOTH': [
                ['Piece #', 'Type', 'L', 'W', 'H', 'Weight', 'Pack', 'Check', 'Description', 'Packing/shop notes', 'EditHistory', 'MetaData'],
                ['1', 'Crate', '48', '48', '48', '200', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(5) CHAIR-001 stack chair', '', '', '']
            ],
            // Multi-booth test: secondary packlist (NameOverride-linked), CHAIR-001=2, STOOL-002=4
            'MULTI BOOTH SECONDARY PACKLIST': [
                ['Piece #', 'Type', 'L', 'W', 'H', 'Weight', 'Pack', 'Check', 'Description', 'Packing/shop notes', 'EditHistory', 'MetaData'],
                ['1', 'Crate', '48', '48', '48', '200', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(2) CHAIR-001 stack chair', '', '', ''],
                ['', '', '', '', '', '', '', '', '(4) STOOL-002 square stool', '', '', '']
            ],
            // Two-show transship chain: source ships TABLE-001 qty 2 and CHAIR-002 qty 5
            // Chain max: TABLE-001=3 (from SUMMER SHOW), CHAIR-002=5 (from SPRING EXPO)
            'CHAINCO 2026 SPRING EXPO': [
                ['Piece #', 'Type', 'L', 'W', 'H', 'Weight', 'Pack', 'Check', 'Description', 'Packing/shop notes', 'EditHistory', 'MetaData'],
                ['1', 'Crate', '48', '48', '48', '200', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(2) TABLE-001 conference table', '', '', ''],
                ['', '', '', '', '', '', '', '', '(5) CHAIR-002 lounge chair', '', '', '']
            ],
            // Destination show has higher TABLE-001 qty — chain max should use this value
            'CHAINCO 2026 SUMMER SHOW': [
                ['Piece #', 'Type', 'L', 'W', 'H', 'Weight', 'Pack', 'Check', 'Description', 'Packing/shop notes', 'EditHistory', 'MetaData'],
                ['1', 'Crate', '48', '48', '48', '200', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(3) TABLE-001 conference table', '', '', ''],
                ['', '', '', '', '', '', '', '', '(4) CHAIR-002 lounge chair', '', '', '']
            ],
            // Three-show chain: chain max should be STOOL-001=4 (Stage B), COUCH-001=2 (Stage B)
            'TRICHAIN 2026 STAGE A': [
                ['Piece #', 'Type', 'L', 'W', 'H', 'Weight', 'Pack', 'Check', 'Description', 'Packing/shop notes', 'EditHistory', 'MetaData'],
                ['1', 'Crate', '48', '48', '48', '200', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(2) STOOL-001 bar stool', '', '', ''],
                ['', '', '', '', '', '', '', '', '(1) COUCH-001 white leather sofa', '', '', '']
            ],
            'TRICHAIN 2026 STAGE B': [
                ['Piece #', 'Type', 'L', 'W', 'H', 'Weight', 'Pack', 'Check', 'Description', 'Packing/shop notes', 'EditHistory', 'MetaData'],
                ['1', 'Crate', '48', '48', '48', '200', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(4) STOOL-001 bar stool', '', '', ''],
                ['', '', '', '', '', '', '', '', '(2) COUCH-001 white leather sofa', '', '', '']
            ],
            'TRICHAIN 2026 STAGE C': [
                ['Piece #', 'Type', 'L', 'W', 'H', 'Weight', 'Pack', 'Check', 'Description', 'Packing/shop notes', 'EditHistory', 'MetaData'],
                ['1', 'Crate', '48', '48', '48', '200', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(3) STOOL-001 bar stool', '', '', ''],
                ['', '', '', '', '', '', '', '', '(1) COUCH-001 white leather sofa', '', '', '']
            ],
            // Overlaps CHAINCO SPRING EXPO's date window — used to test conflict detection skips SUMMER SHOW (destination)
            'OVERLAPCO 2026 OVERLAP TEST': [
                ['Piece #', 'Type', 'L', 'W', 'H', 'Weight', 'Pack', 'Check', 'Description', 'Packing/shop notes', 'EditHistory', 'MetaData'],
                ['1', 'Crate', '48', '48', '48', '100', '', '', '', '', '', ''],
                ['', '', '', '', '', '', '', '', '(1) TABLE-001 conference table', '', '', '']
            ]
        },
        'PROD_SCHED': {
            'Production Schedule': [
                // Headers with embedded carriage returns to simulate real Google Sheets data quality issues
                ['Show', 'Client', 'Year', 'Identifier', 'City', 'Size', 'Booth#', 'S. Start', 'S. End', 'Ship', 'Ship BKD', 'O/B\nBKD', 'MHA Done', 'Blobs done', 'Recieved', 'GC', 'Sup', 'Sup Badge\nReq.', 'Pack List', 'PL to OPS', 'SOW Sent', 'SOW Ret', 'Elev', 'Panels', 'Setups', 'ER to OPG', 'GD DUE', 'GP DUE', '3rd Party Auth', 'I&D', 'S/U to\nElite', 'MH', 'Elec', 'Elec and Net\ndwg sent', 'H/S', 'H/S dwg sent', 'Net', 'Oth', 'EAC', 'COI', 'DWG (H/S-ELEC)\nTO SHOW BY', 'S/U IN SHOP', 'S. Install', 'S. Dismantle'],
                ['SHOT Show', 'Allen Arms', '2025', 'ALLEN ARMS 2025 SHOT', 'Las Vegas, NV', '10x40 & 10x10', '75323 & 75324', '21-Jan', '24-Jan', '1/13/2025', 'X', 'X', 'X', '', '2/3', 'Freeman', 'Top Shelf', '', 'X', 'X', 'X', 'X', 'X', 'X', 'X', '', 'in', '1/10', 'X', 'X', '', 'X', 'X', '', '', '', '', '', 'X', 'X', '10-Dec', ''],
                ['SHOT Show', 'MOJO', '2025', 'MOJO 2025 SHOT', 'Las Vegas, NV', '30x30', '10518', '21-Jan', '24-Jan', '1/10/2025', 'X', 'X', 'X', '', '1/31', 'Freeman', 'Top Shelf', '', 'X', 'X', 'X', 'X', '', '', 'X', '', '', 'X', 'X', '', 'X', 'X', '', 'X', '', '', 'X', '', '', '10-Dec', ''],
                ['SHOT Show', 'Gearfire', '2025', 'GEARFIRE 2025 SHOT', 'Las Vegas, NV', '20x30', '11255', '21-Jan', '24-Jan', '1/10/2025', 'X', 'X', 'X', '', '1/31', 'Freeman', 'Top Shelf', '', 'X', 'X', 'X', 'X', '-', '-', 'X', '', '12/13', '1/9', 'X', 'X', '', 'X', 'X', '', 'N/a', '', '', '', 'X', 'X', '10-Dec', ''],
                ['NAB', 'ATSC', '2025', 'ATSC 2025 NAB', 'Las Vegas, NV', '20x30', '11255', '21-Jan', '24-Jan', '1/10/2025', 'X', 'X', 'X', '', '1/31', 'Freeman', 'Top Shelf', '', 'X', 'X', 'X', 'X', '-', '-', 'X', '', '12/13', '1/9', 'X', 'X', '', 'X', 'X', '', 'N/a', '', '', '', 'X', 'X', '10-Dec', ''],
                ['Enhanced Test', 'Test Client', '2025', 'TEST 2025 ENHANCED', 'Test City', '20x20', '999', '5-Nov', '8-Nov', '11/4/2025', 'X', 'X', 'X', '', '11/10', 'Test GC', 'Top Shelf', '', 'X', 'X', 'X', 'X', 'X', 'X', 'X', '', '10/20', '11/1', 'X', 'X', '', 'X', 'X', '', 'X', '', '', '', 'X', 'X', '1-Nov', 'X'],
                ['NADA', 'AWN', '2025', 'AWNINC 2025 NADA', 'New Orleans', '20x20', '3363', '24-Jan', '26-Jan', '1/7/2024', 'X', 'X', 'X', '', '1/28', 'Freeman', 'ELITE', '', 'X', 'X', 'X', 'X', '', '', 'X', '', 'in', 'done', 'X', 'X', '', 'X', 'X', '', 'X', '', '', '', 'X', 'X', '', ''],
                ['SLAS', 'BitBio', '2025', 'BITBIO 2025 SLAS', 'San Diego, CA', '20x20', '349', '26-Jan', '30-Jan', '1/9/2024', 'X', 'X', 'X', '', '2/17', 'Freeman', 'WW', '', 'X', 'X', 'X', 'X', '', '', 'X', '', '12/20', '1/8', 'X', 'X', '', 'X', 'X', '', 'N/a', '', '', '', 'X', 'X', '16-Dec', ''],
                ['Surfaces (TISE)', 'Cyncly', '2025', 'CYNCLY 2025 SURFACES', 'Las Vegas, NV', '40x60', '2057', '28-Jan', '30-Jan', '1/22/2025', 'X', 'X', 'X', '', '2/4', 'Freeman', 'Brian', '', 'X', 'X', 'X', 'X', 'X', 'X', 'X', '', '12/20', '1/20', 'X', 'X', '', 'X', 'X', '', 'X', '', '', '', '', '', '16-Dec', 'X'],
                ['SIO', 'Guerbet', '2025', 'GUERBET 2025 SIO', 'Las Vegas, NV', '10x20', '112', '31-Jan', '2-Feb', '12/16', 'X', 'X', 'X', '', '2/10', 'Freeman', 'Brian', '', 'X', 'X', 'X', 'X', '', '', '-', '', '1/6', '', 'X', 'X', '', '', 'X', '', '', '', '', '', 'X', 'X', '', ''],
                ['ASA', 'QGenda', '2025', 'QGENDA 2025 ASA', 'Atlanta', '10x20', '207', '31-Jan', '2-Feb', '1/22/2024', 'X', 'X', 'X', '', '2/3', 'Freeman', 'ELITE', '', 'X', 'X', 'X', '', '', 'X', '', '1/10', '', 'X', 'X', '', '', 'X', '', '', '', '', '', 'X', 'X', '', ''],
                ['SCOPE', 'BestBuy Health', '2025', 'BESTBUY HEALTH 2025 SCOPE', 'Orlando, FL', '10x10', '429', '3-Feb', '5-Feb', '2/3/2025', 'X', 'X', 'X', '2/6', '2/6', 'Maxum', 'Top Shelf', '', 'X', 'X', 'X', 'X', '', '', 'X', '', '', 'X', 'X', '', 'X', 'X', '', '', '', '', '', 'X', '', '', ''],
                ['SCOPE', 'Deep6', '2025', 'DEEP6 2025 SCOPE', 'Orlando, FL', '10x20', '1121', '3-Feb', '5-Feb', '2/3/2025', 'N/A', 'N/A', 'X', '', 'x', 'Maxum', '', '', 'X', 'X', 'X', 'X', '', '', '-', '', '', 'X', 'X', '', 'X', 'X', '', '', '', '', '', 'X', '', '22-Dec', ''],
                ['MDM-West', 'Dymax', '2025', 'DYMAX 2025 MDM-WEST', 'Anaheim, CA', '20x30', '2101', '4-Feb', '7-Feb', '1/17/2025', 'X', 'X', 'X', '', '2/17', 'Freeman', 'ELITE', '', 'X', 'X', 'X', 'X', '', '', 'X', '', '12/1', '', 'X', 'X', '', '', 'X', '', '', '', '', '', 'X', 'X', '24-Dec', ''],
                ['TANDEM', 'BestBuy Health', '2025', 'BESTBUY HEALTH 2025 TANDEM', 'Honolulu, HI', '10x10', '633', '12-Feb', '15-Feb', '1/10', 'X', 'X', 'X', '', '', 'Freeman', 'GC', '', 'X', 'X', 'X', 'X', '', '', '-', '', '', 'X', '', '', 'X', '', '', '', '', '', 'X', '', '', '', ''],
                ['RISE MMS', 'BestBuy Health', '2025', 'BESTBUY HEALTH 2025 RISE MMS', 'San Juan, PR', '10x10', '', '24-Feb', '26-Feb', '2/10/2025', 'X', 'X', 'X', '', '3/5', 'IMS', 'Local', '', 'X', 'X', 'X', 'X', '', '', 'X', '', '', 'X', '', '', 'X', '', '', '', '', '', '', '', '', '', ''],
                ['eTail West', 'Monetate', '2025', 'MONETATE 2025 ETAIL WEST', 'Palm Springs, CA', '10x10', '614', '24-Feb', '27-Feb', '2/10', 'X', 'X', 'X', '', '3/10', 'Alliance', 'ELITE', '', 'X', 'X', 'X', 'X', '', '', 'X', '', '2/3', '', '', 'X', '', '', 'X', 'X', '', '', '', 'X', '', '', '13-Jan', ''],
                ['KBIS', 'Cyncly', '2025', 'CYNCLY 2025 KBIS', 'Las Vegas', '20x50', 'N2013', '25-Feb', '27-Feb', '2/14/2025', 'X', 'X', 'X', '', '3/5', 'Freeman', 'Brian', '', 'X', 'X', 'X', '', 'X', 'X', 'X', '', '1/10', '2/12', 'X', 'X', '', 'X', 'X', 'X', 'X', 'X', 'X', '', 'X', 'X', '13-Jan', ''],
                ['NAFEM', 'Marmon', '2025', 'MARMON 2025 NAFEM', 'Atlanta, GA', '30x30', '5754', '26-Feb', '28-Feb', '2/21/2025', 'X', 'X', 'X', '', '3/3', 'Freeman', 'Ben', '', 'X', 'X', 'X', 'X', 'X', 'X', 'X', '', '2/1', '', 'X', 'X', '', 'X', 'X', '', 'X', '', '', 'X', 'X', 'X', '14-Jan', ''],
                ['HIMSS', 'Codametrix', '2024', 'CODAMETRIX 2025 HIMSS', 'Las Vegas, NV', '20x20', '4657', '4-Mar', '6-Mar', '2/25/2024', 'X', 'X', 'X', '', '3/11', 'Freeman', 'Brian', '', 'X', 'X', 'X', 'X', '', '', 'X', '', '', 'X', 'X', '', 'X', 'X', 'X', 'X', 'X', '', 'X', '', '', '', ''],
                ['HIMSS', 'Harmony Health', '2024', 'HARMONY HEALTH 2025 HIMSS', 'Las Vegas, NV', '10x20', '2748', '4-Mar', '6-Mar', '2/25/2024', 'X', 'X', 'X', '', '3/11', 'Freeman', 'Brian', '', 'X', 'X', 'X', 'X', '', '', 'X', '', '2/7', '2/23', 'X', 'X', '', 'X', 'X', '', '', '', '', '', 'X', '', '', ''],
                ['HIMSS', 'QGenda', '2024', 'QGENDA 2025 HIMSS', 'Las Vegas, NV', '20x20', '5222', '4-Mar', '6-Mar', '2/25/2024', 'X', 'X', 'X', '', '3/11', 'Freeman', 'Brian', '', 'X', 'X', 'X', '', '', 'X', 'X', '', '2/1', '2/20', 'X', 'X', '', 'X', 'X', 'X', 'X', 'X', 'X', '', 'X', '', '', ''],
                // QGenda has a second booth at HIMSS - both rows visible in schedule, can be deduplicated for overlap calculations
                ['HIMSS', 'QGenda', '2024', 'QGENDA 2025 HIMSS', 'Las Vegas, NV', '10x10', '5223', '4-Mar', '6-Mar', '2/25/2024', 'X', 'X', 'X', '', '3/11', 'Freeman', 'Brian', '', 'X', 'X', 'X', '', '', 'X', 'X', '', '2/1', '2/20', 'X', 'X', '', 'X', 'X', 'X', 'X', 'X', 'X', '', 'X', '', '', ''],
                ['SIA Forum', 'Tracker', '2024', 'TRACKER 2025 SIA FORUM', 'Miami Beach', '10x10', '412', '10-Mar', '13-Mar', '3/5/2024', 'X', 'N/A', 'X', '', '3/19', 'GES', 'ELITE', '', 'X', 'X', 'X', 'X', '', '', 'X', '', '', 'X', 'X', '', '', 'X', '', '', '', '', '', 'X', 'X', '', ''],
                ['IPC APEX (OSC)', 'Dymax', '2024', 'DYMAX 2025 IPC APEX OSC', 'Anaheim, CA', '10x10', '2305', '29-Dec', '30-Dec', '12/12/2025', 'X', 'X', 'X', '', '3/31', 'Shepard', 'Client', '', 'N/A', 'N/A', 'X', 'X', '', '', '-', '', '2/7', '', 'X', '', '', '', 'X', '', '', '', 'X', 'N/a', '', '', '', ''],
                ['D2P', 'Dymax (ECT)', '2025', 'DYMAX 2025 D2P', 'Orlando, FL', '10x10', '418', '11-Mar', '12-Mar', '3/6/2025', 'X', 'X', 'X', '', '3/7', '', '', '', 'N/A', 'N/A', 'N/A', 'N/A', '', '', '-', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
                ['RISE National', 'BestBuy Health', '2025', 'BESTBUY HEALTH 2025 RISE NATIONAL', 'San Antonio, TX', '10x10', '816', '12-Mar', '14-Mar', '3/7/2025', 'X', 'X', '', '', '3/17', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
                ['MHA', 'Softwriters', '2025', 'SOFTWRITERS 2025 MHA', 'Orlando, FL', '20x20', '519', '17-Mar', '18-Mar', '3/10/2025', 'X', 'X', '', '', '3/20', 'Heritage', 'Top Shelf', '', 'X', 'X', 'X', 'X', '', '', 'X', '', '2/28', '', 'X', 'X', '', '', 'X', '', 'N/a', '', '', '', '', '', '', ''],
                ['ShopTalk', 'Tulip', '2025', 'TULIP 2025 SHOPTALK', 'Las Vegas, NV', '10x10', '752', '25-Mar', '27-Mar', '3/19/2025', 'X', 'X', '', '', '3/31', 'Freeman', 'Brian', '', 'X', 'X', 'X', '', '', 'X', '', '3/1', '3/13', '', 'X', '', '', 'X', '-', 'N/a', '-', '-', '', 'X', 'X', '11-Feb', ''],
                ['ShopTalk', 'Kibo', '2025', 'KIBO 2025 SHOPTALK', 'Las Vegas, NV', '10x20', '2156', '25-Mar', '27-Mar', '3/19/2025', 'X', 'X', '', '', '3/31', 'Freeman', 'Brian', '', 'X', 'X', 'X', '', 'X', 'X', 'X', '', '3/1', '3/17', '', 'X', '', '', 'X', '-', 'N/a', '-', 'X', '', 'X', 'X', '11-Feb', 'X']
                // --- Appended new rows from user ---
                // Test case: Lockheed Martin NGAUS has 3 packlists (main + VIP LOUNGE + MEETING ROOM suffix variants)
                // Demonstrates findAllPackListTabsForShow() correctly aggregating items across multiple tabs
                ,['NGAUS','Lockheed Martin','2025','LOCKHEED MARTIN 2025 NGAUS', 'Milwaukee, WI','30x40','515','8/23','8/25','8/20/2025','X','X','X','','','Shepard','Ben','','X','X','X','X','','','','8/19/2025','','7/12','8/6','','X','','X','X','X','X','n/a','n/a','X','X','']
                // Test case: QGenda has TWO booths at HIMSS (duplicate schedule entries with same Show/Client/Year)
                ,['HIMSS','QGenda','2025','QGENDA 2025 HIMSS', 'Las Vegas, NV','20x30','1234','9/7','9/10','9/2/2025','X','X','X','','9/15/2025','Freeman','Brian','','X','X','X','X','','','','9/1/2025','','8/1','8/20','','X','','X','X','X','X','n/a','n/a','X','X','']
                ,['HIMSS','QGenda','2025','QGENDA 2025 HIMSS', 'Las Vegas, NV','10x20','5678','9/7','9/10','9/2/2025','X','X','X','','9/15/2025','Freeman','Brian','','X','X','X','X','','','','9/1/2025','','8/1','8/20','','X','','X','X','X','X','n/a','n/a','X','X','']
                // Test case: "Test Client" is intentionally absent from the client index.
                // Identifier column is left blank so computeIdentifier is used, which falls back
                // to the raw client name — matching the packlist tab "TEST CLIENT 2025 HIMSS".
                ,['HIMSS', 'Test Client', '2025', '', 'Las Vegas, NV', '10x10', '5223', '4-Sep', '6-Sep', '9/2/2025', 'X', 'X', 'X', '', '10/11', 'Freeman', 'Brian', '', 'X', 'X', 'X', '', '', 'X', 'X', '', '2/1', '2/20', 'X', 'X', '', 'X', 'X', 'X', 'X', 'X', 'X', '', 'X', '', '', '']
                // Test case: Austal cross-year matching (should prefer 2026 over 2023 despite similar names)
                ,['Workboat','Austal','2023','AUSTAL 2023 WORKBOAT', 'New Orleans, LA','10x10','123','12/5','12/8','11/28/2023','X','X','X','','12/15/2023','Freeman','Top Shelf','','X','X','X','X','','','','11/25/2023','','11/1','11/20','','X','','X','X','','','n/a','n/a','X','X','']
                ,['Surface Navy','Austal USA','2026','AUSTAL USA 2026 SURFACE NAVY', 'San Diego, CA','20x30','789','5/15','5/18','5/8/2026','X','X','X','','5/25/2026','Freeman','Top Shelf','','X','X','X','X','','','','5/1/2026','','4/15','5/5','','X','','X','X','X','X','n/a','n/a','X','X','']
                ,['EPIC UGM','Microsoft','2025','', 'Verona, WI','10x10','N/A','8/18','8/21','8/12/2025','','','','','VIPER','VIPER','','X','X','X','X','','','','8/1','','','V','n/a','','','','','','','','','','']
                ,['EPIC UGM','Codametrix','2025','', 'Verona, WI','10x10','N/A','8/18','8/21','8/12/2025','','','','','VIPER','VIPER','','X','X','','','','8/1','','','V','n/a','','','','','','','','','','']
                ,['Showroom','ASP','2025','', 'Irvine, CA','30x30','N/A','8/25','N/A','8/24/2025','','','','','','','','X','X','','','','','','','','n/a','','','','','','','','','','']
                ,['CAALA','Steno','2025','', 'Las Vegas, NV','10x20','115','8/28','8/31','8/23/2025','','','','','Freeman','ELITE','','X','X','X','','','','X','','X','','','','','','','','','','']
                ,['ACEP','QGenda','2025','', 'Salt Lake City','10x20','1234','9/7','9/10','9/2/2025','','','','','Freeman','Brian','','','X','X','','9/1/2025','','8/19','','X','','','','','','','','','','']
                ,['Oracle Infocus','F365/NextGen','2025','', 'Denver, CO','10x10','','9/9','9/13','8/18/2025','','','','','GES','Client','','X','','X','X','','8/17/2025','','','','','','','','','','','','']
                ,['Burger King NA','Marmon','2025','', 'Phoenix, AZ','20x20','709','9/10','9/12','9/5/2025','','','','','Freeman','Brian','','','','','9/4/2025','','','','X','','','','','','','','','','']
                ,['BPI','Beckman-Coulter','2025','', 'Boston, MA','20x20','119','9/15','9/18','9/5/2025','','','','','Brian','','3','X','','8/13','','','','','','','','','','','','','','']
                ,['User Conference','Softwriters','2025','', 'San Diego, CA','20x30','N/A','9/15','9/17','9/2/2025','','','','','Alliance','ELITE','','X','X','X','','9/1/2025','','8/1','','','','','','','','','','']
                ,['HR Tech','PayActiv','2025','', 'Las Vegas','10x20','6708','9/16','9/18','9/2/2025','','','','','The Expo Gp','ELITE','','','','9/1/2025','','','','','','','','','','','','','','']
                ,['ASNE FMMS','Austal','2025','', 'San Diego, CA','10x10','','9/23','9/25','','','','','','','','X','','','','','','','','','','','','','','','','','','']
                // Multi-booth test: single schedule row, two packlists linked via natural match + NameOverride
                // Expected chain items: CHAIR-001=7 (5+2 summed), STOOL-002=4 (secondary tab only)
                ,['Multi Booth', 'MultiBoothCo', '2026', 'MULTIBOOTHCO 2026 MULTI BOOTH', 'Las Vegas, NV', '20x30', '1111 & 2222', '10/15', '10/18', '10/10/2026', 'X', 'X', 'X', '10/25/2026', '', 'Freeman', 'Top Shelf', '', 'X', 'X', 'X', 'X', '', '', 'X', '', '', '', 'X', 'X', '', '', 'X', '', '', '', '', '', 'X', 'X', '', '']
                // Multi-booth test: single schedule row, two packlists linked via natural match + NameOverride
                // Expected combined items: CHAIR-001=7 (5+2 summed), STOOL-002=4 (secondary tab only)
                ,['Multi Booth', 'MultiBoothCo', '2026', 'MULTIBOOTHCO 2026 MULTI BOOTH', 'Las Vegas, NV', '20x30', '1111 & 2222', '10/15', '10/18', '10/10/2026', 'X', 'X', 'X', '10/25/2026', '', 'Freeman', 'Top Shelf', '', 'X', 'X', 'X', 'X', '', '', 'X', '', '', '', 'X', 'X', '', '', 'X', '', '', '', '', '', 'X', 'X', '', '']
                // --- Test data for transship chain pathways ---
                // Two-show chain: SPRING EXPO ships first, SUMMER SHOW receives items (no Ship date)
                ,['Spring Expo', 'ChainCo', '2026', 'CHAINCO 2026 SPRING EXPO', 'Chicago, IL', '20x20', '1500', '3/8', '3/11', '3/1/2026', 'X', 'X', 'X', '3/18/2026', '', 'Freeman', 'Top Shelf', '', 'X', 'X', 'X', 'X', '', '', 'X', '', '', '', 'X', 'X', '', '', 'X', '', '', '', '', '', 'X', 'X', '', '']
                ,['Summer Show', 'ChainCo', '2026', 'CHAINCO 2026 SUMMER SHOW', 'Las Vegas, NV', '20x20', '2500', '6/1', '6/4', '', '', '', '', '6/11/2026', '', 'Freeman', 'Top Shelf', '', 'X', 'X', 'X', 'X', '', '', 'X', '', '', '', 'X', 'X', '', '', 'X', '', '', '', '', '', 'X', 'X', '', '']
                // Three-show chain: STAGE A → STAGE B → STAGE C, each transshipping to the next
                ,['Stage A', 'TriChain', '2026', 'TRICHAIN 2026 STAGE A', 'Dallas, TX', '10x20', '3500', '4/7', '4/10', '4/1/2026', 'X', 'X', 'X', '4/14/2026', '', 'Freeman', 'Top Shelf', '', 'X', 'X', 'X', 'X', '', '', 'X', '', '', '', 'X', 'X', '', '', '', '', '', '', '', '', 'X', 'X', '', '']
                ,['Stage B', 'TriChain', '2026', 'TRICHAIN 2026 STAGE B', 'Phoenix, AZ', '10x20', '4500', '5/5', '5/8', '', '', '', '', '5/12/2026', '', 'Freeman', 'Top Shelf', '', 'X', 'X', 'X', 'X', '', '', 'X', '', '', '', 'X', 'X', '', '', '', '', '', '', '', '', 'X', 'X', '', '']
                ,['Stage C', 'TriChain', '2026', 'TRICHAIN 2026 STAGE C', 'Denver, CO', '10x20', '5500', '6/9', '6/12', '', '', '', '', '6/16/2026', '', 'Freeman', 'Top Shelf', '', 'X', 'X', 'X', 'X', '', '', 'X', '', '', '', 'X', 'X', '', '', '', '', '', '', '', '', 'X', 'X', '', '']
                // Overlaps SPRING EXPO's date window — conflict detection should return SPRING EXPO (chain root), not SUMMER SHOW (destination)
                ,['Overlap Test', 'OverlapCo', '2026', 'OVERLAPCO 2026 OVERLAP TEST', 'Chicago, IL', '10x10', '6500', '3/8', '3/11', '3/3/2026', 'X', 'X', 'X', '3/18/2026', '', 'Freeman', 'Top Shelf', '', 'X', 'X', 'X', 'X', '', '', 'X', '', '', '', 'X', 'X', '', '', '', '', '', '', '', '', 'X', 'X', '', '']
                // --- Test data for Show Date filtering: Shows with dates crossing year boundaries ---
                // Early 2026 shows with 2025 ship dates (ship in Dec 2025, show in Jan 2026)
                ,['CES','TechCorp','2026','TECHCORP 2026 CES', 'Las Vegas, NV','20x30','1001','1/7','1/10','12/28/2025','X','X','X','','1/15/2026','Freeman','Top Shelf','','X','X','X','X','X','X','X','','12/1','12/20','X','X','','X','X','X','X','X','','','X','X','','']
                ,['Winter Summit','DataInc','2026','DATAINC 2026 WINTER SUMMIT', 'Denver, CO','10x20','2002','1/15','1/18','1/8/2026','X','X','X','','1/25/2026','Freeman','ELITE','','X','X','X','X','','','X','','12/20','1/5','X','X','','X','X','','','','','','X','X','','']
                ,['Early Bird Expo','BizSoft','2026','BIZSOFT 2026 EARLY BIRD EXPO', 'Chicago, IL','10x10','3003','1/20','1/22','1/13/2026','X','X','X','','1/30/2026','GES','Top Shelf','','X','X','X','X','','','X','','1/5','1/10','X','X','','','X','','','','','','X','X','','']
                // Late 2025 shows (Nov-Dec) to test year boundary
                ,['Holiday Tech','GadgetPro','2025','GADGETPRO 2025 HOLIDAY TECH', 'New York, NY','30x40','4004','12/10','12/13','12/3/2025','X','X','X','','12/20/2025','Freeman','Top Shelf','','X','X','X','X','X','X','X','','11/15','11/28','X','X','','X','X','X','X','X','','','X','X','','']
                ,['Year End Summit','CloudVentures','2025','CLOUDVENTURES 2025 YEAR END SUMMIT', 'San Francisco, CA','20x20','5005','12/15','12/18','12/8/2025','X','X','X','','12/23/2025','GES','ELITE','','X','X','X','X','','','X','','11/20','12/5','X','X','','X','X','','','','','','X','X','','']
                // Mid-2026 shows for complete year testing
                ,['Summer Tech','InnovateCo','2026','INNOVATECO 2026 SUMMER TECH', 'Austin, TX','20x30','6006','6/15','6/18','6/8/2026','X','X','X','','6/25/2026','Freeman','Top Shelf','','X','X','X','X','X','X','X','','5/15','6/5','X','X','','X','X','X','','','','','X','X','','']
                ,['Mid-Year Conference','SystemsInc','2026','SYSTEMSINC 2026 MID-YEAR CONFERENCE', 'Seattle, WA','10x20','7007','7/20','7/23','7/13/2026','X','X','X','','7/30/2026','GES','ELITE','','X','X','X','X','','','X','','6/20','7/10','X','X','','','X','','','','','','X','X','','']
                // Fall 2026 shows
                ,['Fall Expo','MegaTech','2026','MEGATECH 2026 FALL EXPO', 'Boston, MA','30x30','8008','10/5','10/8','9/28/2026','X','X','X','','10/15/2026','Freeman','Top Shelf','','X','X','X','X','X','X','X','','9/10','9/25','X','X','','X','X','X','X','','','','X','X','','']
                ,['Q4 Summit','ProSystems','2026','PROSYSTEMS 2026 Q4 SUMMIT', 'Miami, FL','20x20','9009','11/10','11/13','11/3/2026','X','X','X','','11/20/2026','GES','ELITE','','X','X','X','X','','','X','','10/15','11/1','X','X','','','X','','','','','','X','X','','']
                // Shows with ambiguous dates (no full date) - should use Year column for inference
                ,['Test Ambiguous Early','AmbiguousCo','2026','AMBIGUOUSCO 2026 TEST AMBIGUOUS EARLY', 'Las Vegas, NV','10x10','1111','1/5','1/8','12/29/2025','X','X','X','','1/15/2026','Freeman','Top Shelf','','X','X','X','X','','','X','','12/15','12/28','X','X','','','X','','','','','','X','X','','']
                ,['Test Ambiguous Late','LateShowInc','2025','LATESHOWINC 2025 TEST AMBIGUOUS LATE', 'Chicago, IL','10x10','2222','12/28','12/31','12/21/2025','X','X','X','','1/5/2026','GES','ELITE','','X','X','X','X','','','X','','12/10','12/20','X','X','','','X','','','','','','X','X','','']
            ]
        },
        'CACHE': {
            'UserData_test_example_com': [
                ['ID', 'Value'],
                ['dashboard_containers', '[{"path":"schedule","classes":"wide"},{"path":"inventory","classes":"tall"},{"path":"packlist","classes":"wide"}]']
            ],
            'Caching': [
                ['Key', 'Timestamp']
            ],
            // Persisted analytics (caching.js persistentMethods): one row per saved result
            'Analytics': [
                ['Key', 'SavedAt', 'Sources', 'Value']
            ],
            'Locks': [
                ['Lock Key', 'locked.user@example.com', 'another.user@example.com'], // Row 0: Headers with users
                ['PACK_LISTS:ATSC 2025 NAB', '2026-01-19T10:30:00.000Z', '0'], // Row 1+: Lock key rows with timestamps
                ['INVENTORY:CABINETS', '2026-01-19T10:30:00.000Z', '0'] // Row 2: Another lock key
            ],
            'Notes': [
                ['Path', 'Note', 'Color', 'Size', 'EditHistory']
            ],
            // Inventory proposals: "Spring buy" spans two categories, "Cabinet fix" targets the
            // locked CABINETS tab (commit must fail), "Fall buy" is committed (read-only)
            'InventoryProposals': [
                ['Proposal', 'Category', 'ItemNumber', 'Changes', 'UpdatedBy', 'Updated', 'CommittedBy', 'Committed'],
                ['Spring buy', 'FURNITURE', 'CHAIR-001', _json([{ n: 'quantity', ne: '+8' }]), 'sam', '17915000000', '', ''],
                ['Spring buy', 'FURNITURE', 'CHAIR-003', _json([{ n: 'quantity', ne: '+4' }, { n: 'notes', ne: 'order matching legs' }]), 'sam', '17915000000', '', ''],
                ['Spring buy', 'HANGING SIGNS', 'HS-001', _json([{ n: 'quantity', ne: '+2' }]), 'dan', '17915100000', '', ''],
                ['Cabinet fix', 'CABINETS', 'CAB-004', _json([{ n: 'quantity', ne: '-1' }]), 'dan', '17914000000', '', ''],
                ['Fall buy', 'FURNITURE', 'STOOL-001', _json([{ n: 'quantity', ne: '+4' }]), 'dan', '17880000000', 'dan', '17890000000']
            ],
            'NameOverrides': [
                ['Schedule', 'Packlist'],
                // sentinel row: ensures non-empty result so database:getData is cached and the invalidation chain can propagate
                ['_FAKE_OVERRIDE_SENTINEL', '_FAKE_PACK_SENTINEL'],
                // Multi-booth test: secondary packlist linked to the same schedule row via override
                ['MULTIBOOTHCO 2026 MULTI BOOTH', 'MULTI BOOTH SECONDARY PACKLIST']
            ],
            'ScheduleOverrides': [
                ['Schedule', 'Override'],
                // Two-show transship chain: SPRING EXPO → SUMMER SHOW
                ['CHAINCO 2026 SUMMER SHOW', 'CHAINCO 2026 SPRING EXPO'],
                // Three-show transship chain: STAGE A → STAGE B → STAGE C
                ['TRICHAIN 2026 STAGE B', 'TRICHAIN 2026 STAGE A'],
                ['TRICHAIN 2026 STAGE C', 'TRICHAIN 2026 STAGE B']
            ],
            'Links': [
                ['Path', 'ShortCode', 'Created'],
                ['schedule?{"dateFilters":[{"column":"Date","value":0,"type":"after"}]}', '1', '2026-01-19T10:30:00.000Z']
            ],
            'Inventory': [
                ['PREFIX', 'INVENTORY', 'FOLDER', 'MetaData'],
                ['CAB', 'CABINETS', '', ''],
                ['HS', 'HANGING SIGNS', '', ''],
                ['LB', 'LIGHTBOXES', '', ''],
                ['CNTR', 'COUNTERTOPS', '', ''],
                ['SHLF', 'SHELVES', '', ''],
                ['STOOL', 'FURNITURE', '', '{"suppressAnalysis":"true"}'],
                ['CHAIR', 'FURNITURE', 'CHAIRS', '{"suppressAnalysis":"true"}'],
                ['COUCH', 'FURNITURE', '', '{"suppressAnalysis":"true"}'],
                ['TABLE', 'FURNITURE', 'TABLES', '{"suppressAnalysis":"true"}'],
                ['TTOP', 'FURNITURE', '', '{"suppressAnalysis":"true"}'],
                ['TBASE', 'FURNITURE', '', '{"suppressAnalysis":"true"}'],
                ['BX', 'PANELS', '', ''],
                ['VU', 'PANELS', '', ''],
                ['ADD', 'ADDITIONS', '', '{"suppressAnalysis":"true","descriptionOnly":"true"}'],
                ['HARDWARE', 'HARDWARE', 'HARDWARE', '{"customItemNumbers":"true"}']
            ],
            'Thumbnails': [
                ['ItemNumber', 'File', 'Blob'],
                ['BX', 'file_id_bx_prefix'],
                ['CHAIR', 'file_id_chair_prefix'],
                ['CHAIR-001', 'file_id_chair_001'],
                ['CHAIR-002', 'file_id_chair_002'],
                ['TABLE', 'file_id_table_prefix'],
                ['TABLE-001', 'file_id_table_001']
            ],
            'Clients': [
                ['Clients', 'Abbreviations', 'Notes'],
                ['ABCAM', '', ''],
                ['AHLSTROM', '', ''],
                ['ALLEN ARMS', '', ''],
                ['AMENTUM', '', ''],
                ['ASP', '', ''],
                ['ATSC', '', ''],
                ['AUSTAL USA', 'AUSTAL', 'Primary name for Austal shipbuilding company'],
                ['AWNINC', 'AWN', ''],
                ['BECKMAN-COULTER', '', ''],
                ['BESTBUY HEALTH', 'BB HEALTH, BEST BUY', ''],
                ['BITBIO', '', ''],
                ['CARTA HEALTHCARE', '', ''],
                ['CERENCE', '', ''],
                ['CODAMETRIX', '', ''],
                ['CODEMETTLE', '', ''],
                ['CYNCLY', '', ''],
                ['DANAHER', '', ''],
                ['DAVIDSONS', '', ''],
                ['DEEP6', '', ''],
                ['DGS', '', ''],
                ['DYMAX', 'DYMAX ECT, DYMAX BOMAR', ''],
                ['E4', '', ''],
                ['ECOLAB', '', ''],
                ['ECS', '', ''],
                ['F365 NEXTGEN', '', ''],
                ['FIREMON', '', ''],
                ['FUNERAL365', '', ''],
                ['GEARFIRE', '', ''],
                ['GROUPERA', '', ''],
                ['GUERBET', '', ''],
                ['GUNSTORES', 'GUNSTORESCOM', ''],
                ['HARMONY HEALTH', '', ''],
                ['IMPERIAL CS', '', ''],
                ['INSIDER', '', ''],
                ['KIBO', '', ''],
                ['KYRUUS', '', ''],
                ['LEICA', '', ''],
                ['LOCKHEED MARTIN', '', ''],
                ['MARMON', '', ''],
                ['MARUKA USA', 'MARUKA', ''],
                ['MICROSOFT', '', ''],
                ['MOJO', 'MOJO OUTDOORS', ''],
                ['MONETATE', '', ''],
                ['MOZAIK', '', ''],
                ['NUANCE', '', ''],
                ['PACIFIC SOLUTIONS', '', ''],
                ['PAYACTIV', '', ''],
                ['PIXELFLEX', '', ''],
                ['PRECISION OT', 'PREC OT', ''],
                ['PRET', '', ''],
                ['QGENDA', '', ''],
                ['SERTIFI', '', ''],
                ['SOAR TECH', '', ''],
                ['SOFTWRITERS', '', ''],
                ['STANLEY SPORTS', '', ''],
                ['STENO', '', ''],
                ['SWISHER', '', ''],
                ['TITAN TV', '', ''],
                ['TRACKER', '', ''],
                ['TRIVENI', '', ''],
                ['TUFIN', '', ''],
                ['TULIP', '', ''],
                ['UCF', '', ''],
                ['VISMEC', '', ''],
                ['VUZIX', '', ''],
                ['WORKLIO', '', ''],
                // Test data clients for Show Date filtering
                ['TECHCORP', '', 'Test client for Show Date filtering'],
                ['DATAINC', '', 'Test client for Show Date filtering'],
                ['BIZSOFT', '', 'Test client for Show Date filtering'],
                ['GADGETPRO', '', 'Test client for Show Date filtering'],
                ['CLOUDVENTURES', '', 'Test client for Show Date filtering'],
                ['INNOVATECO', '', 'Test client for Show Date filtering'],
                ['SYSTEMSINC', '', 'Test client for Show Date filtering'],
                ['MEGATECH', '', 'Test client for Show Date filtering'],
                ['PROSYSTEMS', '', 'Test client for Show Date filtering'],
                ['AMBIGUOUSCO', '', 'Test client for ambiguous date handling'],
                ['LATESHOWINC', '', 'Test client for ambiguous date handling'],
                // Test clients for transship chain pathway tests
                ['CHAINCO', '', 'Test client for two-show transship chain'],
                ['TRICHAIN', '', 'Test client for three-show transship chain'],
                ['OVERLAPCO', '', 'Test client for transship conflict-detection'],
                ['MULTIBOOTHCO', '', 'Test client for multi-booth override linking']
            ],
            'Shows': [
                ['Shows', 'Abbreviations', 'Notes'],
                ['AACR', '', ''],
                ['AANA', '', ''],
                ['AAOS', '', ''],
                ['AAP', '', ''],
                ['ABA', '', ''],
                ['ABATECH', '', ''],
                ['ABBEY & FLOORS TO GO', '', ''],
                ['ACC-QS', 'ACC', ''],
                ['ACDIS', '', ''],
                ['ACEP', '', ''],
                ['AHIMA', '', ''],
                ['AHIP', '', ''],
                ['AHRA', '', ''],
                ['ALLIANCE FLOORING', '', ''],
                ['ALS DRUG DEV', '', ''],
                ['ALZHEIMERS & DD', '', ''],
                ['AMGA', '', ''],
                ['ANCC', '', ''],
                ['ANESTHESIOLOGY', '', ''],
                ['AONL', '', ''],
                ['AORN', '', ''],
                ['ARRS', '', ''],
                ['ASA', '', ''],
                ['ASA ADVANCE', '', ''],
                ['ASC-BECKERS', '', ''],
                ['ASCA', '', ''],
                ['ASCO', '', ''],
                ['ASCP', '', ''],
                ['ASGCT', '', ''],
                ['ASH', '', ''],
                ['ASHHRA', '', ''],
                ['ASPNR', '', ''],
                ['ATA', '', ''],
                ['ATRIUM HEALTH', '', ''],
                ['AUA', '', ''],
                ['AUSA', '', ''],
                ['AUSTAL USA', '', ''],
                ['AWFS', '', ''],
                ['BECKERS', '', ''],
                ['BECKERS HIT', '', ''],
                ['BECKERS HOSPITAL REVIEW', 'BECKERS HR', ''],
                ['BECKERS CEO CFO', '', ''],
                ['BIO', '', ''],
                ['BURGER KING NA', 'BK', ''],
                ['CABLE-TEC', '', ''],
                ['CABLE-TEC SCTE', '', ''],
                ['CARDINAL RBC', '', ''],
                ['CARLS JR SFA', '', ''],
                ['CCA-WINTER', '', ''],
                ['CERNER', '', ''],
                ['CES', '', ''],
                ['CHENEY BROS', '', ''],
                ['CISCOLIVE', '', ''],
                ['CONNECTED AMER', '', ''],
                ['COVERINGS', '', ''],
                ['CUSTOMER EVENT', '', ''],
                ['CUSTOMER SUMMIT', '', ''],
                ['D2P', '', ''],
                ['DHI', '', ''],
                ['DIA', '', ''],
                ['DISCOVERY US', '', ''],
                ['ECOLAB', '', ''],
                ['EMERGE AMERICA', 'EMERGE AM', ''],
                ['ENA', '', ''],
                ['EPIC UGM', '', ''],
                ['EPIC XGM', '', ''],
                ['ETAIL EAST', '', ''],
                ['ETAIL WEST', '', ''],
                ['EURONAVAL', '', ''],
                ['EXECUTIVE FORUM', '', ''],
                ['FESTIVAL', '', ''],
                ['FIBERCONNECT', '', ''],
                ['FIELD SUMMIT', '', ''],
                ['FMX', '', ''],
                ['FUSE', '', ''],
                ['GERIMED', '', ''],
                ['GEST', '', ''],
                ['GLASSBUILD', '', ''],
                ['HEALTHTRUST', '', ''],
                ['HFMA ANNUAL', '', ''],
                ['HFMA WESTERN', '', ''],
                ['HFMA-REG2', '', ''],
                ['HIMSS', '', ''],
                ['HITEC', '', ''],
                ['HLTH', '', ''],
                ['HOSPITALITY SHOW', '', ''],
                ['HR TECH', '', ''],
                ['HSPA', '', ''],
                ['HTU', '', ''],
                ['IITSEC', 'ITSEC', ''],
                ['IACP', '', ''],
                ['ICAST', '', ''],
                ['ICCFA', '', ''],
                ['IHFA HARDEES', '', ''],
                ['ILTACON', '', ''],
                ['INFOCOMM', '', ''],
                ['INFOCUS', '', ''],
                ['IPC APEX OSC', '', ''],
                ['ISE EXPO', '', ''],
                ['IWF', '', ''],
                ['KBIS', 'KBIZ', ''],
                ['LEGALWEEK', '', ''],
                ['MAYO CLINIC', '', ''],
                ['MCDONALDS CANADA', 'MCD CANADA', ''],
                ['MCDONALDS WORLDWIDE', 'MCDONALDS WW, MCD WW', ''],
                ['MDM-WEST', 'MDM W', ''],
                ['MEDICARAINS', '', ''],
                ['MGMA', '', ''],
                ['MGMA LEADERS', '', ''],
                ['MHA', '', ''],
                ['MOHAWK EDGE', 'MOHAWK', ''],
                ['MWC', '', ''],
                ['MWC-BARCELONA', 'MWC B', ''],
                ['NAB', '', ''],
                ['NACDS', '', ''],
                ['NADA', '', ''],
                ['NAFEM', '', ''],
                ['NAMSS', '', ''],
                ['NCPA', '', ''],
                ['NEOCON', '', ''],
                ['NEUROSCIENCE', '', ''],
                ['NFDA', '', ''],
                ['NOA', '', ''],
                ['NPE', '', ''],
                ['NRF', '', ''],
                ['NGAUS', '', ''],
                ['OCHIN', '', ''],
                ['OCT SOCAL', '', ''],
                ['OCT WEST', '', ''],
                ['OCT-NEW ENG', '', ''],
                ['OFC', '', ''],
                ['OR MANAGER', '', ''],
                ['ORACLE BLUEPRINT', '', ''],
                ['ORACLE INFOCUS', '', ''],
                ['ORMC', '', ''],
                ['PGA', '', ''],
                ['POPEYES', '', ''],
                ['PREMIER BREAKTHROUGHS', '', ''],
                ['RADTECH', '', ''],
                ['RANGE RETAILER', '', ''],
                ['RISE MMS', '', ''],
                ['RISE NATIONAL', '', ''],
                ['RSA', '', ''],
                ['RSNA', '', ''],
                ['RTM HEALTHCARE', '', ''],
                ['SCOPE', '', ''],
                ['SEA AIR SPACE', 'SAS', ''],
                ['SEAT', '', ''],
                ['SFN', '', ''],
                ['SGNA', '', ''],
                ['SHOPTALK', '', ''],
                ['SHOPTALK FALL', 'SHOPTALK F', ''],
                ['SHOT', 'SHOT SHOW', ''],
                ['SIA FORUM', '', ''],
                ['SIIM', '', ''],
                ['SIO', '', ''],
                ['SIR', '', ''],
                ['SITC', '', ''],
                ['SLAS', '', ''],
                ['SMTA', '', ''],
                ['SMTA INTL', '', ''],
                ['SONIC', '', ''],
                ['SOUTHEAST FLOORING MARKET', '', ''],
                ['SOUTHWEST FLOORING', '', ''],
                ['STAFFING WORLD', '', ''],
                ['SURFACE NAVY', 'SNA', ''],
                ['SURFACES', 'SURFACES TISE', ''],
                ['SWFM', '', ''],
                ['SYNBIOBETA', '', ''],
                ['TANDEM', '', ''],
                ['TIM HORTON\'S', '', ''],
                ['USER CONFERENCE', '', ''],
                ['WAW REWARDS', '', ''],
                ['WENDYS', '', ''],
                ['WON', '', ''],
                ['WOODPRO', 'WOODPRO EXPO', ''],
                ['WORKBOAT', '', ''],
                ['XPONENTIAL', '', ''],
                // Test shows for transship chain pathway tests
                ['SPRING EXPO', '', 'Test: two-show chain source'],
                ['SUMMER SHOW', '', 'Test: two-show chain destination'],
                ['STAGE A', '', 'Test: three-show chain root'],
                ['STAGE B', '', 'Test: three-show chain middle'],
                ['STAGE C', '', 'Test: three-show chain end'],
                ['OVERLAP TEST', '', 'Test: overlapping show for conflict detection'],
                ['MULTI BOOTH', '', 'Test: multi-booth show with two packlists']
            ],
            'Preferences': [
                ['ID', 'Name', 'Description', 'Page', 'Type', 'Value', 'EditHistory'],
                ['ScheduleShipOffsetDaysFromShow', 'Ships Show Offset', 'default offset days from show start date for shows with missing ship dates', 'schedule*', 'integer', '14', ''],
                ['ScheduleReturnOffsetDaysFromShow', 'Returns Show Offset', 'default offset days from show end date for shows with missing return dates', 'schedule*', 'integer', '14', ''],
                ['ScheduleShipOffsetDaysFromInstall', 'Ships Install Offset', 'default offset days from show install date for shows with missing ship dates', 'schedule*', 'integer', '7', ''],
                ['ScheduleReturnOffsetDaysFromDismantle', 'Returns Dismantle Offset', 'default offset days from show dismantle date for shows with missing return dates', 'schedule*', 'integer', '7', ''],
                ['InventorySuppressCategoryAnalysis', 'Skip Quantity Analysis', 'these inventories are skipped when finding shortages', 'inventory*', 'json', '["FURNITURE","MONITORS","LIGHTING","ELECTRONICS","ADDITIONS"]', ''],
                ['InventoryCustomItemNumbers', 'Allow Nonstandard Item#s', 'these inventories have nonstandard item numbers and can slow down the system', 'inventory*', 'json', '["HARDWARE"]', ''],
                ['InventoryDescriptionOnly', 'Omit Quantity Column', 'list of inventories that omit the quantity column, added to packlists as descriptions only', 'inventory*', 'json', '["ADDITIONS"]', ''],
                ['InventoryNoteMaxLength', 'Inventory Note Length', 'maximum characters in an inventory save note (edit history, scheduled changes, proposal commits)', 'inventory*', 'integer', '25', '']
            ]
        }
    };

    static mockTabs = {
        'INVENTORY': [
            { title: 'FURNITURE', sheetId: 1 },
            { title: 'CABINETS', sheetId: 2 },
            { title: 'HANGING SIGNS', sheetId: 3 },
            { title: 'CEILING TILES', sheetId: 4 },
            { title: 'CEILING TRIM', sheetId: 5 },
            { title: 'LIGHTBOXES', sheetId: 6 },
            { title: 'COUNTERTOPS', sheetId: 7 },
            { title: 'SHELVES', sheetId: 8 },
            { title: 'PANELS', sheetId: 9 },
            { title: 'HARDWARE', sheetId: 10 },
            { title: 'ADDITIONS', sheetId: 11 },
            { title: '_EditHistory', sheetId: 12 }
        ],
        'PACK_LISTS': [
            { title: '_TEMPLATE', sheetId: 0 },
            { title: 'ATSC 2025 NAB', sheetId: 1 },
            { title: 'TULIP 2025 NRF', sheetId: 2 },
            { title: 'LOCKHEED MARTIN 2025 NGAUS', sheetId: 3 },
            { title: 'LOCKHEED MARTIN 2025 NGAUS VIP LOUNGE', sheetId: 4 },
            { title: 'LOCKHEED MARTIN 2025 NGAUS MEETING ROOM', sheetId: 5 },
            { title: 'QGENDA 2025 HIMSS', sheetId: 6 },
            { title: 'TEST CLIENT 2025 HIMSS', sheetId: 7 },
            { title: 'AUSTAL 2026 SNA', sheetId: 8 },
            { title: 'GEARFIRE 2025 SHOT', sheetId: 9 },
            { title: 'TEST 2025 ENHANCED', sheetId: 10 },
            { title: 'CHAINCO 2026 SPRING EXPO', sheetId: 11 },
            { title: 'CHAINCO 2026 SUMMER SHOW', sheetId: 12 },
            { title: 'TRICHAIN 2026 STAGE A', sheetId: 13 },
            { title: 'TRICHAIN 2026 STAGE B', sheetId: 14 },
            { title: 'TRICHAIN 2026 STAGE C', sheetId: 15 },
            { title: 'OVERLAPCO 2026 OVERLAP TEST', sheetId: 16 },
            { title: 'MULTIBOOTHCO 2026 MULTI BOOTH', sheetId: 17 },
            { title: 'MULTI BOOTH SECONDARY PACKLIST', sheetId: 18 },
        ],
        'PROD_SCHED': [
            { title: 'Production Schedule', sheetId: 0 }
        ],
        'CACHE': [
            { title: 'UserData_test_example_com', sheetId: 0 },
            { title: 'Locks', sheetId: 1 },
            { title: 'Notes', sheetId: 2 },
            { title: 'Links', sheetId: 3 },
            { title: 'Clients', sheetId: 4 },
            { title: 'Shows', sheetId: 5 },
            { title: 'Thumbnails', sheetId: 6 },
            { title: 'Inventory', sheetId: 7 },
            { title: 'NameOverrides', sheetId: 8 },
            { title: 'ScheduleOverrides', sheetId: 9 },
            { title: 'Preferences', sheetId: 10 },
            { title: 'InventoryProposals', sheetId: 11 },
            { title: 'Analytics', sheetId: 12 }
        ]
    };

    static async withExponentialBackoff(fn, maxRetries = 7, initialDelay = 500) {
        await this.delay(500 + Math.random() * 500); // Add random delay > 1s
        //console.log('FakeGoogleSheetsService: Simulating exponential backoff...');
        await this.delay(Math.random() * 100 + 50); // Random delay between 50-150ms
        try {
            return await fn();
        } catch (error) {
            //console.log('FakeGoogleSheetsService: Simulated error caught in backoff');
            throw error;
        }
    }

    /**
     * Fault injection for tests (null in normal use). Hooks run inside the fake service calls, at
     * the points where a concurrent editor could change the live sheet:
     *   beforeRead(tableId, range)              before each range read (getSheetData, batchGetValues)
     *   beforeWrite(tableId, range, values)     before a single setSheetData; return 'drop' to lose it
     *   beforeBatchWrite(tableId, data)         before a batchSetValues; return 'drop' to lose all of
     *                                           it, or a Set of data indices to lose just those
     *   beforeDelete(tableId, tabName, rows)    before a deleteSheetRows; return 'drop' to lose it
     */
    static faults = null;

    static async _fault(name, ...args) {
        const hook = this.faults && this.faults[name];
        return typeof hook === 'function' ? await hook(...args) : undefined;
    }

    /** Delete whole rows (1-based; the header row is never deleted), bottom up, as one step. */
    static async deleteSheetRows(tableId, tabName, rowNumbers) {
        await this.delay(500 + Math.random() * 500);
        await FakeGoogleSheetsAuth.checkAuth();
        if (!this.ENDPOINT_IDS[tableId]) throw new Error(`[deleteSheetRows] Spreadsheet ID not found for table: ${tableId}`);
        const sheet = this.mockData[tableId]?.[tabName];
        if (!sheet) throw new Error(`[deleteSheetRows] Sheet not found: ${tabName}`);
        const rows = [...new Set((rowNumbers || []).map(Number).filter(n => Number.isInteger(n) && n > 1))].sort((a, b) => b - a);
        if (await this._fault('beforeDelete', tableId, tabName, rows) === 'drop') return true;
        rows.forEach(n => { if (n - 1 < sheet.length) sheet.splice(n - 1, 1); });
        return true;
    }

    /** values.batchGet: one 2D array per range, in order (each range read as getSheetData would). */
    static async batchGetValues(tableId, ranges) {
        return await Promise.all((ranges || []).map(range => this.getSheetData(tableId, range)));
    }

    /**
     * values.batchUpdate: write every { range, values } in one step. Like the API, the batch lands
     * as a unit; a fault hook can only act before it (or drop parts of it).
     */
    static async batchSetValues(tableId, data) {
        await this.delay(500 + Math.random() * 500);
        await FakeGoogleSheetsAuth.checkAuth();
        if (!this.ENDPOINT_IDS[tableId]) throw new Error(`[batchSetValues] Spreadsheet ID not found for table: ${tableId}`);
        const fault = await this._fault('beforeBatchWrite', tableId, data);
        if (fault === 'drop') return true;
        (data || []).forEach((d, i) => {
            if (fault instanceof Set && fault.has(i)) return;
            if (!this._writeRange(tableId, d.range, d.values)) throw new Error(`[batchSetValues] Unsupported range: ${d.range}`);
        });
        return true;
    }

    /**
     * Synchronous write of a values block to an A1 range ("Tab!B2:D3", sheet name optionally quoted).
     * @returns {boolean} false when the range isn't an A1 block range
     */
    static _writeRange(tableId, range, updates) {
        const rangeMatch = String(range).match(/^(.+)!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
        if (!rangeMatch) return false;
        const [, rawSheetName, startCol, startRow, endCol, endRow] = rangeMatch;
        const sheetName = _unquoteSheetName(rawSheetName);
        const startColIndex = _colToIndex(startCol);
        const endColIndex = _colToIndex(endCol);
        const startRowIndex = parseInt(startRow) - 1;
        const endRowIndex = parseInt(endRow) - 1;

        // Initialize sheet if it doesn't exist
        if (!this.mockData[tableId]) this.mockData[tableId] = {};
        if (!this.mockData[tableId][sheetName]) {
            // Initialize with empty structure (will be populated dynamically)
            this.mockData[tableId][sheetName] = [
                ['Users'] // Row 0: Headers row (lock keys added dynamically)
            ];
        }
        const sheet = this.mockData[tableId][sheetName];
        if (!Array.isArray(updates) || !updates.length || !Array.isArray(updates[0])) return true;

        for (let r = 0; r < updates.length && startRowIndex + r <= endRowIndex; r++) {
            const rowIndex = startRowIndex + r;
            // Ensure row exists, and columns up to endColIndex
            while (sheet.length <= rowIndex) sheet.push([]);
            while (sheet[rowIndex].length <= endColIndex) sheet[rowIndex].push('');
            for (let colOffset = 0; colOffset < updates[r].length; colOffset++) {
                const targetColIndex = startColIndex + colOffset;
                if (targetColIndex <= endColIndex) sheet[rowIndex][targetColIndex] = updates[r][colOffset];
            }
        }
        // Debug log for Caching tab writes
        if (tableId === 'CACHE' && sheetName === 'Caching') {
            console.log(`[FakeGoogle] Caching tab updated at row ${startRowIndex + 1}:`, updates[0]);
        }
        return true;
    }

    static async getSheetData(tableId, range) {
        await this.delay(500 + Math.random() * 500); // Add random delay > 1s
        await FakeGoogleSheetsAuth.checkAuth();

        const spreadsheetId = this.ENDPOINT_IDS[tableId];
        if (!spreadsheetId) throw new Error(`[getSheetData] Spreadsheet ID not found for table: ${tableId}`);

        //console.log(`FakeGoogleSheetsService: Getting data for ${tableId}, range: ${range}`);
        await this.delay(100);
        await this._fault('beforeRead', tableId, range);

        // Parse range to extract sheet name and cell range (the sheet name may be quoted)
        const bang = range.lastIndexOf('!');
        const sheetName = _unquoteSheetName(bang >= 0 ? range.slice(0, bang) : range);
        const cellRange = bang >= 0 ? range.slice(bang + 1) : undefined;

        // Initialize Caching tab in mockData if it doesn't exist yet
        // CRITICAL: Caching tab MUST have both columns (Key, Timestamp) populated for poller to function.
        // Rows with missing timestamps are skipped by the invalidation logic.
        if (tableId === 'CACHE' && sheetName === 'Caching') {
            if (!this.mockData[tableId]) this.mockData[tableId] = {};
            if (!this.mockData[tableId][sheetName]) {
                // Initialize with headers and one simulated entry with an old timestamp
                // so the first poll doesn't immediately fire
                const oldTimestamp = new Date(Date.now() - 60000).toISOString(); // 1 minute ago
                this.mockData[tableId][sheetName] = [
                    ['Key', 'Timestamp'],
                    ['database:getData:"PACK_LISTS","ATSC 2025 NAB"', oldTimestamp]
                ];
            }
        }

        const sheetData = this.mockData[tableId] && this.mockData[tableId][sheetName];
        
        //console.log(`[FakeGoogle.getSheetData] Reading mockData['${tableId}']['${sheetName}']:`, JSON.stringify(sheetData));
        
        if (!sheetData) {
            console.warn(`FakeGoogleSheetsService: No mock data found for ${tableId}/${sheetName}`);
            return [[]];
        }

        // Handle specific cell range requests (e.g., "B2:B2" for lock cells)
        if (cellRange) {
            const cellMatch = cellRange.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
            if (cellMatch) {
                const [, startCol, startRow, endCol, endRow] = cellMatch;
                const c0 = _colToIndex(startCol);
                const c1 = _colToIndex(endCol);
                const r0 = parseInt(startRow) - 1;
                const r1 = parseInt(endRow) - 1;
                // Return the requested block (multi-letter columns and multi-cell ranges supported)
                const block = [];
                for (let r = r0; r <= r1; r++) {
                    const line = [];
                    for (let c = c0; c <= c1; c++) {
                        const v = sheetData[r] ? sheetData[r][c] : undefined;
                        line.push(v === undefined ? '' : v);
                    }
                    block.push(line);
                }
                return block;
            }
        }

        // Return a copy to avoid mutation
        return JSON.parse(JSON.stringify(sheetData));
    }

    static async setSheetData(tableId, tabName, updates, removeRowsBelow) {
        await this.delay(500 + Math.random() * 500); // Add random delay > 1s
        await FakeGoogleSheetsAuth.checkAuth();

        const spreadsheetId = this.ENDPOINT_IDS[tableId];
        if (!spreadsheetId) throw new Error(`[setSheetData] Spreadsheet ID not found for table: ${tableId}`);

        //console.log(`FakeGoogleSheetsService: Setting data for ${tableId}/${tabName}`);
        await this.delay(150);
        if (await this._fault('beforeWrite', tableId, tabName, updates) === 'drop') return true;

        try {
            // Handle range-specific updates (e.g., "Locks!B2" for single cell, "Caching!A2:B2" for row updates)
            // CRITICAL: Must support multi-column writes. writeCacheTimestamp uses A#:B# ranges to write
            // both Key and Timestamp columns simultaneously. Single-column writes would break cache invalidation.
            if (this._writeRange(tableId, tabName, updates)) return true;
            
            // If removeRowsBelow is specified, delete all rows below that row before saving
            if (typeof removeRowsBelow === 'number') {
                if (!this.mockData[tableId]) this.mockData[tableId] = {};
                if (!this.mockData[tableId][tabName]) this.mockData[tableId][tabName] = [];
                const sheetData = this.mockData[tableId][tabName];
                if (sheetData.length > removeRowsBelow) {
                    // Remove rows from removeRowsBelow (0-based) to end
                    this.mockData[tableId][tabName] = sheetData.slice(0, removeRowsBelow);
                }
            }

            // If updates is an array of JS objects and mapping is provided, convert to sheet format
            if (Array.isArray(updates) && updates.length > 0 && typeof updates[0] === 'object' && !Array.isArray(updates[0])) {
                if (arguments.length >= 4 && typeof arguments[3] === 'object' && arguments[3] !== null) {
                    // mapping is passed as 4th argument
                    const mapping = arguments[3];
                    const sheetData = FakeGoogleSheetsService.reverseTransformSheetData(mapping, updates);
                    this.mockData[tableId][tabName] = sheetData;
                    return true;
                }
            }
            
            // Handle empty array with mapping - create headers-only sheet
            if (Array.isArray(updates) && updates.length === 0 && arguments.length >= 4 && typeof arguments[3] === 'object' && arguments[3] !== null) {
                const mapping = arguments[3];
                const headers = mapping._orderedHeaders || Object.values(mapping).filter(v => v !== mapping._orderedHeaders);
                if (!this.mockData[tableId]) this.mockData[tableId] = {};
                this.mockData[tableId][tabName] = [headers];
                return true;
            }

            // Handle range-based updates (like "A1:B1" with values array)
            if (Array.isArray(updates) && updates.length > 0 && Array.isArray(updates[0])) {
                //console.log(`FakeGoogleSheetsService: Range update with ${updates.length} rows`);
                if (!this.mockData[tableId]) this.mockData[tableId] = {};
                this.mockData[tableId][tabName] = updates; // Replace entire sheet with new data
                return true;
            }

            // Handle cell-by-cell updates
            if (Array.isArray(updates) && updates.length > 0 && updates[0].hasOwnProperty('row')) {
                //console.log(`FakeGoogleSheetsService: Applying ${updates.length} cell updates`);
                if (!this.mockData[tableId]) this.mockData[tableId] = {};
                if (!this.mockData[tableId][tabName]) this.mockData[tableId][tabName] = [];
                const sheetData = this.mockData[tableId][tabName];
                updates.forEach(({row, col, value}) => {
                    while (sheetData.length <= row) {
                        sheetData.push([]);
                    }
                    while (sheetData[row].length <= col) {
                        sheetData[row].push('');
                    }
                    sheetData[row][col] = value;
                });
                return true;
            }

            // Handle full-table updates
            if (updates?.type === 'full-table' && Array.isArray(updates.values)) {
                //console.log(`FakeGoogleSheetsService: Full table update with ${updates.values.length} rows`);
                if (!this.mockData[tableId]) this.mockData[tableId] = {};
                const startRow = typeof updates.startRow === 'number' ? updates.startRow : 0;
                const values = updates.values;
                if (startRow === 0) {
                    this.mockData[tableId][tabName] = JSON.parse(JSON.stringify(values));
                } else {
                    if (!this.mockData[tableId][tabName]) this.mockData[tableId][tabName] = [];
                    const sheetData = this.mockData[tableId][tabName];
                    while (sheetData.length < startRow) {
                        sheetData.push([]);
                    }
                    for (let i = 0; i < values.length; ++i) {
                        sheetData[startRow + i] = JSON.parse(JSON.stringify(values[i]));
                    }
                    // Truncate any rows below the new data
                    sheetData.length = startRow + values.length;
                }
                // Always truncate any rows below the new data for full-table updates
                if (this.mockData[tableId][tabName].length > (startRow + values.length)) {
                    this.mockData[tableId][tabName].length = startRow + values.length;
                }
                return true;
            }

            throw new Error('Invalid updates format for setSheetData');
        } catch (error) {
            console.error('FakeGoogleSheetsService: Error updating sheet:', error);
            throw error;
        }
    }

    static async getSheetTabs(tableId) {
        await this.delay(500 + Math.random() * 500); // Add random delay > 1s
        await FakeGoogleSheetsAuth.checkAuth();

        const spreadsheetId = this.ENDPOINT_IDS[tableId];
        if (!spreadsheetId) throw new Error(`[getSheetTabs] Spreadsheet ID not found for table: ${tableId}`);

        //console.log(`FakeGoogleSheetsService: Getting tabs for ${tableId}`);
        await this.delay(80);

        const tabs = this.mockTabs[tableId] || [];
        return JSON.parse(JSON.stringify(tabs)); // Return a copy
    }

    static async hideTabs(tableId, tabs) {
        await this.delay(500 + Math.random() * 500); // Add random delay > 1s
        await FakeGoogleSheetsAuth.checkAuth();

        const spreadsheetId = this.ENDPOINT_IDS[tableId];
        if (!spreadsheetId) throw new Error(`[hideTabs] Spreadsheet ID not found for table: ${tableId}`);

        //console.log(`FakeGoogleSheetsService: Hiding ${tabs.length} tabs in ${tableId}`);
        await this.delay(120);

        // In a real implementation, we'd track hidden state
        // For mock purposes, just log the action
        tabs.forEach(tab => {
            //console.log(`  - Hiding tab: ${tab.title} (ID: ${tab.sheetId})`);
        });
    }

    static async showTabs(tableId, tabs) {
        await this.delay(500 + Math.random() * 500); // Add random delay > 1s
        await FakeGoogleSheetsAuth.checkAuth();

        const spreadsheetId = this.ENDPOINT_IDS[tableId];
        if (!spreadsheetId) throw new Error(`[showTabs] Spreadsheet ID not found for table: ${tableId}`);

        //console.log(`FakeGoogleSheetsService: Showing ${tabs.length} tabs in ${tableId}`);
        await this.delay(120);

        // In a real implementation, we'd track hidden state
        // For mock purposes, just log the action
        tabs.forEach(tab => {
            //console.log(`  - Showing tab: ${tab.title} (ID: ${tab.sheetId})`);
        });
    }

    static async copySheetTab(tableId, sourceTab, newTabName) {
        await this.delay(500 + Math.random() * 500); // Add random delay > 1s
        await FakeGoogleSheetsAuth.checkAuth();

        const spreadsheetId = this.ENDPOINT_IDS[tableId];
        if (!spreadsheetId) throw new Error(`[copySheetTab] Spreadsheet ID not found for table: ${tableId}`);

        //console.log(`FakeGoogleSheetsService: Copying tab ${sourceTab?.title || 'unknown'} to ${newTabName} in ${tableId}`);
        await this.delay(200);

        // Handle case where sourceTab is null or undefined
        if (!sourceTab || !sourceTab.title) {
            throw new Error('Source tab is required for copying');
        }

        // Ensure mock data structure exists
        if (!this.mockData[tableId]) this.mockData[tableId] = {};

        // Normal copy operation
        if (this.mockData[tableId] && this.mockData[tableId][sourceTab.title]) {
            this.mockData[tableId][newTabName] = JSON.parse(JSON.stringify(this.mockData[tableId][sourceTab.title]));
        } else {
            console.warn(`FakeGoogleSheetsService: Source data not found for ${sourceTab.title}, creating empty tab`);
            this.mockData[tableId][newTabName] = [
                ['Key', 'Value', 'Timestamp']
            ];
        }

        // Add new tab to tabs list
        if (this.mockTabs[tableId]) {
            const newSheetId = Math.max(...this.mockTabs[tableId].map(t => t.sheetId)) + 1;
            this.mockTabs[tableId].push({
                title: newTabName,
                sheetId: newSheetId
            });
        } else {
            // Initialize tabs array if it doesn't exist
            this.mockTabs[tableId] = [{
                title: newTabName,
                sheetId: 0
            }];
        }

        //console.log(`FakeGoogleSheetsService: Successfully created tab ${newTabName}`);
    }

    static async createBlankTab(tableId, newTabName) {
        await this.delay(500 + Math.random() * 500); // Add random delay > 1s
        await FakeGoogleSheetsAuth.checkAuth();

        const spreadsheetId = this.ENDPOINT_IDS[tableId];
        if (!spreadsheetId) throw new Error(`[createBlankTab] Spreadsheet ID not found for table: ${tableId}`);

        //console.log(`FakeGoogleSheetsService: Creating blank tab ${newTabName} in ${tableId}`);
        await this.delay(150);

        // Ensure mock data structure exists
        if (!this.mockData[tableId]) this.mockData[tableId] = {};
        
        // Create empty tab with basic structure for user data
        this.mockData[tableId][newTabName] = [
            ['ID', 'Data1', 'Data2', 'Data3'] // Default headers for user data tabs
        ];

        // Add new tab to tabs list
        if (this.mockTabs[tableId]) {
            const newSheetId = Math.max(...this.mockTabs[tableId].map(t => t.sheetId)) + 1;
            this.mockTabs[tableId].push({
                title: newTabName,
                sheetId: newSheetId
            });
        } else {
            // Initialize tabs array if it doesn't exist
            this.mockTabs[tableId] = [{
                title: newTabName,
                sheetId: 0
            }];
        }

        //console.log(`FakeGoogleSheetsService: Successfully created blank tab ${newTabName}`);
    }

    static async querySheetData(tableId, query) {
        await this.delay(500 + Math.random() * 500); // Add random delay > 1s
        await FakeGoogleSheetsAuth.checkAuth();
        
        //console.log(`FakeGoogleSheetsService: Executing query on ${tableId}: ${query}`);
        await this.delay(100);

        try {
            // Parse the query using SheetSql like the real implementation
            const parsedQuery = SheetSql.parseQuery(query);
            
            if (!parsedQuery.from) {
                throw new Error('Invalid query: FROM clause is required');
            }
            
            // Get the data from the sheet
            const data = await this.getSheetData(tableId, parsedQuery.from);
            
            if (!data || data.length === 0) {
                return [];
            }
            
            // Execute the query against the data using SheetSql
            const results = SheetSql.executeQuery(parsedQuery, data);
            
            //console.log(`FakeGoogleSheetsService: Query returned ${results.length} results`);
            return results;
        } catch (error) {
            console.error('FakeGoogleSheetsService: Error executing sheet query:', error);
            throw new Error(`Failed to execute query: ${error.message}`);
        }
    }

    // Utility method to simulate async delays
    static delay(ms) {
        if (!_delaysEnabled) return Promise.resolve();
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Method to reset mock data to original state (discards locally saved changes)
    static resetMockData() {
        FakeGoogleState.reset();
    }

    // Method to add custom mock data for testing
    static setMockData(tableId, sheetName, data) {
        //console.log(`FakeGoogleSheetsService: Setting custom mock data for ${tableId}/${sheetName}`);
        if (!this.mockData[tableId]) this.mockData[tableId] = {};
        this.mockData[tableId][sheetName] = JSON.parse(JSON.stringify(data));
    }

    // Method to get current mock data (useful for debugging tests)
    static getMockData(tableId, sheetName = null) {
        if (sheetName) {
            return this.mockData[tableId] && this.mockData[tableId][sheetName] 
                ? JSON.parse(JSON.stringify(this.mockData[tableId][sheetName]))
                : null;
        }
        return this.mockData[tableId] 
            ? JSON.parse(JSON.stringify(this.mockData[tableId]))
            : null;
    }

    /**
     * Fake implementation of Google Drive file search
     * @param {string} fileName - Name of the file to search for
     * @param {string} folderId - ID of the folder to search in
     * @returns {Promise<Object|null>} Fake file object or null
     */
    static async searchDriveFileInFolder(fileName, folderId) {
        await this.delay(200); // Simulate API delay
        
        // Map item numbers to file IDs and images for testing
        const mockFiles = {
            'BX.png': { id: 'file_id_bx_prefix', image: 'assets/logobkp.png' },
            'CHAIR.jpg': { id: 'file_id_chair_prefix', image: 'assets/logobkp.png' },
            'CHAIR.jpeg': { id: 'file_id_chair_prefix', image: 'assets/logobkp.png' },
            'CHAIR.png': { id: 'file_id_chair_prefix', image: 'assets/logobkp.png' },
            'CHAIR-001.jpg': { id: 'file_id_chair_001', image: 'assets/logoWbkp.png' },
            'CHAIR-001.jpeg': { id: 'file_id_chair_001', image: 'assets/logoWbkp.png' },
            'CHAIR-001.png': { id: 'file_id_chair_001', image: 'assets/logoWbkp.png' },
            'CHAIR-002.jpg': { id: 'file_id_chair_002', image: 'assets/logo2.png' },
            'CHAIR-002.jpeg': { id: 'file_id_chair_002', image: 'assets/logo2.png' },
            'CHAIR-002.png': { id: 'file_id_chair_002', image: 'assets/logo2.png' },
            'TABLE.jpg': { id: 'file_id_table_prefix', image: 'assets/logoWbkp.png' },
            'TABLE.jpeg': { id: 'file_id_table_prefix', image: 'assets/logoWbkp.png' },
            'TABLE.png': { id: 'file_id_table_prefix', image: 'assets/logoWbkp.png' },
            'TABLE-001.jpg': { id: 'file_id_table_001', image: 'assets/logobkp.png' },
            'TABLE-001.jpeg': { id: 'file_id_table_001', image: 'assets/logobkp.png' },
            'TABLE-001.png': { id: 'file_id_table_001', image: 'assets/logobkp.png' }
        };
        
        if (mockFiles[fileName]) {
            const { id, image } = mockFiles[fileName];
            return {
                id,
                name: fileName,
                webViewLink: `https://drive.google.com/fake/${fileName}`,
                thumbnailLink: image
            };
        }
        
        return ""; // File not found
    }

    /**
     * Fake implementation of fetching a Drive file's thumbnail link
     */
    static async getDriveFileThumbnailLink(fileId) {
        await this.delay(30);
        return fileId ? 'assets/logo.png' : null;
    }

    /**
     * Maps fake file IDs to test image paths. Dynamically uploaded files get a default test image.
     */
    static _fakeImagePath(fileId) {
        // Map predefined file IDs to test image paths
        const fileMap = {
            'file_id_bx_prefix': 'assets/logobkp.png',
            'file_id_chair_prefix': 'assets/logobkp.png',
            'file_id_chair_001': 'assets/logoWbkp.png',
            'file_id_chair_002': 'assets/logo2.png',
            'file_id_table_prefix': 'assets/logoWbkp.png',
            'file_id_table_001': 'assets/logobkp.png'
        };
        
        if (fileId && fileMap[fileId]) {
            return fileMap[fileId];
        }
        
        // For dynamically uploaded files (fake_uploaded_*), return a default test image
        if (fileId && fileId.startsWith('fake_uploaded_')) {
            return 'assets/logo.png';
        }
        
        return null;
    }

    /**
     * Fake implementation of fetching a Drive file's raw content as a Blob.
     * Loads the test image that _fakeImagePath maps the file ID to.
     */
    static async getDriveFileBlob(fileId) {
        await this.delay(50);
        const url = this._fakeImagePath(fileId);
        if (!url) return null;
        const response = await fetch(url);
        return response.ok ? await response.blob() : null;
    }

    /**
     * Fake implementation of Google Drive file upload
     */
    static async uploadDriveFile(file, fileName, folderId) {
        await this.delay(300);
        console.log(`[FakeGoogle] uploadDriveFile: "${fileName}" to folder "${folderId}"`);
        return { id: `fake_uploaded_${Date.now()}`, name: fileName };
    }

    /**
     * Fake implementation of Google Drive file delete
     */
    static async deleteDriveFile(fileId) {
        await this.delay(100);
        console.log(`[FakeGoogle] deleteDriveFile: "${fileId}"`);
        return true;
    }

    /**
     * Fake implementation of getting Drive image URL
     * @param {string} fileId - Google Drive file ID
     * @returns {string} Direct image URL
     */
    static getDriveImageUrl(fileId) {
        return `assets/placeholder.png`; // Always return placeholder for fake implementation
    }
}

// ── Design queue fixtures (views-and-renderers-plan §4.16, Phase 2) ──────────
// The live database gets the same: the json preferences below, a CACHE/ShowNotes tab, and
// Account Manager / Assignee columns on the Production Schedule.
// ColumnTypes declares what each column holds (utils/column-types.js); undeclared columns are text
// (or a date / number / currency guessed from the name).
const FAKE_COLUMN_TYPES = {
    'PROD_SCHED/Production Schedule': {
        'Ship BKD': 'checkbox', 'O/B BKD': 'checkbox', 'MHA Done': 'checkbox', 'Sup Badge Req.': 'checkbox',
        'Pack List': 'checkbox', 'PL to OPS': 'checkbox', 'SOW Sent': 'checkbox', 'SOW Ret': 'checkbox',
        'Elev': 'checkbox', 'Panels': 'checkbox', 'Setups': 'checkbox', '3rd Party Auth': 'checkbox',
        'I&D': 'checkbox', 'S/U to Elite': 'checkbox', 'MH': 'checkbox', 'Elec': 'checkbox',
        'Elec and Net dwg sent': 'checkbox', 'H/S': 'checkbox', 'H/S dwg sent': 'checkbox', 'Net': 'checkbox',
        'Oth': 'checkbox', 'EAC': 'checkbox', 'COI': 'checkbox', 'S/U IN SHOP': 'checkbox',
        'Assignee': { type: 'select', options: 'DesignQueueAssignees' }
    }
};
(function addDesignQueueFixtures() {
    const data = FakeGoogleSheetsService.mockData;
    const prefs = data.CACHE && data.CACHE.Preferences;
    if (prefs) {
        prefs.push(
            ['InstantWriteTables', 'Instant-write tables', 'row identity and writable columns for tables that save each edit immediately', 'schedule*', 'json',
                '{"PROD_SCHED/Production Schedule": {"identity": ["Client", "Year", "Show"], "columns": ["Elev", "Panels", "Setups", "Assignee"]}}', ''],
            ['DesignQueueFields', 'Design queue fields', 'columns shown on the design queue', 'schedule/design-queue*', 'json',
                '["Client", "Show", "Size", "Note", "Elev", "Panels", "Setups", "Assignee", "Account Manager", "Ship", "Booth#"]', ''],
            ['DesignQueueAssignees', 'Design queue assignees', 'people who can be assigned design work', 'schedule/design-queue*', 'json',
                '[["Alex", "red"], ["Sam Smith", "blue"]]', ''],
            ['ColumnTypes', 'Column types', 'what each sheet column holds (checkbox, select, date, number, currency); undeclared columns are text', 'schedule*', 'json',
                JSON.stringify(FAKE_COLUMN_TYPES), '']
        );
    }
    if (data.CACHE && !data.CACHE.ShowNotes) {
        data.CACHE.ShowNotes = [
            ['Identifier', 'Note', 'EditHistory'],
            ['GEARFIRE 2025 SHOT', 'Waiting on client logo files', '']
        ];
    }
    const tabs = FakeGoogleSheetsService.mockTabs && FakeGoogleSheetsService.mockTabs.CACHE;
    if (tabs && !tabs.some(t => t.title === 'ShowNotes')) tabs.push({ title: 'ShowNotes', sheetId: 11 });

    const sched = data.PROD_SCHED && data.PROD_SCHED['Production Schedule'];
    if (sched && sched.length && !sched[0].includes('Assignee')) {
        const width = sched[0].length;
        sched[0][width] = 'Account Manager';
        sched[0][width + 1] = 'Assignee';
        const managers = ['Dana', 'Lee', 'Morgan'];
        const assignees = ['Alex', 'Sam', 'Jordan', ''];
        for (let i = 1; i < sched.length; i++) {
            const row = sched[i];
            while (row.length < width) row.push('');
            row[width] = managers[i % managers.length];
            row[width + 1] = assignees[i % assignees.length];
        }
    }
})();
// ── Local persistence, cross-tab sync, and test sandbox ─────────────────────
// Mock data lives in memory, so by default every reload starts from the fixtures above.
// On localhost the current state is also saved to localStorage after every write and
// restored on load, so local testing (e.g. EditHistory) carries across reloads, and
// other browser tabs on the same origin pick up changes (simulating other sessions).
// Saved state is discarded automatically when the fixtures in this file change.

const _fixtureJson = JSON.stringify({
    mockData: FakeGoogleSheetsService.mockData,
    mockTabs: FakeGoogleSheetsService.mockTabs
});
const _fixtureVersion = (() => {
    let hash = 0;
    for (let n = 0; n < _fixtureJson.length; n++) hash = (hash * 31 + _fixtureJson.charCodeAt(n)) | 0;
    return String(hash);
})();
const _externalChangeListeners = new Set();
let _saveTimer = null;

function _applyState(state) {
    FakeGoogleSheetsService.mockData = state.mockData;
    FakeGoogleSheetsService.mockTabs = state.mockTabs;
}

function _currentStateJson() {
    return JSON.stringify({
        version: _fixtureVersion,
        mockData: FakeGoogleSheetsService.mockData,
        mockTabs: FakeGoogleSheetsService.mockTabs
    });
}

/** Parse saved state, or null if absent, unreadable, or saved against different fixtures */
function _parseSavedState(json) {
    if (!json) return null;
    try {
        const state = JSON.parse(json);
        return state?.version === _fixtureVersion ? state : null;
    } catch {
        return null;
    }
}

export const FakeGoogleState = {
    isPersistent() {
        return _storageGet('localStorage', PERSIST_STORAGE_KEY) !== '0';
    },

    setPersistent(enabled) {
        _storageSet('localStorage', PERSIST_STORAGE_KEY, enabled ? '1' : '0');
        if (enabled) this.saveNow();
        else _storageSet('localStorage', STATE_STORAGE_KEY, null);
    },

    /** Save soon (coalesces bursts of writes such as cache timestamps) */
    save() {
        if (_sandboxed || !this.isPersistent()) return;
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(() => this.saveNow(), 50);
    },

    saveNow() {
        clearTimeout(_saveTimer);
        if (_sandboxed || !this.isPersistent()) return;
        _storageSet('localStorage', STATE_STORAGE_KEY, _currentStateJson());
    },

    /** Load saved state into memory. Returns true if saved state was applied. */
    load() {
        const json = _storageGet('localStorage', STATE_STORAGE_KEY);
        const state = _parseSavedState(json);
        if (json && !state) {
            console.warn('[FakeGoogle] Saved local data was made with different fixtures; starting from the fixtures.');
            _storageSet('localStorage', STATE_STORAGE_KEY, null);
        }
        if (!state) return false;
        _applyState(state);
        return true;
    },

    /** Discard all local changes and return to the fixtures in this file */
    reset() {
        _applyState(JSON.parse(_fixtureJson));
        _storageSet('localStorage', STATE_STORAGE_KEY, null);
        this.saveNow();
    },

    /**
     * Run the test suite against pristine fixtures without touching local data.
     * Returns a function that ends the sandbox and restores the latest local state.
     */
    beginSandbox() {
        clearTimeout(_saveTimer);
        const snapshot = _currentStateJson();
        const previousEmail = FakeGoogleSheetsAuth.userEmail;
        _sandboxed = true;
        _applyState(JSON.parse(_fixtureJson));
        FakeGoogleSheetsAuth.userEmail = DEFAULT_FAKE_USER;
        return () => {
            _sandboxed = false;
            // Prefer the saved state: another tab may have written while the sandbox was active
            if (!(this.isPersistent() && this.load())) _applyState(JSON.parse(snapshot));
            FakeGoogleSheetsAuth.userEmail = previousEmail;
        };
    },

    /** Called after another browser tab changes the shared local data */
    onExternalChange(listener) {
        _externalChangeListeners.add(listener);
        return () => _externalChangeListeners.delete(listener);
    },

    getUser() {
        return _configuredEmail();
    },

    /** Set this browser tab's fake user (takes effect at the next login) */
    setUser(email) {
        _storageSet('sessionStorage', USER_STORAGE_KEY, email || null);
    }
};

// Persist after every mutating call
['setSheetData', 'batchSetValues', 'deleteSheetRows', 'copySheetTab', 'createBlankTab', 'hideTabs', 'showTabs', 'setMockData'].forEach(name => {
    const original = FakeGoogleSheetsService[name];
    FakeGoogleSheetsService[name] = function (...args) {
        const result = original.apply(this, args);
        if (result && typeof result.then === 'function') {
            return result.then(value => { FakeGoogleState.save(); return value; });
        }
        FakeGoogleState.save();
        return result;
    };
});

if (isLocalhost() && FakeGoogleState.isPersistent()) {
    FakeGoogleState.load();
    window.addEventListener('storage', (event) => {
        if (event.key !== STATE_STORAGE_KEY || _sandboxed) return;
        const state = _parseSavedState(event.newValue);
        if (!state) return;
        _applyState(state);
        _externalChangeListeners.forEach(listener => {
            try { listener(); } catch (error) { console.warn('[FakeGoogle] External change listener failed:', error); }
        });
    });
}

// Export both classes for easy swapping with real implementations
export { FakeGoogleSheetsAuth as GoogleSheetsAuth, FakeGoogleSheetsService as GoogleSheetsService };
