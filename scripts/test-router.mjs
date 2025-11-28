#!/usr/bin/env node
/**
 * Integration test script for the arb-router program
 * 
 * Usage:
 *   node scripts/test-router.mjs
 * 
 * Prerequisites:
 *   - Solana CLI configured with devnet
 *   - Backend server running
 *   - Wallet funded with devnet SOL
 */

import fetch from 'node-fetch';

const API_BASE = process.env.API_BASE || 'http://localhost:3000/api';

// Helper to make API requests
async function apiRequest(path, method = 'GET', body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  const res = await fetch(`${API_BASE}${path}`, options);
  const data = await res.json();
  
  if (!res.ok) {
    throw new Error(`${method} ${path} failed: ${res.status} - ${JSON.stringify(data)}`);
  }
  
  return data;
}

// Test functions
async function testCliStatus() {
  console.log('\n--- Testing CLI Status ---');
  const data = await apiRequest('/router/cli');
  console.log('CLI Status:', {
    solana: data.solana ? '✓' : '✗',
    anchor: data.anchor ? '✓' : '✗',
    cluster: data.cluster,
    wallet: data.wallet?.slice(0, 8) + '...',
    balance: data.balance?.toFixed(4) + ' SOL',
    balanceSufficient: data.balanceSufficient ? '✓' : '✗',
  });
  return data;
}

async function testRouterStatus() {
  console.log('\n--- Testing Router Status ---');
  const data = await apiRequest('/router/status');
  console.log('Router Status:', {
    deployed: data.status?.deployed ? '✓' : '✗',
    programId: data.config?.programId?.slice(0, 8) + '...' || 'N/A',
    enabled: data.config?.enabled ? '✓' : '✗',
    mode: data.config?.executionMode,
    ready: data.ready ? '✓' : '✗',
    flashLoanAvailable: data.flashLoanAvailable ? '✓' : '✗',
  });
  return data;
}

async function testAirdrop() {
  console.log('\n--- Testing Airdrop (devnet only) ---');
  try {
    const data = await apiRequest('/router/airdrop', 'POST', { amount: 1 });
    console.log('Airdrop result:', {
      success: data.success ? '✓' : '✗',
      balance: data.balance?.toFixed(4) + ' SOL',
    });
    return data;
  } catch (err) {
    console.log('Airdrop skipped (not on devnet or rate limited):', err.message);
    return null;
  }
}

async function testBuild() {
  console.log('\n--- Testing Program Build ---');
  console.log('Building program... (this may take a while)');
  const data = await apiRequest('/router/build', 'POST');
  console.log('Build result:', {
    success: data.success ? '✓' : '✗',
    binaryPath: data.binaryPath || 'N/A',
    error: data.error || 'None',
  });
  if (data.logs?.length > 0) {
    console.log('Last few logs:', data.logs.slice(-3).join('\n'));
  }
  return data;
}

async function testDeploy() {
  console.log('\n--- Testing Program Deploy ---');
  console.log('Deploying program... (this may take a while)');
  const data = await apiRequest('/router/deploy', 'POST', { cluster: 'devnet' });
  console.log('Deploy result:', {
    success: data.success ? '✓' : '✗',
    programId: data.programId || 'N/A',
    error: data.error || 'None',
  });
  return data;
}

async function testVaultList() {
  console.log('\n--- Testing Vault List ---');
  const data = await apiRequest('/router/vaults');
  console.log('Vaults found:', data.vaults?.length || 0);
  if (data.vaults?.length > 0) {
    data.vaults.forEach((v, i) => {
      console.log(`  Vault ${i + 1}:`, {
        mint: v.mint?.slice(0, 8) + '...',
        balance: v.balance,
        available: v.availableBalance,
        flashLoanActive: v.flashLoanActive ? 'Yes' : 'No',
      });
    });
  }
  return data;
}

async function testConfigUpdate() {
  console.log('\n--- Testing Config Update ---');
  
  // Test mode change
  const modeResult = await apiRequest('/router/config/mode', 'PUT', { mode: 'auto' });
  console.log('Set mode to auto:', modeResult.success ? '✓' : '✗');
  
  // Test enable/disable
  const enableResult = await apiRequest('/router/config/enabled', 'PUT', { enabled: true });
  console.log('Enable router:', enableResult.success ? '✓' : '✗');
  
  return { modeResult, enableResult };
}

async function testFeeCalculation() {
  console.log('\n--- Testing Fee Calculation ---');
  const amount = '1000000000'; // 1 token with 9 decimals
  const data = await apiRequest(`/router/vaults/any/fee?amount=${amount}`);
  console.log('Fee calculation:', {
    amount: data.amount,
    fee: data.fee,
    repayAmount: data.repayAmount,
    feeBps: data.feeBps,
  });
  return data;
}

// Main test runner
async function runTests() {
  console.log('='.repeat(60));
  console.log('Arb-Router Integration Tests');
  console.log('='.repeat(60));
  console.log(`API Base: ${API_BASE}`);
  
  const results = {
    passed: 0,
    failed: 0,
    skipped: 0,
  };
  
  const tests = [
    { name: 'CLI Status', fn: testCliStatus },
    { name: 'Router Status', fn: testRouterStatus },
    { name: 'Fee Calculation', fn: testFeeCalculation },
    { name: 'Config Update', fn: testConfigUpdate },
    { name: 'Vault List', fn: testVaultList },
    { name: 'Airdrop', fn: testAirdrop, optional: true },
  ];
  
  // Optional deployment tests (skip by default as they're slow)
  const deployTests = process.argv.includes('--deploy') ? [
    { name: 'Build', fn: testBuild },
    { name: 'Deploy', fn: testDeploy },
  ] : [];
  
  for (const test of [...tests, ...deployTests]) {
    try {
      await test.fn();
      results.passed++;
      console.log(`[PASS] ${test.name}`);
    } catch (err) {
      if (test.optional) {
        results.skipped++;
        console.log(`[SKIP] ${test.name}: ${err.message}`);
      } else {
        results.failed++;
        console.log(`[FAIL] ${test.name}: ${err.message}`);
      }
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('Test Results:');
  console.log(`  Passed:  ${results.passed}`);
  console.log(`  Failed:  ${results.failed}`);
  console.log(`  Skipped: ${results.skipped}`);
  console.log('='.repeat(60));
  
  if (results.failed > 0) {
    process.exit(1);
  }
}

// Run tests
runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});


