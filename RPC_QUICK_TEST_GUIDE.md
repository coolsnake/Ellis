# RPC Monitoring - Quick Test Guide

## ✅ What We Fixed

**Problem:** All RPC metrics showing 0, wallet balances not loading  
**Solution:** Added context parameters to RPC calls so they're properly tracked

## 🧪 Quick Test (2 minutes)

### 1. Restart Backend
```bash
cd backend
npm start
```

### 2. Open Frontend
Open your Lockstone UI in browser

### 3. Check Wallet Balance
**Expected:** Balance loads within 5 seconds  
**If yes:** ✅ Fix worked!  
**If no:** See troubleshooting below

### 4. Check RPC Monitor
Scroll to bottom of logs → "RPC Monitor" panel

**You should see:**
- RPS: 5-20 req/s  
- Modules: wallet, drift, execution showing calls
- Methods: getBalance, getAccountInfo, etc.

## 📊 What to Look For

### Modules Tab
```
Module      Calls    Errors   p50      p95
wallet      523      2        85ms     320ms
drift       401      0        45ms     180ms
execution   85       3        250ms    890ms
alt         34       0        120ms    450ms
```

### Methods Tab
```
Method                             Calls   p50     Weight
getAccountInfo                     401     45ms    1.0
getParsedTokenAccountsByOwner      200     120ms   2.0
getBalance                         100     35ms    1.0
sendTransaction                    50      300ms   1.0
```

## ⚠️ Troubleshooting

### Wallet Still Not Loading?

**Check 1: Backend Logs**
```bash
# Look for errors
tail -20 backend/logs/*.log
```

**Check 2: Test RPC Endpoint**
```bash
# Should return JSON with metrics
curl http://localhost:3003/api/system/rpc/metrics | jq .
```

**Check 3: Browser Console**
F12 → Console tab → Look for errors

**Check 4: Socket Connection**
In browser console:
```javascript
// Should show "connected: true"
console.log('Socket:', socket?.connected);
```

### Metrics Show 0 but Wallet Loads?

This means RPC calls are working but not going through the instrumented path:
1. Restart the backend (it caches connections)
2. Clear browser cache
3. Hard refresh (Ctrl+Shift+R)

### Getting 429 Errors?

Check the Errors tab in RPC monitor:
- If you see many 429s, your RPC provider is rate limiting
- Solution: Reduce RPC_MAX_RPS in env config
- Or upgrade your RPC provider plan

## 📈 Expected Behavior

**Startup (0-10 seconds):**
- RPS: 0-5 req/s
- Modules: drift, wallet starting up

**Normal Operation (after 10s):**
- RPS: 5-15 req/s steady
- Success rate: >95%
- p95 latency: <500ms

**High Activity (trading):**
- RPS: 15-30 req/s
- Success rate: >90%
- p95 latency: <1000ms

## 🚨 Red Flags

**Bad:**
- Error rate >10%
- RPS consistently 0
- Queue depth >0 for extended periods
- p95 latency >5000ms

**Action:**
1. Check RPC provider health
2. Verify RPC_MAX_RPS matches your plan
3. Check network connectivity
4. Review Errors tab for specific issues

## ✨ Success Indicators

- ✅ Wallet balance shows up
- ✅ RPC monitor shows non-zero metrics  
- ✅ Module breakdown visible
- ✅ Success rate >95%
- ✅ No persistent errors

## 🎯 Next Steps

If everything works:
1. Monitor RPC metrics during normal usage
2. Adjust rate limits if needed
3. Track which modules use the most RPC calls
4. Optimize high-frequency calls if necessary

If something doesn't work:
1. Check the troubleshooting section
2. Review backend logs
3. Test RPC endpoint directly
4. Check RPC provider status page

## 📞 Need More Help?

Check these files:
- `RPC_FIX_COMPLETE_SUMMARY.md` - Detailed summary
- `RPC_CONTEXT_UPDATE_STATUS.md` - What was updated
- `backend/docs/RPC_MONITORING.md` - Full documentation

