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

  // ⚠️ WARNING: These binary offsets are UNRELIABLE and may return garbage values!
  // Testing confirmed that SDK decode (program.coder.accounts.decode('lbPair', data))
  // is the ONLY reliable method. These offsets are kept for historical reference only.
  // See: backend/docs/METEORA_DIRECT_ACTIVEID_READ.md
  const possibleOffsets = [
    { name: 'parameters', offset: 8, desc: 'Parameters struct' },
    { name: 'vFlags', offset: 40, desc: 'Various flags' },
    { name: 'tokenXMint', offset: 72, desc: 'Token X mint address' },
    { name: 'tokenYMint', offset: 104, desc: 'Token Y mint address' },
    { name: 'reserveX', offset: 136, desc: 'Reserve X (vault)' },
    { name: 'reserveY', offset: 168, desc: 'Reserve Y (vault)' },
    { name: 'oracle', offset: 200, desc: 'Oracle account' },
    { name: 'binStep', offset: 232, desc: 'Bin step (u16) - ⚠️ UNRELIABLE' },
    { name: 'activeId', offset: 240, desc: 'Active bin ID (i32) - ⚠️ UNRELIABLE' },
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

  // Try to read numeric fields using legacy binary offsets
  // ⚠️ WARNING: These values are UNRELIABLE! Use SDK decode instead.
  console.log('─'.repeat(80));
  console.log('🔢 Numeric Fields (⚠️ BINARY OFFSETS - UNRELIABLE)\n');
  
  try {
    const binStep176 = data.readUInt16LE(176);
    const binStep232 = data.readUInt16LE(232);
    console.log(`Bin Step (offset 176): ${binStep176} ⚠️`);
    console.log(`Bin Step (offset 232): ${binStep232} ⚠️`);
  } catch {}
  
  try {
    const activeId180 = data.readInt32LE(180);
    const activeId240 = data.readInt32LE(240);
    console.log(`Active ID (offset 180): ${activeId180} ⚠️`);
    console.log(`Active ID (offset 240): ${activeId240} ⚠️`);
    console.log('\n⚠️ These binary offset values may be WRONG! Use SDK decode for reliable values.\n');
  } catch {}

  // Now try using SDK to derive accounts (with better error handling)
  console.log('─'.repeat(80));
  console.log('🔧 SDK-Derived Accounts\n');

  if (DLMM) {
    // Derive reserves using SDK
    const deriveReserve = DLMM?.deriveReserve;
    if (typeof deriveReserve === 'function') {
      try {
        // Ensure programId is a proper PublicKey
        const programIdPk = programId instanceof PublicKey ? programId : new PublicKey(programId);
        const rxResult = await deriveReserve(programIdPk, poolPk, true);
        let reserveX = rxResult?.publicKey || rxResult;
        // Handle different return types
        if (!(reserveX instanceof PublicKey)) {
          reserveX = new PublicKey(reserveX);
        }
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
      } catch (err: any) {
        console.log(`   ⚠️  SDK derive failed: ${err.message || err}`);
        console.log('   (This is OK - we\'ll use pool state data directly)\n');
      }

      try {
        const programIdPk = programId instanceof PublicKey ? programId : new PublicKey(programId);
        const ryResult = await deriveReserve(programIdPk, poolPk, false);
        let reserveY = ryResult?.publicKey || ryResult;
        if (!(reserveY instanceof PublicKey)) {
          reserveY = new PublicKey(reserveY);
        }
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
      } catch (err: any) {
        console.log(`   ⚠️  SDK derive failed: ${err.message || err}`);
        console.log('   (This is OK - we\'ll use pool state data directly)\n');
      }
    }

    // Derive oracle using SDK
    const deriveOracle = DLMM?.deriveOracle;
    if (typeof deriveOracle === 'function') {
      try {
        const programIdPk = programId instanceof PublicKey ? programId : new PublicKey(programId);
        const oracleResult = await deriveOracle(programIdPk, poolPk);
        let oracle = oracleResult?.publicKey || oracleResult;
        if (oracle && typeof oracle === 'object' && 'toBase58' in oracle) {
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
        } else {
          console.log('   ⚠️  Oracle result is not a PublicKey');
        }
      } catch (err: any) {
        console.log(`   ⚠️  SDK derive failed: ${err.message || err}`);
        console.log('   (This is OK - we\'ll use pool state data directly)\n');
      }
    }
  }

  // Derive bitmap extension (PDA)
  console.log('─'.repeat(80));
  console.log('📋 Bitmap Extension (PDA)\n');
  
  try {
    const [bitmapExt] = PublicKey.findProgramAddressSync(
      [Buffer.from('BitmapExtension'), poolPk.toBuffer()],
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

  // Deep dive into reserve accounts
  console.log('─'.repeat(80));
  console.log('🔎 Reserve Accounts Deep Dive\n');

  // Extract reserves from pool state
  const reservesFromPoolState: string[] = [];
  if (extractedAccounts.has('CxoLXAkNEexLHK5ukudpfTgmVRChnBjhrzv8CGcQ3FrQ')) {
    reservesFromPoolState.push('CxoLXAkNEexLHK5ukudpfTgmVRChnBjhrzv8CGcQ3FrQ');
  }
  if (extractedAccounts.has('GgP2rf1Bcm2yZdGdMSVEHjo1uHWWyPvhEYfe4QpiLKao')) {
    reservesFromPoolState.push('GgP2rf1Bcm2yZdGdMSVEHjo1uHWWyPvhEYfe4QpiLKao');
  }
  
  // Get reserves from pool state at known offsets
  try {
    if (data.length >= 200) {
      const reserveXBytes = data.slice(136, 168);
      const reserveYBytes = data.slice(168, 200);
      
      const reserveX = new PublicKey(reserveXBytes);
      const reserveY = new PublicKey(reserveYBytes);
      
      console.log('Reserves from pool state (offsets 136 & 168):');
      console.log(`  Reserve X: ${reserveX.toBase58()}`);
      console.log(`  Reserve Y: ${reserveY.toBase58()}\n`);
      
      // Check what these accounts actually are
      for (const [label, addr] of [['Reserve X', reserveX], ['Reserve Y', reserveY]]) {
        const info = await connection.getAccountInfo(addr);
        if (info) {
          console.log(`${label} account info:`);
          console.log(`  Owner: ${info.owner.toBase58()}`);
          console.log(`  Size: ${info.data.length} bytes`);
          
          if (info.owner.toBase58() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
            console.log('  ✅ This is a Token Program account (token vault)');
            if (info.data.length >= 32) {
              const mint = new PublicKey(info.data.slice(0, 32));
              console.log(`  Mint: ${mint.toBase58()}`);
              
              // Check if this is one of our uncovered accounts
              if (UNCOVERED_ACCOUNTS.includes(addr.toBase58())) {
                console.log('  🎯 THIS IS ONE OF THE UNCOVERED ACCOUNTS!');
              }
            }
          } else if (info.owner.toBase58() === programId.toBase58()) {
            console.log('  ⚠️  This is a Meteora program account (not a token vault)');
            if (info.data.length >= 8) {
              const discriminator = info.data.slice(0, 8);
              console.log(`  Discriminator: ${discriminator.toString('hex')}`);
            }
          }
          console.log();
        } else {
          console.log(`${label}: Does not exist\n`);
        }
      }
    }
  } catch (err: any) {
    console.log(`Error checking reserves: ${err.message}\n`);
  }

  // Reverse-engineer the PDA derivation for actual vaults
  console.log('─'.repeat(80));
  console.log('🔧 Reverse-Engineering Vault PDA Derivation\n');

  // Get mints from pool state
  let tokenXMint: PublicKey | null = null;
  let tokenYMint: PublicKey | null = null;
  
  try {
    if (data.length >= 136) {
      tokenXMint = new PublicKey(data.slice(72, 104));
      tokenYMint = new PublicKey(data.slice(104, 136));
      console.log(`Token X Mint: ${tokenXMint.toBase58()}`);
      console.log(`Token Y Mint: ${tokenYMint.toBase58()}\n`);
    }
  } catch {}

  // The actual vaults used in transactions (from our uncovered accounts)
  const actualVaults = [
    { addr: 'DwZz4S1Z1LBXomzmncQRVKCYhjCqSAMQ6RPKbUAadr7H', name: 'Vault 1' },
    { addr: '4N22J4vW2juHocTntJNmXywSonYjkndCwahjZ2cYLDgb', name: 'Vault 2' }
  ];

  // Try common PDA seeds used in Solana programs
  const possibleSeeds = [
    'token_vault',
    'vault',
    'reserve',
    'token_reserve',
    'lb_pair_vault',
    'liquidity_vault',
    'pool_vault',
  ];

  for (const vault of actualVaults) {
    console.log(`\n${vault.name}: ${vault.addr}`);
    
    const vaultPk = new PublicKey(vault.addr);
    
    // Check what mint this vault holds
    const vaultInfo = await connection.getAccountInfo(vaultPk);
    let vaultMint: PublicKey | null = null;
    if (vaultInfo && vaultInfo.data.length >= 32) {
      vaultMint = new PublicKey(vaultInfo.data.slice(0, 32));
      console.log(`  Holds mint: ${vaultMint.toBase58()}`);
      
      // Determine if it's tokenX or tokenY
      if (tokenXMint && vaultMint.equals(tokenXMint)) {
        console.log('  → This is the Token X vault');
      } else if (tokenYMint && vaultMint.equals(tokenYMint)) {
        console.log('  → This is the Token Y vault');
      }
    }
    
    let found = false;
    
    // Try different seed combinations
    if (vaultMint) {
      for (const seed of possibleSeeds) {
        try {
          const [derived, bump] = PublicKey.findProgramAddressSync(
            [Buffer.from(seed), poolPk.toBuffer(), vaultMint.toBuffer()],
            programId
          );
          
          if (derived.equals(vaultPk)) {
            console.log(`  ✅ FOUND PDA DERIVATION!`);
            console.log(`     Seeds: ["${seed}", pool, mint]`);
            console.log(`     Bump: ${bump}`);
            found = true;
            break;
          }
        } catch {}
      }
      
      // Try without text seed (just pool + mint)
      if (!found) {
        try {
          const [derived, bump] = PublicKey.findProgramAddressSync(
            [poolPk.toBuffer(), vaultMint.toBuffer()],
            programId
          );
          
          if (derived.equals(vaultPk)) {
            console.log(`  ✅ FOUND PDA DERIVATION!`);
            console.log(`     Seeds: [pool, mint]`);
            console.log(`     Bump: ${bump}`);
            found = true;
          }
        } catch {}
      }
      
      // Try with mint first
      if (!found) {
        try {
          const [derived, bump] = PublicKey.findProgramAddressSync(
            [vaultMint.toBuffer(), poolPk.toBuffer()],
            programId
          );
          
          if (derived.equals(vaultPk)) {
            console.log(`  ✅ FOUND PDA DERIVATION!`);
            console.log(`     Seeds: [mint, pool]`);
            console.log(`     Bump: ${bump}`);
            found = true;
          }
        } catch {}
      }
    }
    
    if (!found) {
      console.log(`  ❌ Could not determine PDA derivation`);
      console.log(`     This vault might not be a PDA, or uses different seeds`);
    }
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
            
            // Common discriminators
            if (discriminator.toString('hex') === '506f7c7137ed1205') {
              console.log('     💡 Likely: Event Authority or Bin Array Bitmap Extension');
            } else if (discriminator.toString('hex') === '8bc283b38cb3e5f4') {
              console.log('     💡 Likely: Oracle or Event Account');
            }
          }
        } else if (accountInfo.owner.toBase58() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
          console.log('     ✅ Token Program account (Token Vault)');
          if (accountInfo.data.length >= 32) {
            const mint = new PublicKey(accountInfo.data.slice(0, 32));
            console.log(`     Mint: ${mint.toBase58()}`);
          }
          console.log('     💡 This is a REAL token vault - should be in ALT!');
        } else {
          console.log('     ⚠️  Owned by different program');
        }
      } else {
        console.log('     ❌ Account does not exist');
      }
    }
  }

  console.log('\n' + '═'.repeat(80));
  console.log('🎯 CONCLUSION\n');
  console.log('The reserves in the pool state data (offsets 136 & 168) should point to');
  console.log('the actual token vaults. We need to verify if they match the uncovered accounts.');
  console.log('\nIf the reserves in pool state ARE the uncovered accounts, then our ALT');
  console.log('manager is working correctly and we just need to add the event/oracle accounts.');
  console.log('\n' + '═'.repeat(80));
  console.log('✅ Analysis complete!\n');
}

analyzeMeteoraPool().catch(console.error);

