import { describe, it, expect } from 'vitest';
import { resolveDecimals, resolveManyDecimals, clearDecimalsCache, getDecimalsCacheStats } from '../../pools/decimals.js';

describe('Decimal Resolution', () => {
  it('should resolve SOL decimals from anchors', async () => {
    clearDecimalsCache();
    const decimals = await resolveDecimals('So11111111111111111111111111111111111111112');
    expect(decimals).toBe(9);
  });
  
  it('should resolve USDC decimals from anchors', async () => {
    const decimals = await resolveDecimals('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(decimals).toBe(6);
  });
  
  it('should resolve USDT decimals from anchors', async () => {
    const decimals = await resolveDecimals('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
    expect(decimals).toBe(6);
  });
  
  it('should resolve USD1 decimals from anchors', async () => {
    const decimals = await resolveDecimals('USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB');
    expect(decimals).toBe(6);
  });
  
  it('should return undefined for invalid mint', async () => {
    const decimals = await resolveDecimals('invalid');
    expect(decimals).toBeUndefined();
  });
  
  it('should return undefined for empty string', async () => {
    const decimals = await resolveDecimals('');
    expect(decimals).toBeUndefined();
  });
  
  it('should batch resolve multiple mints', async () => {
    const mints = [
      'So11111111111111111111111111111111111111112',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    ];
    
    const result = await resolveManyDecimals(mints);
    
    expect(result.get(mints[0])).toBe(9);  // SOL
    expect(result.get(mints[1])).toBe(6);  // USDC
    expect(result.get(mints[2])).toBe(6);  // USDT
  });
  
  it('should cache resolved decimals', async () => {
    const mint = 'So11111111111111111111111111111111111111112';
    
    // First call
    const decimals1 = await resolveDecimals(mint);
    
    // Check cache stats
    const stats = getDecimalsCacheStats();
    expect(stats.cacheSize).toBeGreaterThanOrEqual(0);
    expect(stats.anchorSize).toBe(4); // SOL, USDC, USDT, USD1
    
    // Second call (should hit cache)
    const decimals2 = await resolveDecimals(mint);
    
    expect(decimals1).toBe(decimals2);
    expect(decimals1).toBe(9);
  });
  
  it('should handle batch with invalid mints gracefully', async () => {
    const mints = [
      'So11111111111111111111111111111111111111112', // valid
      'invalid', // invalid
      '', // empty
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // valid
    ];
    
    const result = await resolveManyDecimals(mints);
    
    expect(result.get('So11111111111111111111111111111111111111112')).toBe(9);
    expect(result.get('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(6);
    expect(result.has('invalid')).toBe(false);
    expect(result.has('')).toBe(false);
  });
  
  it('should return cache stats', () => {
    const stats = getDecimalsCacheStats();
    
    expect(stats).toHaveProperty('cacheSize');
    expect(stats).toHaveProperty('anchorSize');
    expect(stats).toHaveProperty('jupMapAge');
    expect(stats.anchorSize).toBe(4);
  });
});

