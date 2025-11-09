#!/usr/bin/env tsx

/**
 * Debug ALT Coverage Script
 * 
 * This script helps analyze which accounts are covered by your ALTs
 * and identify gaps in coverage that might cause transaction size issues.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../src/config.js';
import { dexAltManager } from '../src/execution/utils/altManager.js';
import { getConnection } from '../src/wallet/wallet.js';

interface ALTInfo {
  category: string;
  address: string;
  accountCount: number;
  accounts: string[];
}

async function loadALTDetails(): Promise<ALTInfo[]> {
  const connection = getConnection();
  const altAddresses = dexAltManager.getAllAltAddresses();
  const altDetails: ALTInfo[] = [];
  
  console.log(`\n📋 Found ${altAddresses.length} ALT addresses configured\n`);
  
  for (const altAddr of altAddresses) {
    try {
      const pk = new PublicKey(altAddr);
      const result = await connection.getAddressLookupTable(pk);
      
      if (result.value) {
        const alt = result.value;
        const accounts = alt.state.addresses.map(addr => addr.toBase58());
        
        // Try to determine the category from the manager
        let category = 'unknown';
        try {
          const manager = dexAltManager as any;
          for (const [key, value] of manager.altAddresses.entries()) {
            if (value.toBase58() === altAddr) {
              category = key;
              break;
            }
          }
        } catch {}
        
        altDetails.push({
          category,
          address: altAddr,
          accountCount: accounts.length,
          accounts,
        });
        
        console.log(`✅ ${category} ALT: ${altAddr}`);
        console.log(`   Accounts: ${accounts.length}`);
      } else {
        console.log(`❌ Failed to load ALT: ${altAddr} (not found)`);
      }
    } catch (err) {
      console.error(`❌ Error loading ALT ${altAddr}:`, err);
    }
  }
  
  return altDetails;
}

function findAccountCategory(account: string, altDetails: ALTInfo[]): string[] {
  const categories: string[] = [];
  
  for (const alt of altDetails) {
    if (alt.accounts.includes(account)) {
      categories.push(alt.category);
    }
  }
  
  return categories;
}

async function analyzeCommonAccounts(altDetails: ALTInfo[]) {
  console.log('\n\n📊 Analyzing Common Accounts\n');
  console.log('─'.repeat(80));
  
  // Known program IDs
  const knownPrograms = {
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': 'Token Program',
    '11111111111111111111111111111111': 'System Program',
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL': 'Associated Token Program',
    'ComputeBudget111111111111111111111111111111': 'Compute Budget Program',
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpool',
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium CLMM',
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'Meteora DLMM',
    'So11111111111111111111111111111111111111112': 'SOL (Wrapped)',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
  };
  
  console.log('\nCommon Programs/Tokens:');
  for (const [addr, name] of Object.entries(knownPrograms)) {
    const categories = findAccountCategory(addr, altDetails);
    const status = categories.length > 0 ? '✅' : '❌';
    const catStr = categories.length > 0 ? categories.join(', ') : 'NOT IN ALT';
    console.log(`${status} ${name.padEnd(30)} [${catStr}]`);
  }
}

async function analyzeDEXPoolAccounts(altDetails: ALTInfo[]) {
  console.log('\n\n🏊 DEX Pool Account Summary\n');
  console.log('─'.repeat(80));
  
  const dexCategories = ['raydium-clmm', 'meteora-dlmm', 'orca-whirlpool', 'raydium-amm'];
  
  for (const category of dexCategories) {
    const alt = altDetails.find(a => a.category === category);
    
    if (alt) {
      console.log(`\n${category}:`);
      console.log(`  Total Accounts: ${alt.accountCount}`);
      console.log(`  ALT Address: ${alt.address}`);
      
      // Estimate pools (rough estimate: 6-8 accounts per pool)
      const estimatedPools = Math.floor(alt.accountCount / 7);
      console.log(`  Estimated Pools: ~${estimatedPools}`);
      
      // Show sample accounts
      if (alt.accounts.length > 0) {
        console.log(`  Sample accounts (first 3):`);
        alt.accounts.slice(0, 3).forEach(acc => {
          console.log(`    - ${acc}`);
        });
      }
    } else {
      console.log(`\n${category}: ❌ NOT CONFIGURED`);
    }
  }
}

function generateRecommendations(altDetails: ALTInfo[]) {
  console.log('\n\n💡 Recommendations\n');
  console.log('─'.repeat(80));
  
  const totalAccounts = altDetails.reduce((sum, alt) => sum + alt.accountCount, 0);
  console.log(`\n✓ Total ALT accounts: ${totalAccounts}`);
  console.log(`✓ Total ALTs: ${altDetails.length}`);
  
  // Check for common ALT
  const hasCommonAlt = altDetails.some(alt => alt.category === 'common');
  if (hasCommonAlt) {
    console.log('✓ Common ALT configured');
  } else {
    console.log('⚠️  WARNING: No common ALT found');
    console.log('   Create a common ALT with system programs and common token mints');
  }
  
  // Check for DEX ALTs
  const dexCategories = ['raydium-clmm', 'meteora-dlmm', 'orca-whirlpool'];
  const missingDexes: string[] = [];
  
  for (const dex of dexCategories) {
    if (!altDetails.some(alt => alt.category === dex)) {
      missingDexes.push(dex);
    }
  }
  
  if (missingDexes.length > 0) {
    console.log(`\n⚠️  WARNING: Missing DEX ALTs: ${missingDexes.join(', ')}`);
    console.log('   Create these ALTs to improve transaction size');
  }
  
  // Check account density
  for (const alt of altDetails) {
    if (alt.accountCount < 10 && alt.category !== 'common') {
      console.log(`\n⚠️  ${alt.category} has only ${alt.accountCount} accounts`);
      console.log('   Consider adding more pool accounts to this ALT');
    }
  }
  
  console.log('\n\n📝 Next Steps:\n');
  console.log('1. Run your transaction test again and check the logs for:');
  console.log('   - tx.alt.coverage.analysis - shows coverage percentage');
  console.log('   - tx.alt.coverage.poor - lists uncovered accounts');
  console.log('   - tx.serialize.success - shows actual transaction size');
  console.log('\n2. If coverage is low (<70%), you need to add more accounts to your ALTs');
  console.log('   especially the accounts shown in "uncoveredSample"');
  console.log('\n3. Dynamic accounts (tick arrays, bin arrays) cannot be pre-loaded');
  console.log('   These will always take up space in the transaction');
}

async function main() {
  console.log('🔍 ALT Coverage Debug Tool\n');
  console.log('═'.repeat(80));
  
  try {
    // Initialize ALT manager
    await dexAltManager.initialize();
    
    // Load all ALT details
    const altDetails = await loadALTDetails();
    
    if (altDetails.length === 0) {
      console.log('\n❌ No ALTs found!');
      console.log('\nYou need to create ALTs first. See:');
      console.log('  backend/docs/ALT_MANAGER_GUIDE.md');
      process.exit(1);
    }
    
    // Analyze common accounts
    await analyzeCommonAccounts(altDetails);
    
    // Analyze DEX pools
    await analyzeDEXPoolAccounts(altDetails);
    
    // Generate recommendations
    generateRecommendations(altDetails);
    
    console.log('\n' + '═'.repeat(80));
    console.log('✅ Analysis complete!\n');
    
  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  }
}

main();

