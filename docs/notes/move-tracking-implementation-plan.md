# Move Tracking Implementation Plan

> **Superseded (2026-10-21):** the position-based `i` design below was not implemented. Row identity is now a stable `EditHistory.i` assigned on first touch — see `metadata-implementation.md` (EditHistory Contract) for the current contract.

**Status**: Planning Phase  
**Created**: June 4, 2026  
**Complexity**: MODERATE-HIGH (6.5/10)  
**Estimated Time**: 3-5 days

## Overview

Extend the EditHistory system to track row reordering operations alongside field changes. This enables reconstruction of table state at any point in history, including row positions.

## Design Decisions

### 1. Row Identity System

- Add current index to editHistory as `"i"` field (sibling to `"h"`)
- Initialize on first save (not on load)
- New rows without editHistory are treated as inserted rows
- Format: `{"h": [...], "i": 5}` where 5 is the row's position in the array

### 2. Move Detection

- Compare editHistory `"i"` field vs actual current index position
- If different, row has moved since last save
- Record move in changes array as `{"m": previousIndex}`
- Update `"i"` to current position after recording move

### 3. Move Entry Format

Move operations are recorded inside the `"c"` (changes) array:

```json
{
  "h": [
    {
      "u": "dan",
      "t": 17400000000,
      "s": "web",
      "c": [{ "n": "quantity", "o": "5" }, { "m": 3 }]
    }
  ],
  "i": 7
}
```

The `{"m": 3}` entry means: "this row moved from index 3 to its current position (7)".

### 4. Insertion Marker

New rows get timestamp-only entry with empty changes on first save:

```json
{
  "h": [
    {
      "u": "dan",
      "t": 17400000000,
      "s": "web",
      "c": []
    }
  ],
  "i": 5
}
```

Empty `"c"` array indicates row creation timestamp.

### 5. Move Semantics

- Track moves based on internal `"i"` index (not array position)
- editHistory functions decouple from actual array index
- Moves recorded individually per row
- Minimal move algorithm: Record all rows where `editHistory.i ≠ actualIndex`
  - Optimization: If >50% of rows moved, flag as bulk reorder
  - Fallback: Accept recording more moves than theoretically minimal

## Implementation Phases

### Phase 1: Core Infrastructure (2-3 days)

#### 1.1 Update EditHistoryUtils (metadata-utils.js)

**Add move detection:**

```javascript
/**
 * Detect row moves by comparing stored index vs actual position
 * @param {Array<Object>} originalRows - Original data with editHistory
 * @param {Array<Object>} updatedRows - Current data after reordering
 * @returns {Map} Map of row → {movedFrom: number, movedTo: number}
 */
static detectRowMoves(originalRows, updatedRows) {
  const moves = new Map();

  // Build map of editHistory.i → original position
  const indexMap = new Map();
  originalRows.forEach((row, actualIdx) => {
    const eh = this.parseEditHistory(row.edithistory || row.EditHistory);
    if (eh && eh.i !== null && eh.i !== undefined) {
      indexMap.set(eh.i, actualIdx);
    }
  });

  // Check each updated row for movement
  updatedRows.forEach((row, newIdx) => {
    const eh = this.parseEditHistory(row.edithistory || row.EditHistory);
    if (eh && eh.i !== null && eh.i !== undefined) {
      if (eh.i !== newIdx) {
        moves.set(row, {movedFrom: eh.i, movedTo: newIdx});
      }
    }
  });

  return moves;
}

/**
 * Initialize editHistory for new rows (no history yet)
 * @param {string} username - User creating the row
 * @param {number} currentIndex - Row's current position
 * @param {string} source - Source system
 * @returns {string} New editHistory JSON
 */
static createInitialEditHistory(username, currentIndex, source = 'web') {
  const entry = {
    u: username ? username.split('@')[0] : 'unknown',
    t: Math.floor(Date.now() / 100),
    s: source,
    c: [] // Empty changes = creation marker
  };

  return JSON.stringify({
    h: [entry],
    i: currentIndex
  });
}

/**
 * Update editHistory index after move
 * @param {string|Object} edithistory - Existing editHistory
 * @param {number} newIndex - New position
 * @returns {string} Updated editHistory JSON
 */
static updateEditHistoryIndex(edithistory, newIndex) {
  const parsed = this.parseEditHistory(edithistory) || {h: []};
  parsed.i = newIndex;
  return JSON.stringify(parsed);
}
```

**Modify createEditHistoryEntry to support moves:**

```javascript
static createEditHistoryEntry(username, changes, source = 'web', movedFrom = null) {
  const shortUser = username ? username.split('@')[0] : 'unknown';

  const minimalChanges = changes.map(change => ({
    n: change.column,
    o: change.old
  }));

  // Add move entry if row moved
  if (movedFrom !== null && movedFrom !== undefined) {
    minimalChanges.push({m: movedFrom});
  }

  return {
    u: shortUser,
    t: Math.floor(new Date().getTime() / 100),
    s: source || 'web',
    c: minimalChanges
  };
}
```

#### 1.2 Update \_addMetadataToRows (database.js)

Replace index-based comparison with editHistory-aware logic:

```javascript
async function _addMetadataToRows(
  originalRows,
  updatedRows,
  username,
  mapping,
  source = "web",
) {
  if (!Array.isArray(updatedRows)) {
    return updatedRows;
  }

  // Detect moves using editHistory.i
  const moves = EditHistoryUtils.detectRowMoves(originalRows, updatedRows);

  return updatedRows.map((updatedRow, currentIndex) => {
    // Handle new rows (no editHistory)
    const ehKey = mapping.edithistory || "edithistory";
    const existingEH = updatedRow[ehKey];

    if (!existingEH || existingEH === "") {
      // New row - create initial editHistory with insertion marker
      const newEH = EditHistoryUtils.createInitialEditHistory(
        username,
        currentIndex,
        source,
      );
      return { ...updatedRow, [ehKey]: newEH };
    }

    // Find corresponding original row by editHistory.i
    const parsed = EditHistoryUtils.parseEditHistory(existingEH);
    const storedIndex = parsed?.i;
    const originalRow = originalRows.find((r) => {
      const origEH = EditHistoryUtils.parseEditHistory(r[ehKey]);
      return origEH?.i === storedIndex;
    });

    // Calculate field changes
    const changes = EditHistoryUtils.calculateRowDiff(originalRow, updatedRow);

    // Check if row moved
    const moveInfo = moves.get(updatedRow);
    const movedFrom = moveInfo ? moveInfo.movedFrom : null;

    // Create history entry if changes or move occurred
    if (changes.length > 0 || movedFrom !== null) {
      const metaEntry = EditHistoryUtils.createEditHistoryEntry(
        username,
        changes,
        source,
        movedFrom,
      );
      const newMetadata = EditHistoryUtils.appendToEditHistory(
        existingEH,
        metaEntry,
      );

      // Update index to current position
      const updatedMetadata = EditHistoryUtils.updateEditHistoryIndex(
        newMetadata,
        currentIndex,
      );

      return { ...updatedRow, [ehKey]: updatedMetadata };
    }

    // No changes or moves - just update index if needed
    if (storedIndex !== currentIndex) {
      const updatedMetadata = EditHistoryUtils.updateEditHistoryIndex(
        existingEH,
        currentIndex,
      );
      return { ...updatedRow, [ehKey]: updatedMetadata };
    }

    return updatedRow;
  });
}
```

#### 1.3 Update Database.setData signature

No changes needed - username already passed through options.

### Phase 2: Optimization (1-2 days)

#### 2.1 Bulk Move Detection

Add heuristic to detect mass reordering:

```javascript
static detectBulkReorder(moves, totalRows, threshold = 0.5) {
  const moveCount = moves.size;
  const moveRatio = moveCount / totalRows;

  return {
    isBulkReorder: moveRatio > threshold,
    moveCount,
    totalRows,
    ratio: moveRatio
  };
}
```

If bulk reorder detected, optionally add flag to history entry instead of individual moves.

#### 2.2 Combined Operations Handling

Ensure move + field change work together:

- Test: Move row 3→7 AND change quantity
- Test: Move row + delete (should be rare)
- Test: Sort operation (moves many rows)

### Phase 3: Documentation & Testing (1 day)

#### 3.1 Update metadata-implementation.md

Add section documenting:

- `"i"` field contract
- `{"m": previousIndex}` in changes array
- Insertion marker format (empty `"c"`)
- Examples of move-only vs combined entries

#### 3.2 Manual Testing Scenarios

- [ ] New row inserted → gets initial editHistory with `i` and empty `c`
- [ ] Row dragged from position 5 to 2 → gets `{"m": 5}` in changes
- [ ] Row moved AND field edited → both recorded in same entry
- [ ] Sort applied → multiple moves recorded
- [ ] Bulk reorder (50%+ rows) → threshold behavior
- [ ] Row with no editHistory saved → gets initialized

## EditHistory Format Extension

### Before (Current)

```json
{
  "h": [
    {
      "u": "dan",
      "t": 17309064000,
      "s": "web",
      "c": [{ "n": "quantity", "o": "5" }]
    }
  ]
}
```

### After (With Move Tracking)

```json
{
  "h": [
    {
      "u": "dan",
      "t": 17309064000,
      "s": "web",
      "c": [{ "n": "quantity", "o": "5" }, { "m": 3 }]
    }
  ],
  "i": 7
}
```

### New Row (Insertion)

```json
{
  "h": [
    {
      "u": "dan",
      "t": 17309064000,
      "s": "web",
      "c": []
    }
  ],
  "i": 5
}
```

## Risk Mitigation

### Critical Risks

1. **Performance on large tables**
   - **Mitigation**: Profile with 1000+ row tables
   - **Fallback**: Threshold-based bulk flagging

2. **Index consistency**
   - **Risk**: Concurrent saves could create index conflicts
   - **Mitigation**: Use timestamp as tiebreaker for reconstruction

3. **Backwards compatibility**
   - **Risk**: Existing rows without `"i"` field
   - **Mitigation**: Initialize on first save (graceful upgrade path)

### Moderate Risks

4. **Cache invalidation**
   - **Risk**: Modified editHistory might affect caching
   - **Mitigation**: Existing cache strategy already handles mutations

5. **Mass operations**
   - **Risk**: Sorting 1000-row table creates 1000 move entries
   - **Mitigation**: Bulk reorder detection (Phase 2)

## Success Criteria

- [ ] All new rows get initial editHistory on first save
- [ ] Row moves are detected and recorded accurately
- [ ] Combined move+change operations work correctly
- [ ] No performance regression on 500+ row tables
- [ ] Backwards compatible with existing editHistory data
- [ ] Documentation updated in metadata-implementation.md

## Future Work (Deferred)

- History reconstruction/restoration UI
- Optimized minimal move set algorithm
- Visual diff showing row movements
- Undo/redo integration with move operations
- Archive table for move history

## References

- Current implementation: `docs/js/data_management/utils/metadata-utils.js`
- Save logic: `docs/js/data_management/abstraction/database.js`
- Contract documentation: `docs/notes/metadata-implementation.md`
