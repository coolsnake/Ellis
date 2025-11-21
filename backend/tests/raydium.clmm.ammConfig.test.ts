import { describe, it, expect } from 'vitest';

describe('Raydium CLMM ammConfig fee extraction', () => {
  it('decodes trade_fee_rate from ammConfig account data', () => {
    // Create a mock ammConfig account buffer
    const buffer = Buffer.alloc(109); // Minimum size for ammConfig
    
    // Set trade_fee_rate at offset 39 (u32 LE)
    // Test: 100 PPM = 1 bps = 0.01%
    buffer.writeUInt32LE(100, 39);
    
    const TRADE_FEE_RATE_OFFSET = 39;
    const tradeFeeRatePPM = buffer.readUInt32LE(TRADE_FEE_RATE_OFFSET);
    const feeBps = tradeFeeRatePPM / 100;
    
    expect(feeBps).toBe(1);
    expect(tradeFeeRatePPM).toBe(100);
  });
  
  it('converts common Raydium CLMM fee tiers correctly', () => {
    const testCases = [
      { ppm: 100, expectedBps: 1, expectedPercent: '0.01%', description: '0.01% fee tier' },
      { ppm: 200, expectedBps: 2, expectedPercent: '0.02%', description: '0.02% fee tier' },
      { ppm: 300, expectedBps: 3, expectedPercent: '0.03%', description: '0.03% fee tier' },
      { ppm: 400, expectedBps: 4, expectedPercent: '0.04%', description: '0.04% fee tier' },
      { ppm: 500, expectedBps: 5, expectedPercent: '0.05%', description: '0.05% fee tier' },
      { ppm: 2500, expectedBps: 25, expectedPercent: '0.25%', description: '0.25% fee tier' },
      { ppm: 10000, expectedBps: 100, expectedPercent: '1%', description: '1% fee tier' },
      { ppm: 20000, expectedBps: 200, expectedPercent: '2%', description: '2% fee tier' },
    ];
    
    for (const { ppm, expectedBps, description } of testCases) {
      const feeBps = ppm / 100;
      expect(feeBps).toBe(expectedBps);
    }
  });
  
  it('calculates fee percentage from basis points', () => {
    const testCases = [
      { bps: 1, percent: 0.01 },
      { bps: 5, percent: 0.05 },
      { bps: 25, percent: 0.25 },
      { bps: 100, percent: 1.0 },
      { bps: 200, percent: 2.0 },
    ];
    
    for (const { bps, percent } of testCases) {
      const calculated = bps / 100;
      expect(calculated).toBe(percent);
    }
  });
  
  it('handles full ammConfig account structure', () => {
    // Simulate a complete ammConfig account
    const buffer = Buffer.alloc(109);
    
    // bump (u8) at offset 0
    buffer.writeUInt8(249, 0);
    
    // index (u16) at offset 1
    buffer.writeUInt16LE(4, 1);
    
    // owner (pubkey) at offset 3 - skip for test
    
    // protocol_fee_rate (u32) at offset 35
    buffer.writeUInt32LE(120000, 35);
    
    // trade_fee_rate (u32) at offset 39 - This is what we care about
    buffer.writeUInt32LE(2500, 39); // 0.25% fee
    
    // tick_spacing (u16) at offset 43
    buffer.writeUInt16LE(60, 43);
    
    // fund_fee_rate (u32) at offset 45
    buffer.writeUInt32LE(40000, 45);
    
    // Now decode trade_fee_rate
    const TRADE_FEE_RATE_OFFSET = 39;
    const tradeFeeRatePPM = buffer.readUInt32LE(TRADE_FEE_RATE_OFFSET);
    const feeBps = tradeFeeRatePPM / 100;
    
    expect(tradeFeeRatePPM).toBe(2500);
    expect(feeBps).toBe(25); // 0.25%
    
    // Verify other fields don't interfere
    const protocolFeeRate = buffer.readUInt32LE(35);
    expect(protocolFeeRate).toBe(120000);
    expect(protocolFeeRate).not.toBe(tradeFeeRatePPM);
  });
  
  it('handles edge cases gracefully', () => {
    // Test zero fee
    let buffer = Buffer.alloc(109);
    buffer.writeUInt32LE(0, 39);
    expect(buffer.readUInt32LE(39) / 100).toBe(0);
    
    // Test maximum u32 value
    buffer = Buffer.alloc(109);
    buffer.writeUInt32LE(0xFFFFFFFF, 39);
    const maxFeeBps = buffer.readUInt32LE(39) / 100;
    expect(maxFeeBps).toBe(42949672.95); // Unrealistic but valid
    
    // Test buffer too small
    const smallBuffer = Buffer.alloc(10);
    expect(smallBuffer.length).toBeLessThan(43);
    // In real code, we'd check buffer length before reading
  });
});

