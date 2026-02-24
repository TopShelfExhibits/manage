# Item Row Grouping Implementation Plan

## Approach

Store grouping relationships in the `MetaData` column using the `s` (settings) section. UI expansion state stays in `AppData`.

## Data Structure

```javascript
item.MetaData = {
  h: [], // history (empty - packlists skip change tracking)
  a: {}, // analytics cache
  s: {
    // settings - store grouping here
    grouping: {
      groupId: "G001",
      isGroupMaster: true,
      masterItemIndex: 0,
    },
  },
};
```

## Implementation Areas

### 1. **packlist-utils.js** - Data Layer

- Enable MetaData parsing in `getContent()`: Parse `MetaData` column as JSON when loading items
- Enable MetaData saving in `savePackList()`: Stringify MetaData and remove `skipMetadata: true`
- Add helper methods: `getGroupSettings()`, `setGroupSettings()`, `createItemGroup()`, `unlinkItemFromGroup()`

### 2. **PacklistTable.js** - UI Layer

- Filter visibility: `getVisibleItems()` - hide grouped items when master collapsed
- Toggle expansion: `toggleGroupExpansion()` - manage `AppData.groupExpanded` state
- Aggregate alerts: Show child alerts in master row when collapsed
- Unlink action: Button to remove item from group (edit mode)
- Group creation: Use row selection to create groups from selected items

### 3. **Template Changes**

- Add expand/collapse button (▶/▼) in Description column for master items
- Indent grouped items visually when expanded
- Show unlink button (⛓) for grouped items in edit mode
- Display aggregated alerts in master's "Packing/shop notes" when collapsed

### 4. **CSS Styling**

- `.group-toggle-button` - expand/collapse styling
- `.indented` - visual hierarchy for grouped items
- `.card.aggregated` - differentiate aggregated alerts

## Testing

- Test with existing packlists (no MetaData) - should work unchanged
- Test creating/unlinking groups - verify persistence after save/reload
- Test alert aggregation - ensure child alerts appear in master when collapsed
