# Wallet Unwrap Transaction Fix

## Issue
The `wallet unwrap` terminal command was failing because the transaction was not being properly constructed and sent to the Solana network.

## Root Causes Identified

### 1. Missing Compute Budget Instructions
Both `wrapSol()` and `unwrapSol()` functions were missing compute budget instructions (priority fees), which are essential for transactions to be processed on Solana mainnet. Without these, transactions often fail or get dropped.

### 2. No Account Existence Check
The `unwrapSol()` function was calling `getOrCreateAssociatedTokenAccount()` which would create the account if it didn't exist, then immediately try to close it. This is problematic because:
- If the account doesn't exist, there's nothing to unwrap
- If the account exists but has zero balance, closing it is pointless
- Better to check first and provide clear error messages

### 3. Poor Error Handling
The route endpoint wasn't logging errors properly or providing clear feedback to the user.

## Changes Made

### File: `backend/src/wallet/wallet.ts`

#### 1. Enhanced `wrapSol()` function
```typescript
export async function wrapSol(amountSol: number): Promise<string> {
  const connection = getConnection();
  const kp = await ensureWallet(CONFIG.walletPath);
  const ata = await getOrCreateAssociatedTokenAccount(connection, kp, NATIVE_MINT, kp.publicKey);
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  const tx = new Transaction();
  
  // Add compute budget instructions (ADDED)
  try {
    const feeCalculator = getFeeCalculator(connection);
    const recommendation = feeCalculator.getFeeRecommendation('send');
    const calculatedFees = await feeCalculator.calculateFees({ ...CONFIG.fees, ...recommendation });
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: calculatedFees.priorityFee })
    );
  } catch (e) {
    logger.warn('wrapSol: failed to add compute budget, using defaults', { error: String(e) });
  }
  
  tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: ata.address, lamports }));
  tx.add(createSyncNativeInstruction(ata.address));
  // ... rest of function
}
```

**Changes:**
- ✅ Added compute budget instructions with priority fees
- ✅ Used fee calculator to get recommended fees
- ✅ Graceful fallback if fee calculation fails

#### 2. Completely Rewrote `unwrapSol()` function
```typescript
export async function unwrapSol(): Promise<string> {
  const connection = getConnection();
  const kp = await ensureWallet(CONFIG.walletPath);
  
  // Get the wSOL account address (CHANGED: no longer creates if doesn't exist)
  const wsolAddress = await getAssociatedTokenAddress(NATIVE_MINT, kp.publicKey);
  
  // Check if the account exists and has a balance (ADDED)
  let accountInfo;
  try {
    accountInfo = await withRpcLimit(
      () => getAccount(connection, wsolAddress),
      1,
      { module: 'wallet', method: 'getAccount' }
    );
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (msg.includes('could not find account') || msg.includes('Invalid param')) {
      throw new Error('No wSOL account found - nothing to unwrap');
    }
    throw e;
  }
  
  // Check if account has balance (ADDED)
  if (!accountInfo.amount || accountInfo.amount === 0n) {
    throw new Error('wSOL account has zero balance - nothing to unwrap');
  }
  
  // Log the operation (ADDED)
  logger.info('unwrapSol: closing wSOL account', { 
    address: wsolAddress.toBase58(), 
    balance: Number(accountInfo.amount) / LAMPORTS_PER_SOL 
  });
  
  const tx = new Transaction();
  
  // Add compute budget instructions (ADDED)
  try {
    const feeCalculator = getFeeCalculator(connection);
    const recommendation = feeCalculator.getFeeRecommendation('send');
    const calculatedFees = await feeCalculator.calculateFees({ ...CONFIG.fees, ...recommendation });
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: calculatedFees.priorityFee })
    );
  } catch (e) {
    logger.warn('unwrapSol: failed to add compute budget, using defaults', { error: String(e) });
  }
  
  // Close the wSOL account (this unwraps the SOL)
  tx.add(createCloseAccountInstruction(wsolAddress, kp.publicKey, kp.publicKey));
  
  // ... send and confirm transaction
  
  logger.info('unwrapSol: success', { signature: sig });
  return sig;
}
```

**Changes:**
- ✅ Uses `getAssociatedTokenAddress()` instead of `getOrCreateAssociatedTokenAccount()` (doesn't create account)
- ✅ Checks if account exists before attempting to close it
- ✅ Checks if account has a non-zero balance
- ✅ Provides clear error messages when account doesn't exist or has no balance
- ✅ Added compute budget instructions with priority fees
- ✅ Added logging for debugging and monitoring
- ✅ Shows the wSOL balance being unwrapped in logs

### File: `backend/src/server/routes/wallet.ts`

#### Enhanced error handling in `/wallet/unwrap` route
```typescript
api.post('/wallet/unwrap', async (_req, res) => {
  try {
    const { unwrapSol } = await import('../../wallet/wallet.js');
    const sig = await unwrapSol();
    emit('log', { level: 'info', message: `terminal: unwrap SOL success sig=${sig}`, timestamp: new Date().toLocaleTimeString() });
    res.json({ signature: sig });
  } catch (e: any) {
    const errMsg = String(e?.message || e);
    logger.error('wallet: unwrap failed', { error: errMsg, cat: 'wallet' });  // ADDED
    emit('log', { level: 'error', message: `terminal: unwrap SOL failed: ${errMsg}`, timestamp: new Date().toLocaleTimeString() });  // ADDED
    res.status(400).json({ error: errMsg });  // CHANGED from 500 to 400
  }
});
```

**Changes:**
- ✅ Added logger.error for server-side logging
- ✅ Emits error message to frontend via websocket
- ✅ Changed status code from 500 to 400 (client error, not server error)
- ✅ Provides clear error message to user in terminal

## Testing

### Test Cases

1. **Happy Path - Unwrap existing wSOL**
   ```bash
   # In terminal
   wallet unwrap
   ```
   Expected: Transaction succeeds, wSOL is converted to native SOL

2. **No wSOL Account**
   ```bash
   wallet unwrap
   ```
   Expected: Clear error message "No wSOL account found - nothing to unwrap"

3. **Zero Balance wSOL Account**
   ```bash
   wallet unwrap
   ```
   Expected: Clear error message "wSOL account has zero balance - nothing to unwrap"

4. **Wrap then Unwrap**
   ```bash
   wallet wrap 0.01
   # Wait for confirmation
   wallet unwrap
   ```
   Expected: Both transactions succeed

## Benefits

1. **Transactions Now Work**: Priority fees ensure transactions are processed
2. **Better UX**: Clear error messages when nothing to unwrap
3. **Cost Savings**: Won't create unnecessary accounts
4. **Observability**: Logging shows exactly what's happening
5. **Consistency**: Both wrap and unwrap now follow same pattern as other wallet operations

