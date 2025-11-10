# RPC Monitor Frontend Crash Fix

## Issue
The RPC monitor component was showing "Waiting for RPC metrics" briefly, then crashing (going blank).

## Root Cause
The component was accessing deeply nested properties without defensive checks, causing crashes when:
1. Initial metrics data arrived but was incomplete
2. Socket hadn't connected yet
3. Metrics object structure didn't match expectations

## Fixes Applied

### 1. Enhanced Error Handling in Socket Listener
```typescript
const handleMetrics = (data: RpcMetrics) => {
  try {
    if (data && data.overall) {
      setMetrics(data);
    }
  } catch (error) {
    console.error('Error handling RPC metrics:', error);
  }
};
```

### 2. Added Validation Check
```typescript
// Defensive checks
if (!metrics.overall || !metrics.byModule || !metrics.byMethod) {
  return (
    <CollapsibleSection title="RPC Monitor" storageKey="rpc-monitor:collapsed" className="mt-4">
      <div className="text-sm text-yellow-400">Invalid metrics data received</div>
    </CollapsibleSection>
  );
}
```

### 3. Safe Property Access with Fallbacks
All property accesses now use optional chaining and fallback values:

```typescript
// Before:
{metrics.overall.rps.avg1s.toFixed(1)}

// After:
{(metrics.overall?.rps?.avg1s || 0).toFixed(1)}
```

### 4. Safe Sorting with Defensive Checks
```typescript
// Before:
const sortedModules = Object.entries(metrics.byModule).sort((a, b) => b[1].count - a[1].count);

// After:
const sortedModules = Object.entries(metrics.byModule || {}).sort((a, b) => (b[1]?.count || 0) - (a[1]?.count || 0));
```

### 5. Safe Error Rendering
```typescript
// Check for errors array
{(!metrics.recentErrors || metrics.recentErrors.length === 0) ? (
  <div>No recent errors</div>
) : (
  (metrics.recentErrors || []).map((err, idx) => (
    // Safe access to error properties
    <div>{err?.method || 'unknown'}</div>
  ))
)}
```

## Files Modified
- `frontend/src/components/RpcMonitor.tsx` - Added defensive programming throughout

## Testing Checklist
- [ ] Component loads without crashing
- [ ] Shows "Waiting for RPC metrics..." when no data
- [ ] Shows "Invalid metrics data" if data is malformed
- [ ] Displays metrics correctly once data arrives
- [ ] All tabs work (Overview, Modules, Methods, Errors)
- [ ] No console errors
- [ ] Socket reconnection works properly

## Next Steps
1. Monitor browser console for any remaining errors
2. Verify socket connection is established (check Network tab)
3. Confirm backend is emitting `rpc-metrics` events every 2 seconds
4. Check that metrics data structure matches the TypeScript interface

## Debugging Commands
```javascript
// In browser console, check socket events:
socket.on('rpc-metrics', (data) => console.log('RPC metrics:', data));

// Check socket connection:
console.log('Socket connected:', socket.connected);

// Test metrics endpoint directly:
fetch('/api/system/rpc/metrics').then(r => r.json()).then(console.log);
```

