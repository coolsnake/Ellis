#!/usr/bin/env tsx

/**
 * Analyze Meteora DLMM Pool State
 * 
 * This script fetches the actual pool state from the blockchain and shows
 * what accounts are referenced, so we can ensure our ALT manager collects them all.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getConnection } from '../src/wallet/wallet.js';

// The pool from your failed transaction
const POOL_ID = 'BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y';

// The uncovered accounts we need to identify
const UNCOVERED_ACCOUNTS = [
  'BzQsUBAbd21nrNDgc7D55EwnABC16uZJ41mgxxqYydHJ',
  'DwZz4S1Z1LBXomzmncQRVKCYhjCqSAMQ6RPKbUAadr7H',
  '4N22J4vW2juHocTntJNmXywSonYjkndCwahjZ2cYLDgb',
  'ETc6tqgLrr7wXsH8u2QBK1CyXHX3kvV6WQjBz4cf3sCj',
];

async function analyzeMeteoraPool() {
  console.log('🔍 Analyzing Meteora DLMM Pool State\n');
  console.log('═'.repeat(80));
  console.log(`Pool: ${POOL_ID}\n`);

  const connection = getConnection();
  const poolPk = new PublicKey(POOL_ID);

  // Fetch pool account info
  const poolInfo = await connection.getAccountInfo(poolPk);
  
  if (!poolInfo) {
    console.error('❌ Pool not found!');
    return;
  }

  console.log('✅ Pool found');
  console.log(`   Owner: ${poolInfo.owner.toBase58()}`);
  console.log(`   Data length: ${poolInfo.data.length} bytes\n`);

  const programId = poolInfo.owner;

  // Try to import Meteora SDK
  let DLMM: any = null;
  try {
    const meteoraModule = await import('@meteora-ag/dlmm');
    DLMM = (meteoraModule as any).DLMM || meteoraModule;
    console.log('✅ Meteora SDK loaded\n');
  } catch (err) {
    console.error('❌ Failed to load Meteora SDK:', err);
    DLMM = null;
  }

  console.log('─'.repeat(80));
  console.log('📊 Raw Pool State Analysis\n');

  // Parse pool data manually to understand structure
  const data = poolInfo.data;
  
  console.log('Attempting to extract public keys from pool data...\n');

  // Common offsets for Meteora DLMM pool structure (based on known layouts)
  const possibleOffsets = [
    { name: 'parameters', offset: 8, desc: 'Parameters struct' },
    { name: 'vFlags', offset: 40, desc: 'Various flags' },
    { name: 'tokenXMint', offset: 72, desc: 'Token X mint address' },
    { name: 'tokenYMint', offset: 104, desc: 'Token Y mint address' },
    { name: 'reserveX', offset: 136, desc: 'Reserve X (vault)' },
    { name: 'reserveY', offset: 168, desc: 'Reserve Y (vault)' },
    { name: 'oracle', offset: 200, desc: 'Oracle account' },
    { name: 'binStep', offset: 232, desc: 'Bin step (u16)' },
    { name: 'activeId', offset: 240, desc: 'Active bin ID (i32)' },
  ];

  const extractedAccounts = new Map<string, { name: string; desc: string }>();

  for (const { name, offset, desc } of possibleOffsets) {
    try {
      if (offset + 32 <= data.length) {
        const pubkeyBytes = data.slice(offset, offset + 32);
        const pubkey = new PublicKey(pubkeyBytes);
        const addr = pubkey.toBase58();
        
        // Filter out zero addresses and unlikely addresses
        if (addr !== '11111111111111111111111111111111' && !addr.startsWith('1111')) {
          extractedAccounts.set(addr, { name, desc });
          
          // Check if this is one of our uncovered accounts
          const isUncovered = UNCOVERED_ACCOUNTS.includes(addr);
          const marker = isUncovered ? '🎯' : '  ';
          
          console.log(`${marker} ${name.padEnd(15)} @ offset ${offset.toString().padStart(3)}: ${addr}`);
          console.log(`   ${desc}`);
          
          if (isUncovered) {
            console.log('   ⭐ THIS IS ONE OF THE UNCOVERED ACCOUNTS!');
          }
          console.log();
        }
      }
    } catch (err) {
      // Not a valid public key at this offset
    }
  }

  // Try to read numeric fields
  console.log('─'.repeat(80));
  console.log('🔢 Numeric Fields\n');
  
  try {
    const binStep = data.readUInt16LE(176);
    console.log(`Bin Step: ${binStep}`);
  } catch {}
  
  try {
    const activeId = data.readInt32LE(180);
    console.log(`Active ID: ${activeId}\n`);
  } catch {}

  // Now try using SDK to derive accounts
  console.log('─'.repeat(80));
  console.log('🔧 SDK-Derived Accounts\n');

  if (DLMM) {
    // Derive reserves using SDK
    const deriveReserve = DLMM?.deriveReserve;
    if (typeof deriveReserve === 'function') {
      try {
        const rxResult = await deriveReserve(programId, poolPk, true);
        const reserveX = rxResult?.publicKey || rxResult;
        const rxAddr = reserveX.toBase58();
        console.log(`Reserve X (SDK): ${rxAddr}`);
        if (UNCOVERED_ACCOUNTS.includes(rxAddr)) {
          console.log('   🎯 UNCOVERED ACCOUNT!');
        }
        if (extractedAccounts.has(rxAddr)) {
          console.log(`   ✅ Matches extracted account: ${extractedAccounts.get(rxAddr)?.name}`);
        } else {
          console.log('   ⚠️  Does NOT match any extracted account!');
        }
        console.log();
      } catch (err) {
        console.error('Failed to derive reserve X:', err);
      }

      try {
        const ryResult = await deriveReserve(programId, poolPk, false);
        const reserveY = ryResult?.publicKey || ryResult;
        const ryAddr = reserveY.toBase58();
        console.log(`Reserve Y (SDK): ${ryAddr}`);
        if (UNCOVERED_ACCOUNTS.includes(ryAddr)) {
          console.log('   🎯 UNCOVERED ACCOUNT!');
        }
        if (extractedAccounts.has(ryAddr)) {
          console.log(`   ✅ Matches extracted account: ${extractedAccounts.get(ryAddr)?.name}`);
        } else {
          console.log('   ⚠️  Does NOT match any extracted account!');
        }
        console.log();
      } catch (err) {
        console.error('Failed to derive reserve Y:', err);
      }
    }

    // Derive oracle using SDK
    const deriveOracle = DLMM?.deriveOracle;
    if (typeof deriveOracle === 'function') {
      try {
        const oracleResult = await deriveOracle(programId, poolPk);
        const oracle = oracleResult?.publicKey || oracleResult;
        const oracleAddr = oracle.toBase58();
        console.log(`Oracle (SDK): ${oracleAddr}`);
        if (UNCOVERED_ACCOUNTS.includes(oracleAddr)) {
          console.log('   🎯 UNCOVERED ACCOUNT!');
        }
        if (extractedAccounts.has(oracleAddr)) {
          console.log(`   ✅ Matches extracted account: ${extractedAccounts.get(oracleAddr)?.name}`);
        } else {
          console.log('   ⚠️  Does NOT match any extracted account!');
        }
        console.log();
      } catch (err) {
        console.error('Failed to derive oracle:', err);
      }
    }
  }

  // Derive bitmap extension (PDA)
  console.log('─'.repeat(80));
  console.log('📋 Bitmap Extension (PDA)\n');
  
  try {
    const [bitmapExt] = PublicKey.findProgramAddressSync(
      [Buffer.from('bitmap_extension'), poolPk.toBuffer()],
      programId
    );
    const bitmapAddr = bitmapExt.toBase58();
    console.log(`Bitmap Extension: ${bitmapAddr}`);
    
    // Check if it exists
    const bitmapInfo = await connection.getAccountInfo(bitmapExt);
    if (bitmapInfo) {
      console.log('   ✅ Exists on-chain');
      console.log(`   Data length: ${bitmapInfo.data.length} bytes`);
      if (UNCOVERED_ACCOUNTS.includes(bitmapAddr)) {
        console.log('   🎯 UNCOVERED ACCOUNT!');
      }
    } else {
      console.log('   ❌ Does not exist on-chain');
    }
    console.log();
  } catch (err) {
    console.error('Failed to derive bitmap extension:', err);
  }

  // Summary
  console.log('═'.repeat(80));
  console.log('📋 Summary\n');

  console.log('Uncovered accounts analysis:');
  for (const addr of UNCOVERED_ACCOUNTS) {
    console.log(`\n${addr}`);
    
    if (extractedAccounts.has(addr)) {
      const { name, desc } = extractedAccounts.get(addr)!;
      console.log(`  ✅ Found in pool state as: ${name} (${desc})`);
    } else {
      console.log(`  ❓ Not found in pool state - checking if it's a derived account...`);
      
      // Check what kind of account it might be
      const accountInfo = await connection.getAccountInfo(new PublicKey(addr));
      if (accountInfo) {
        console.log(`     Owner: ${accountInfo.owner.toBase58()}`);
        console.log(`     Data: ${accountInfo.data.length} bytes`);
        
        if (accountInfo.owner.toBase58() === programId.toBase58()) {
          console.log('     ✅ Owned by Meteora program');
          
          // Try to determine account type by discriminator
          if (accountInfo.data.length >= 8) {
            const discriminator = accountInfo.data.slice(0, 8);
            console.log(`     Discriminator: ${discriminator.toString('hex')}`);
          }
        } else {
          console.log('     ⚠️  Owned by different program');
        }
      } else {
        console.log('     ❌ Account does not exist');
      }
    }
  }

  console.log('\n' + '═'.repeat(80));
  console.log('✅ Analysis complete!\n');
}

analyzeMeteoraPool().catch(console.error);

