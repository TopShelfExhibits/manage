# JSON Path Segment Implementation

## Overview

The navigation system now uses **JSON path segments** instead of URL query parameters for better readability. Parameters are embedded directly in the hash path as unencoded JSON objects.

## URL Format

### New Format (JSON Path Segments)

```
http://domain.com/docs/#schedule?{"dateFilter":"0,30","textFilters":[{"column":"Elec","value":"g"}],"byShowDate":false}
```

### Old Format (Query Parameters) - Still Supported for Backwards Compatibility

```
http://domain.com/docs/#schedule?scheduleFilter=%7B%22dateFilter%22%3A%220%2C30%22%2C%22textFilters%22%3A%5B%7B%22column%22%3A%22Elec%22%2C%22value%22%3A%22g%22%7D%5D%2C%22byShowDate%22%3Afalse%7D
```

## Benefits

1. **Human Readable**: JSON is directly visible in URLs without encoding
2. **Shareable**: Easy to copy/paste and read URLs
3. **Debuggable**: Parameters are immediately visible in browser address bar
4. **Standard JSON**: Can be copied directly from URLs and parsed in any JSON tool

## Example URLs

### Schedule Page - Year Filter (by Show Date)

```
#schedule?{"dateFilter":"2024-01-01,2024-12-31","byShowDate":true}
```

### Schedule Page - Overlap Filter with Text Search

```
#schedule?{"dateFilter":"ACME 2024 Tech Expo","textFilters":[{"column":"Status","value":"Confirmed"}],"byShowDate":false}
```

### Schedule Page - Date Range with Multiple Text Filters

```
#schedule?{"dateFilter":"0,30","textFilters":[{"column":"Elec","value":"g"},{"column":"Client","value":"ACME"}],"byShowDate":false}
```

### Schedule Page - Show All

```
#schedule?{"view":"all"}
```

### Inventory Page - Search by Item ID

```
#inventory/categories/props?{"searchTerm":"PROP-001"}
```

## Implementation Details

### NavigationRegistry Changes

Added two new utility methods:

#### `parseJsonPathSegment(jsonString)`

Extracts and parses JSON from parameter string:

```javascript
parseJsonPathSegment('{"dateFilter":"0,30"}');
// Returns: { dateFilter: "0,30" }
```

#### `buildJsonPathSegment(parameters)`

Builds JSON string from parameters object:

```javascript
buildJsonPathSegment({ dateFilter: "0,30", byShowDate: false });
// Returns: '{"dateFilter":"0,30","byShowDate":false}'
```

### Updated `parsePath(path)`

Now looks for JSON segment after `?` delimiter:

1. Splits path on `?` to separate route from parameters
2. Checks if parameter part is JSON (starts with `{` or `[`)
3. Parses JSON if found
4. Falls back to old query string format for backwards compatibility

### Updated `buildPath(path, parameters)`

Now creates JSON path segments:

1. Merges existing parameters with new ones
2. Builds JSON string using `buildJsonPathSegment`
3. Returns path with JSON segment appended

## Component Usage

All components now use standard NavigationRegistry methods:

### Setting Parameters

```javascript
// Build path with parameters
const path = NavigationRegistry.buildPath("schedule", {
  dateFilter: "2024-01-01,2024-12-31",
  byShowDate: true,
});
// Result: 'schedule?{"dateFilter":"2024-01-01,2024-12-31","byShowDate":true}'

// Navigate to path
this.navigateToPath(path);
```

### Reading Parameters

```javascript
// Get parameters from current path
const params = NavigationRegistry.getNavigationParameters(
  this.appContext.currentPath
);
// Returns: { dateFilter: "2024-01-01,2024-12-31", byShowDate: true }

// Access specific parameters
if (params.dateFilter) {
  // Use dateFilter value
}
```

## Backwards Compatibility

The system maintains backwards compatibility with old query parameter URLs:

- Old URLs with `?scheduleFilter=...` are automatically parsed
- Components work with both formats
- Gradual migration as users navigate and create new URLs

## Migration Notes

### Removed Functions

- `parseScheduleFilter()` - No longer needed (use `NavigationRegistry.getNavigationParameters()`)
- `buildScheduleFilter()` - No longer needed (use `NavigationRegistry.buildPath()`)

### Updated Components

- `ScheduleAdvancedFilter.js` - Uses NavigationRegistry methods directly
- `ScheduleFilterSelect.js` - Uses NavigationRegistry methods directly
- All other components already used NavigationRegistry properly

## Technical Considerations

### Why JSON Path Segments Work

1. **Hash Fragment Scope**: Content after `#` isn't URL-encoded by browsers
2. **Direct JSON**: JSON objects can be embedded directly without encoding
3. **Browser Compatibility**: All modern browsers handle this correctly
4. **No Server Impact**: Hash fragments aren't sent to servers (client-only routing)

### Limitations

- **URL Length**: Very long parameter lists might hit browser URL length limits (2000+ chars)
- **Special Characters**: Some special characters in values might need escaping
- **Sharing**: URLs are readable but might be long for complex filters

### Best Practices

1. Keep parameter names short but descriptive
2. Use arrays for lists of values (e.g., `textFilters`)
3. Only include necessary parameters (omit defaults)
4. Test URLs by copying/pasting to verify JSON validity
