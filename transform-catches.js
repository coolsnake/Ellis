#!/usr/bin/env node
// Transform all empty catch {} blocks in backend/src/drift/client.ts
// 1. Add safeLog import
// 2. Replace try { logger.xxx(...); } catch {} → safeLog.xxx(...);
// 3. Replace remaining catch {} with context-based handlers

const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, 'backend/src/drift/client.ts');
let text = fs.readFileSync(filePath, 'utf8');

function countEmpty(t) { return (t.match(/catch\s*\{\s*\}/g) || []).length; }
const initialCount = countEmpty(text);
console.log(`Empty catch blocks: ${initialCount}`);

// ──── Step 1: Add import ────
if (!text.includes("from './safeLogger.js'")) {
  text = text.replace(
    "import { logger, maskUrl } from '../utils/logger.js';",
    "import { logger, maskUrl } from '../utils/logger.js';\nimport { safeLog, guardExec } from './safeLogger.js';"
  );
}

// ──── Step 2: Replace try { logger.LEVEL(...); } catch {} patterns ────
function replaceLoggerPatterns(src) {
  for (const level of ['info', 'warn', 'debug', 'error']) {
    const prefix = `try { logger.${level}(`;
    let idx = 0;
    while ((idx = src.indexOf(prefix, idx)) !== -1) {
      const argsStart = idx + prefix.length;
      let depth = 1, pos = argsStart;
      while (pos < src.length && depth > 0) {
        if (src[pos] === '(') depth++;
        else if (src[pos] === ')') depth--;
        pos++;
      }
      const args = src.substring(argsStart, pos - 1);
      const tail = src.substring(pos).match(/^;\s*\}\s*catch\s*\{\s*\}/);
      if (tail) {
        const end = pos + tail[0].length;
        const rep = `safeLog.${level}(${args});`;
        src = src.substring(0, idx) + rep + src.substring(end);
        idx += rep.length;
      } else {
        idx += prefix.length;
      }
    }
  }
  return src;
}

// Run multiple passes in case replacements reveal new patterns
let prev;
do { prev = text; text = replaceLoggerPatterns(text); } while (text !== prev);
console.log(`After logger patterns: ${countEmpty(text)} remaining (removed ${initialCount - countEmpty(text)})`);

// ──── Step 3: Replace remaining catch {} with context-based handlers ────
function findTryBody(src, catchIdx) {
  let p = catchIdx - 1;
  while (p >= 0 && /\s/.test(src[p])) p--;
  if (p < 0 || src[p] !== '}') return '';
  let depth = 1, end = p; p--;
  while (p >= 0 && depth > 0) {
    if (src[p] === '}') depth++;
    else if (src[p] === '{') depth--;
    p--;
  }
  return src.substring(p + 2, end);
}

function classify(tb) {
  // Pure timer cleanup (clearInterval / clearTimeout only, no other operations)
  if (/(clearInterval|clearTimeout)\s*\(/.test(tb) && !/subscribe|import|logger|safeLog|fetch|decode|removeAllListeners/.test(tb))
    return { comment: true };

  // Subscriber unsubscribe (cleanup/teardown)
  if (/\.unsubscribe/.test(tb)) {
    if (/sharedDlobSubscriber/.test(tb)) return { l: 'debug', c: 'drift.dlobSubscriber.unsubscribe' };
    if (/sharedOrderSubscriber/.test(tb)) return { l: 'debug', c: 'drift.orderSubscriber.unsubscribe' };
    if (/sharedUserMap/.test(tb)) return { l: 'debug', c: 'drift.userMap.unsubscribe' };
    if (/sharedEventSubscriber/.test(tb)) return { l: 'debug', c: 'drift.eventSubscriber.unsubscribe' };
    if (/sharedSlotSubscriber/.test(tb)) return { l: 'debug', c: 'drift.slotSubscriber.unsubscribe' };
    if (/Promise\.allSettled/.test(tb)) return { l: 'debug', c: 'drift.cleanup.allSettled' };
    if (/client/.test(tb) && !/activeUser/.test(tb)) return { l: 'debug', c: 'drift.client.unsubscribe' };
    return { l: 'debug', c: 'drift.user.unsubscribe' };
  }

  // WebSocket / socket close
  if (/\.close\s*\(\)/.test(tb)) return { l: 'debug', c: 'drift.ws.close' };

  // Map/set clear (subscription cleanup)
  if (/\.clear\s*\(/.test(tb) && !/import/.test(tb)) {
    if (/AccountChange/.test(tb)) return { l: 'debug', c: 'drift.cleanup.accountSubs' };
    if (/Program/.test(tb)) return { l: 'debug', c: 'drift.cleanup.programSubs' };
    return { l: 'debug', c: 'drift.cleanup.clear' };
  }

  // removeAllListeners (cleanup)
  if (/removeAllListeners/.test(tb)) return { l: 'debug', c: 'drift.cleanup.removeListeners' };

  // eventEmitter.off (cleanup)
  if (/eventEmitter\??\.off/.test(tb)) return { l: 'debug', c: 'drift.eventEmitter.off' };

  // Event listener attachment (.on / .onSlotChange)
  if ((/\.on\??\.\(/.test(tb) || /\.onSlotChange/.test(tb) || /eventEmitter\??\.on/.test(tb)) && /error|slot|event/.test(tb))
    return { l: 'debug', c: 'drift.eventListener.attach' };

  // Subscribe operations (SDK subscriptions)
  if (/\.subscribe\s*\(/.test(tb)) {
    if (/slotSubscriber/.test(tb) && !/eventSubscriber|userMap|dlobSubscriber|orderSubscriber/.test(tb)) return { l: 'warn', c: 'drift.slotSubscriber.subscribe' };
    if (/eventSubscriber/.test(tb) && !/userMap|dlobSubscriber|orderSubscriber/.test(tb)) return { l: 'warn', c: 'drift.eventSubscriber.subscribe' };
    if (/sharedUserMap|userMap/.test(tb) && !/dlobSubscriber|orderSubscriber/.test(tb)) return { l: 'warn', c: 'drift.userMap.subscribe' };
    if (/dlobSubscriber/.test(tb) && !/orderSubscriber|slotSubscriber|eventSubscriber|userMap/.test(tb)) return { l: 'warn', c: 'drift.dlobSubscriber.subscribe' };
    if (/orderSubscriber|sharedOrderSubscriber/.test(tb)) return { l: 'warn', c: 'drift.orderSubscriber.subscribe' };
    if (/user\.subscribe|userSubscribe/.test(tb)) return { l: 'warn', c: 'drift.user.subscribe' };
    // Generic subscribe (e.g. watchdog with multiple subscribers)
    return { l: 'warn', c: 'drift.subscribe' };
  }

  // Wait for WebSocket ready
  if (/waitUntilWsReady|waitReady/.test(tb)) return { l: 'debug', c: 'drift.ws.waitReady' };

  // protectRpcWebSocket
  if (/protectRpcWebSocket/.test(tb)) return { l: 'debug', c: 'drift.protectRpcWebSocket' };

  // JSON.parse
  if (/JSON\.parse/.test(tb)) return { l: 'debug', c: 'drift.jsonParse' };

  // Dynamic imports
  if (/await import\s*\(/.test(tb)) {
    if (/@drift-labs\/sdk/.test(tb)) return { l: 'warn', c: 'drift.import.sdk' };
    if (/bn\.js/.test(tb)) return { l: 'debug', c: 'drift.import.bnjs' };
    if (/blockhash/.test(tb)) return { l: 'warn', c: 'drift.import.blockhash' };
    if (/wsHelper/.test(tb)) return { l: 'debug', c: 'drift.import.wsHelper' };
    if (/price/.test(tb)) return { l: 'warn', c: 'drift.import.price' };
    if (/eventIndex/.test(tb)) return { l: 'debug', c: 'drift.import.eventIndex' };
    if (/rpcLimiter/.test(tb)) return { l: 'warn', c: 'drift.import.rpcLimiter' };
    return { l: 'warn', c: 'drift.import' };
  }

  // Decode operations (SDK coder)
  if (/coder\??\.decode/.test(tb)) return { l: 'debug', c: 'drift.decode' };

  // User operations
  if (/addUser/.test(tb) && /switchActiveUser/.test(tb)) return { l: 'warn', c: 'drift.userRecovery' };
  if (/initializeUser/.test(tb)) return { l: 'warn', c: 'drift.initializeUser' };
  if (/addUser/.test(tb)) return { l: 'warn', c: 'drift.addUser' };
  if (/switchActiveUser/.test(tb)) return { l: 'warn', c: 'drift.switchActiveUser' };
  if (/ensureUserReady/.test(tb)) return { l: 'warn', c: 'drift.ensureUserReady' };

  // RPC operations
  if (/getUserAccountPublicKey/.test(tb) && /getAccountInfo/.test(tb)) return { l: 'warn', c: 'drift.rpc.checkUserAccount' };
  if (/getAccountInfo|getSlot|getBalance|getMultipleAccountsInfo/.test(tb)) return { l: 'warn', c: 'drift.rpc' };

  // SDK market operations
  if (/getPerpMarketAccount\b/.test(tb) && !/getPerpMarketAccounts/.test(tb)) return { l: 'warn', c: 'drift.sdk.getPerpMarket' };
  if (/getPerpMarketAccounts|getSpotMarketAccounts/.test(tb)) return { l: 'warn', c: 'drift.sdk.getMarkets' };
  if (/getPerpPositions|getSpotPositions/.test(tb)) return { l: 'debug', c: 'drift.sdk.getPositions' };
  if (/convertToSpotPrecision/.test(tb)) return { l: 'warn', c: 'drift.sdk.spotPrecision' };
  if (/accountSubscriber\??\.fetch/.test(tb)) return { l: 'warn', c: 'drift.accountSubscriber.fetch' };

  // Subaccounts
  if (/getSubaccounts/.test(tb)) return { l: 'warn', c: 'drift.getSubaccounts' };

  // Event index
  if (/setupEventIndex/.test(tb)) return { l: 'debug', c: 'drift.setupEventIndex' };
  if (/bootstrapFromUserMap|driftEventIndex/.test(tb)) return { l: 'debug', c: 'drift.eventIndex' };
  if (/bindEventSubscriber/.test(tb)) return { l: 'debug', c: 'drift.eventIndex.bind' };

  // Warm users / prefetch
  if (/warmActiveUsersOnce/.test(tb)) return { l: 'debug', c: 'drift.warmActiveUsers' };
  if (/startUserPrefetcher/.test(tb)) return { l: 'warn', c: 'drift.startPrefetcher' };
  if (/warmUsers|evictWarmUserIfNeeded/.test(tb)) return { l: 'debug', c: 'drift.warmUsers' };
  if (/ensureRefStatsReady/.test(tb)) return { l: 'debug', c: 'drift.refStats' };

  // Fetch operations
  if (/fetchAccounts/.test(tb)) return { l: 'warn', c: 'drift.fetchAccounts' };
  if (/fetchUsers/.test(tb)) return { l: 'warn', c: 'drift.fetchUsers' };

  // DriftPriceService
  if (/DriftPriceService/.test(tb)) return { l: 'warn', c: 'drift.priceService' };

  // getMaxNumberOfSubAccounts
  if (/getMaxNumberOfSubAccounts/.test(tb)) return { l: 'warn', c: 'drift.sdk.getMaxSubAccounts' };

  // Warmup / cleanup promise
  if (/warmupPromise/.test(tb)) return { l: 'warn', c: 'drift.warmup' };
  if (/warmup/.test(tb)) return { l: 'warn', c: 'drift.warmup' };
  if (/cleanupPromise/.test(tb)) return { l: 'debug', c: 'drift.cleanupWait' };

  // Promise.allSettled
  if (/Promise\.allSettled/.test(tb)) return { l: 'debug', c: 'drift.cleanup.allSettled' };

  // step() call
  if (/step\(\)/.test(tb)) return { l: 'debug', c: 'drift.prefetch.step' };

  // getActiveSubaccountSnapshot
  if (/getActiveSubaccountSnapshot/.test(tb)) return { l: 'warn', c: 'drift.snapshot' };

  // SDK constants
  if (/QUOTE_PRECISION|constants/.test(tb) && !/subscribe/.test(tb)) return { l: 'debug', c: 'drift.sdk.constants' };

  // SDK coder access
  if (/coder/.test(tb)) return { l: 'debug', c: 'drift.sdk.coder' };

  // lastPrefetchSlot
  if (/lastPrefetchSlot/.test(tb)) return { l: 'debug', c: 'drift.prefetch.slot' };

  // DLOB operations
  if (/dlob|DLOB|getRestingLimitOrderNodes/.test(tb)) return { l: 'debug', c: 'drift.dlob' };

  // Prefetch
  if (/prefetch/.test(tb)) return { l: 'debug', c: 'drift.prefetch' };

  // RPC fetch
  if (/fetch\(/.test(tb)) return { l: 'warn', c: 'drift.rpc.fetch' };

  // UserMap construction
  if (/UserMap/.test(tb)) return { l: 'warn', c: 'drift.userMap.create' };

  // Configure
  if (/\.configure\(/.test(tb)) return { l: 'debug', c: 'drift.configure' };

  // BulkAccountLoader
  if (/BulkAccountLoader/.test(tb)) return { l: 'warn', c: 'drift.init.loader' };

  // Default
  return { l: 'debug', c: 'drift.op' };
}

function replaceRemainingCatches(src) {
  const re = /catch\s*\{\s*\}/g;
  const pos = [];
  let m;
  while ((m = re.exec(src)) !== null) pos.push({ i: m.index, l: m[0].length });

  // Process in reverse to preserve earlier positions
  for (let k = pos.length - 1; k >= 0; k--) {
    const { i, l } = pos[k];
    const tb = findTryBody(src, i);
    const cl = classify(tb);
    const rep = cl.comment
      ? 'catch { /* timer cleanup safe to swallow */ }'
      : `catch (e: any) { safeLog.${cl.l}('${cl.c}', { error: String(e?.message || e), cat: 'drift' }); }`;
    src = src.substring(0, i) + rep + src.substring(i + l);
  }
  return src;
}

text = replaceRemainingCatches(text);
const finalCount = countEmpty(text);
console.log(`Final: ${finalCount} empty catch blocks`);

if (finalCount > 0) {
  console.log('WARNING: Some empty catch blocks remain!');
  // Show remaining catch {} locations for debugging
  const lines = text.split('\n');
  lines.forEach((line, idx) => {
    if (/catch\s*\{\s*\}/.test(line)) {
      console.log(`  Line ${idx + 1}: ${line.trim().substring(0, 120)}`);
    }
  });
}

fs.writeFileSync(filePath, text, 'utf8');
console.log(`Done! Written to ${filePath}`);
