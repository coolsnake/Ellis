import { describe, it, expect } from 'vitest';
import { getJupiterTopTokenSet } from '../src/server/universe.js';
import { getPriceByMint } from '../src/server/priceStore.js';
import { computeTokenUniverse } from '../src/server/universe.js';

/**
 * Price Validation Tests
 * 
 * Compares our calculated prices against Jupiter's usdPrice as ground truth
 */
describe('Price Validation Against Jupiter', () => {
  it('should match Jupiter usdPrice within 5% for top tokens', async () => {
    // Fetch Jupiter top tokens with usdPrice
    const response = await fetch('https://api.jup.ag/tokens/v2/tag?query=verified&limit=50');
    const data: any = await response.json();
    const tokens: any[] = Array.isArray(data) ? data : (data?.data || []);
    
    const mismatches: Array<{
      mint: string;
      symbol: string;
      ourPrice: number;
      jupiterPrice: number;
      deviation: number;
    }> = [];
    
    let checked = 0;
    let matched = 0;
    
    for (const token of tokens) {
      const mint = token.address;
      const jupiterPrice = token.usdPrice;
      
      // Skip if Jupiter doesn't have a price
      if (!jupiterPrice || jupiterPrice <= 0) continue;
      
      // Get our calculated price
      const ourPriceData = getPriceByMint(mint);
      if (!ourPriceData?.usdc) continue;
      
      const ourPrice = ourPriceData.usdc;
      checked++;
      
      // Calculate deviation
      const deviation = Math.abs(ourPrice - jupiterPrice) / jupiterPrice;
      
      if (deviation > 0.05) { // 5% threshold
        mismatches.push({
          mint,
          symbol: token.symbol || 'UNKNOWN',
          ourPrice,
          jupiterPrice,
          deviation: deviation * 100,
        });
      } else {
        matched++;
      }
    }
    
    console.log(`\n=== Price Validation Results ===`);
    console.log(`Checked: ${checked} tokens`);
    console.log(`Matched: ${matched} tokens (within 5%)`);
    console.log(`Mismatches: ${mismatches.length} tokens\n`);
    
    if (mismatches.length > 0) {
      console.log('Top 10 Mismatches:');
      mismatches
        .sort((a, b) => b.deviation - a.deviation)
        .slice(0, 10)
        .forEach(m => {
          console.log(`  ${m.symbol}: Our=${m.ourPrice.toFixed(6)}, Jupiter=${m.jupiterPrice.toFixed(6)}, Dev=${m.deviation.toFixed(2)}%`);
        });
    }
    
    // Assertion: At least 80% of tokens should match within 5%
    const matchRate = matched / checked;
    expect(matchRate).toBeGreaterThan(0.80);
  }, 30000); // 30 second timeout
  
  it('should validate pool-derived prices match cross-pool consensus', async () => {
    // This tests that our pool-to-pool pricing is internally consistent
    // by checking triangular arbitrage should be near zero for stable pairs
    
    const { peekRaydiumPools, peekOrcaPools } = await import('../src/server/pools.js');
    const raydium = peekRaydiumPools();
    const orca = peekOrcaPools();
    
    // Find SOL/USDC pools from both DEXes
    const solMint = 'So11111111111111111111111111111111111111112';
    const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    
    const rayPool = [...(raydium?.amm || []), ...(raydium?.clmm || [])]
      .find(p => 
        (p.mint_a === solMint && p.mint_b === usdcMint) ||
        (p.mint_a === usdcMint && p.mint_b === solMint)
      );
    
    const orcaPool = [...(orca?.clmm || [])]
      .find(p => 
        (p.mint_a === solMint && p.mint_b === usdcMint) ||
        (p.mint_a === usdcMint && p.mint_b === solMint)
      );
    
    if (!rayPool || !orcaPool) {
      console.log('Skipping cross-DEX validation - missing SOL/USDC pools');
      return;
    }
    
    // Get prices in canonical orientation (SOL per USDC)
    const getRateSolPerUsdc = (pool: any) => {
      if (pool.mint_a === solMint) {
        return pool.price_a_per_b; // Already SOL per USDC
      } else {
        return 1 / pool.price_a_per_b; // Invert to SOL per USDC
      }
    };
    
    const rayRate = getRateSolPerUsdc(rayPool);
    const orcaRate = getRateSolPerUsdc(orcaPool);
    
    const deviation = Math.abs(rayRate - orcaRate) / orcaRate;
    
    console.log(`\n=== Cross-DEX SOL/USDC Price Check ===`);
    console.log(`Raydium: ${rayRate.toFixed(6)} SOL per USDC`);
    console.log(`Orca: ${orcaRate.toFixed(6)} SOL per USDC`);
    console.log(`Deviation: ${(deviation * 100).toFixed(2)}%\n`);
    
    // Prices should match within 2% for major pairs
    expect(deviation).toBeLessThan(0.02);
  }, 30000);
});

