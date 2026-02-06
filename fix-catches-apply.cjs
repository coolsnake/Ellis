const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'backend', 'src', 'drift', 'client.ts');
let content = fs.readFileSync(filePath, 'utf8');
const nl = content.includes('\r\n') ? '\r\n' : '\n';
const lines = content.split(nl);
let changeCount = 0;

function fixLine(lineNum, search, replace) {
  const idx = lineNum - 1;
  if (idx < 0 || idx >= lines.length) {
    console.log('ERROR: Line ' + lineNum + ' out of range');
    return;
  }
  if (!lines[idx].includes(search)) {
    console.log('WARN: Line ' + lineNum + ' does not contain: ' + search.substring(0,50));
    console.log('  Actual: ' + lines[idx].trim().substring(0,80));
    return;
  }
  lines[idx] = lines[idx].replace(search, replace);
  changeCount++;
  console.log('Fixed line ' + lineNum);
}

// For multi-line catches, fix the catch line and the following line(s)
function fixMultiLine(lineNum, catchReplace) {
  const idx = lineNum - 1;
  if (idx < 0 || idx >= lines.length) {
    console.log('ERROR: Line ' + lineNum + ' out of range');
    return;
  }
  if (!lines[idx].includes('} catch {')) {
    console.log('WARN: Line ' + lineNum + ' does not contain } catch {');
    console.log('  Actual: ' + lines[idx].trim().substring(0,80));
    return;
  }
  lines[idx] = lines[idx].replace('} catch {', catchReplace);
  changeCount++;
  console.log('Fixed line ' + lineNum);
}

// 1. Line 1543: fetchUsersDecoded outer catch - RPC operation
fixMultiLine(1543, "} catch (e: any) {" + nl + "      safeLog.warn('drift.fetchUsersDecoded', { error: String(e?.message || e), cat: 'drift' });");

// 2. Line 1684: prefetch fetchUsersDecoded - RPC operation (inline)
fixLine(1684,
  '} catch { decoded = new Map(); }',
  "} catch (e: any) { safeLog.warn('drift.prefetch.fetchUsersDecoded', { error: String(e?.message || e), cat: 'drift' }); decoded = new Map(); }");

// 3. Line 1722: warmActiveUsers fetchUsersDecoded - RPC operation (inline)
fixLine(1722,
  '} catch { decoded = new Map(); }',
  "} catch (e: any) { safeLog.warn('drift.warmActiveUsers.fetchUsersDecoded', { error: String(e?.message || e), cat: 'drift' }); decoded = new Map(); }");

// 4. Line 1868: toUi number conversion - debug level
fixLine(1868,
  '} catch { return Number(val?.toString?.() || val || 0) / QUOTE_PREC; }',
  "} catch (e: any) { safeLog.debug('drift.toUi', { error: String(e?.message || e), cat: 'drift' }); return Number(val?.toString?.() || val || 0) / QUOTE_PREC; }");

// 5. Line 1901: getActiveSubaccountSnapshot - SDK/RPC
fixMultiLine(1901, "} catch (e: any) {" + nl + "      safeLog.warn('drift.getActiveSubaccountSnapshot', { error: String(e?.message || e), cat: 'drift' });");

// 6. Line 1919: getSubaccounts fallback - SDK/RPC (inline)
fixLine(1919,
  '} catch { subs = []; }',
  "} catch (e: any) { safeLog.warn('drift.getSubaccounts.fallback', { error: String(e?.message || e), cat: 'drift' }); subs = []; }");

// 7. Line 2069: getMaxNumberOfSubAccounts ids - SDK fallback (inline)
fixLine(2069,
  '} catch { for (let i = 0; i < 8; i += 1) ids.push(i); }',
  "} catch (e: any) { safeLog.warn('drift.getMaxSubAccounts', { error: String(e?.message || e), cat: 'drift' }); for (let i = 0; i < 8; i += 1) ids.push(i); }");

// 8. Line 2084: getUserAccountPublicKey - SDK/RPC (inline)
fixLine(2084,
  '} catch { return { id, pk: null }; }',
  "} catch (e: any) { safeLog.debug('drift.getUserAccountPublicKey', { error: String(e?.message || e), cat: 'drift' }); return { id, pk: null }; }");

// 9. Line 2157: user account load in getSubaccounts - SDK/RPC
fixMultiLine(2157, "} catch (e: any) {" + nl + "          safeLog.warn('drift.subaccount.load', { error: String(e?.message || e), cat: 'drift' });");

// 10. Line 2175: getSubaccounts outer - SDK/RPC
fixMultiLine(2175, "} catch (e: any) {" + nl + "      safeLog.warn('drift.getSubaccounts', { error: String(e?.message || e), cat: 'drift' });");

// 11. Line 2306: getMaxNumberOfSubAccounts candidateIds - SDK fallback (inline)
fixLine(2306,
  '} catch { for (let i = 0; i < 8; i += 1) candidateIds.push(i); }',
  "} catch (e: any) { safeLog.warn('drift.getMaxSubAccounts.candidates', { error: String(e?.message || e), cat: 'drift' }); for (let i = 0; i < 8; i += 1) candidateIds.push(i); }");

console.log('\nTotal changes: ' + changeCount);

// Write back
const output = lines.join(nl);
fs.writeFileSync(filePath, output, 'utf8');
console.log('File written successfully. New size: ' + output.length);
