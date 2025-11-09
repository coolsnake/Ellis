#!/usr/bin/env node

/**
 * Arbitrage Executor Control Script
 * 
 * Usage:
 *   node scripts/arb-executor.mjs start [--config <path>]
 *   node scripts/arb-executor.mjs stop
 *   node scripts/arb-executor.mjs status
 *   node scripts/arb-executor.mjs config <key=value> [<key=value> ...]
 * 
 * Examples:
 *   node scripts/arb-executor.mjs start
 *   node scripts/arb-executor.mjs start --config ./my-config.json
 *   node scripts/arb-executor.mjs status
 *   node scripts/arb-executor.mjs config minProfitBps=100 sizeUsd=200
 *   node scripts/arb-executor.mjs stop
 */

import { readFile } from 'fs/promises';

const API_BASE = process.env.API_BASE || 'http://localhost:3001';

async function request(endpoint, method = 'GET', body = null) {
  const url = `${API_BASE}${endpoint}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    return data;
  } catch (e) {
    console.error(`Error calling ${url}:`, e.message);
    process.exit(1);
  }
}

async function start(configPath) {
  console.log('Starting arbitrage executor...');
  
  let config = {};
  if (configPath) {
    try {
      const configData = await readFile(configPath, 'utf-8');
      config = JSON.parse(configData);
      console.log(`Loaded config from ${configPath}`);
    } catch (e) {
      console.error(`Failed to load config from ${configPath}:`, e.message);
      process.exit(1);
    }
  }

  const result = await request('/arb/executor/start', 'POST', config);
  console.log('\n✅ Executor started!');
  console.log('\nStatus:', JSON.stringify(result, null, 2));
}

async function stop() {
  console.log('Stopping arbitrage executor...');
  const result = await request('/arb/executor/stop', 'POST');
  console.log('\n✅ Executor stopped!');
  console.log('\nResult:', JSON.stringify(result, null, 2));
}

async function status() {
  console.log('Fetching executor status...\n');
  const result = await request('/arb/executor/status', 'GET');
  
  if (result.running) {
    console.log('🟢 Executor is RUNNING\n');
    
    console.log('Configuration:');
    console.log('─────────────────────────────────────────');
    console.log(`  Enabled:              ${result.config.enabled}`);
    console.log(`  Min Profit (bps):     ${result.config.minProfitBps}`);
    console.log(`  Max Concurrent:       ${result.config.maxConcurrentExecutions}`);
    console.log(`  Trade Size (USD):     ${result.config.sizeUsd || 'N/A'}`);
    console.log(`  Slippage (bps):       ${result.config.slippageBps || 'N/A'}`);
    console.log(`  Max Hops:             ${result.config.maxHops || 'N/A'}`);
    console.log(`  Min Reserves (USD):   ${result.config.minReservesUsd || 'N/A'}`);
    console.log(`  Max Exec/Min:         ${result.config.maxExecutionsPerMinute || 'N/A'}`);
    console.log(`  Cooldown (ms):        ${result.config.cooldownMs}`);
    
    console.log('\nExecution State:');
    console.log('─────────────────────────────────────────');
    console.log(`  In Flight:            ${result.state.inFlight}`);
    console.log(`  Total Executions:     ${result.state.totalExecutions}`);
    console.log(`  Successful:           ${result.state.successfulExecutions}`);
    console.log(`  Failed:               ${result.state.failedExecutions}`);
    console.log(`  Success Rate:         ${result.state.successRate}`);
    console.log(`  This Minute:          ${result.state.executionsThisMinute}`);
    
    if (result.state.inFlightKeys && result.state.inFlightKeys.length > 0) {
      console.log('\nCurrently Executing:');
      console.log('─────────────────────────────────────────');
      result.state.inFlightKeys.forEach(key => {
        console.log(`  • ${key}`);
      });
    }
    
  } else {
    console.log('🔴 Executor is NOT RUNNING');
    if (result.error) {
      console.log(`\nError: ${result.error}`);
    }
  }
}

async function updateConfig(updates) {
  console.log('Updating executor configuration...\n');
  
  const config = {};
  for (const update of updates) {
    const [key, value] = update.split('=');
    if (!key || value === undefined) {
      console.error(`Invalid config update: ${update}`);
      console.error('Format: key=value');
      process.exit(1);
    }
    
    // Try to parse as number or boolean
    let parsedValue = value;
    if (value === 'true') parsedValue = true;
    else if (value === 'false') parsedValue = false;
    else if (!isNaN(value)) parsedValue = Number(value);
    
    config[key] = parsedValue;
  }
  
  console.log('Updates:', JSON.stringify(config, null, 2));
  
  const result = await request('/arb/executor/config', 'POST', config);
  console.log('\n✅ Configuration updated!');
  console.log('\nNew status:', JSON.stringify(result, null, 2));
}

function printHelp() {
  console.log(`
Arbitrage Executor Control Script

Usage:
  node scripts/arb-executor.mjs <command> [options]

Commands:
  start [--config <path>]     Start the executor
  stop                        Stop the executor
  status                      Show executor status
  config <key=value> ...      Update configuration
  help                        Show this help

Examples:
  node scripts/arb-executor.mjs start
  node scripts/arb-executor.mjs start --config ./my-config.json
  node scripts/arb-executor.mjs status
  node scripts/arb-executor.mjs config minProfitBps=100 sizeUsd=200
  node scripts/arb-executor.mjs config enabled=true
  node scripts/arb-executor.mjs stop

Environment Variables:
  API_BASE    Backend API URL (default: http://localhost:3001)
`);
}

// Main
const args = process.argv.slice(2);
const command = args[0];

if (!command || command === 'help' || command === '--help' || command === '-h') {
  printHelp();
  process.exit(0);
}

switch (command) {
  case 'start': {
    const configIndex = args.indexOf('--config');
    const configPath = configIndex !== -1 ? args[configIndex + 1] : null;
    await start(configPath);
    break;
  }
  case 'stop':
    await stop();
    break;
  case 'status':
    await status();
    break;
  case 'config':
    if (args.length < 2) {
      console.error('Error: No config updates provided');
      console.error('Usage: node scripts/arb-executor.mjs config <key=value> [<key=value> ...]');
      process.exit(1);
    }
    await updateConfig(args.slice(1));
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}

