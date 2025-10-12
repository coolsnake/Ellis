import { describe, it, expect } from 'vitest';
import { promises as fsp } from 'fs';
import { resolve } from 'path';

// Use direct import to the module under test
import * as session from '../utils/sessionLogs.js';
import { CONFIG } from '../utils/config.js';

describe('writeConsolidatedSessionLog', () => {
  const tmpDir = resolve(process.cwd(), 'backend', 'logs-test');
  const outPath = resolve(tmpDir, 'consolidated-session.json');
  const arbPath = resolve(tmpDir, 'arb-session.json');

  it('merges backend and arb sessions, caps to max, and overwrites', async () => {
    try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {}
    await fsp.mkdir(tmpDir, { recursive: true });
    // Patch CONFIG for test output paths
    (CONFIG as any).logDir = tmpDir;
    (CONFIG as any).consolidated = {
      ...(CONFIG as any).consolidated,
      path: outPath,
      max: 5,
      arbSessionPath: arbPath,
      arbLogDir: undefined,
    };
    // Seed backend session events via provided test helper
    session.setSessionEventsForTest([
      { level: 'info', message: 'b1', timestamp: 't1' },
      { level: 'info', message: 'b2', timestamp: 't2' },
      { level: 'info', message: 'b3', timestamp: 't3' },
    ]);
    // Write arb session as array of strings
    await fsp.writeFile(arbPath, JSON.stringify(['a1','a2','a3','a4','a5','a6']), 'utf-8');

    const file = await session.writeConsolidatedSessionLog();
    expect(file).toBe(outPath);
    const text1 = await fsp.readFile(outPath, 'utf-8');
    const arr1 = JSON.parse(text1);
    expect(Array.isArray(arr1)).toBe(true);
    // Capped to max=5
    expect(arr1.length).toBe(5);
    // Should include source markers
    expect(arr1.some((e: any) => e.source === 'backend')).toBe(true);
    expect(arr1.some((e: any) => e.source === 'arb')).toBe(true);

    // Overwrite check: write again with different arb content
    await fsp.writeFile(arbPath, JSON.stringify(['x1']), 'utf-8');
    const file2 = await session.writeConsolidatedSessionLog();
    expect(file2).toBe(outPath);
    const text2 = await fsp.readFile(outPath, 'utf-8');
    const arr2 = JSON.parse(text2);
    expect(arr2.length).toBeGreaterThan(0);
  });
});


