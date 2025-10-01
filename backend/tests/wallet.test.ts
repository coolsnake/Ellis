import { describe, it, expect } from 'vitest';
import { generateAndSaveWallet, loadWallet } from '../src/wallet/wallet.js';
import { promises as fs } from 'fs';
import path from 'path';

describe('wallet utils', () => {
  it('generate and load wallet', async () => {
    const tmpDir = path.join(process.cwd(), 'wallet_test_tmp');
    const file = path.join(tmpDir, 'keypair.json');
    await fs.mkdir(tmpDir, { recursive: true });
    const kp = await generateAndSaveWallet(file);
    const loaded = await loadWallet(file);
    expect(loaded.publicKey.toBase58()).toEqual(kp.publicKey.toBase58());
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});


