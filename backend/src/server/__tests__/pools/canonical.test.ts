import { describe, it, expect } from 'vitest';
import { canonicalOrientation, canonicalizePools, swapPoolFields, clearCanonicalCache } from '../../pools/canonical.js';

describe('Canonical Orientation', () => {
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
  const USD1 = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';
  const SOL = 'So11111111111111111111111111111111111111112';
  const SOME_TOKEN = 'SOME1111111111111111111111111111111111111';
  
  describe('canonicalOrientation', () => {
    it('should keep USDC on B side', () => {
      // SOME_TOKEN/USDC → keep (USDC is already on B)
      expect(canonicalOrientation(SOME_TOKEN, USDC)).toBe('keep');
      
      // USDC/SOME_TOKEN → swap (move USDC to B)
      expect(canonicalOrientation(USDC, SOME_TOKEN)).toBe('swap');
    });
    
    it('should handle quote hierarchy correctly', () => {
      // USDC has highest priority (index 0), should always be on B
      // USDT has index 1, USD1 has index 2, SOL has index 3
      expect(canonicalOrientation(USDT, USDC)).toBe('keep'); // USDC already on B
      expect(canonicalOrientation(USDC, USDT)).toBe('swap'); // Move USDC to B
      expect(canonicalOrientation(SOL, USDC)).toBe('keep'); // USDC already on B
      expect(canonicalOrientation(USDC, SOL)).toBe('swap'); // Move USDC to B
      
      // USDT has second priority
      expect(canonicalOrientation(SOL, USDT)).toBe('keep'); // USDT already on B
      expect(canonicalOrientation(USDT, SOL)).toBe('swap'); // Move USDT to B
      
      // USD1 has third priority
      expect(canonicalOrientation(SOL, USD1)).toBe('keep'); // USD1 already on B
      expect(canonicalOrientation(USD1, SOL)).toBe('swap'); // Move USD1 to B
    });
    
    it('should handle SOL correctly', () => {
      // SOL with unknown token → SOL should be on A
      expect(canonicalOrientation(SOME_TOKEN, SOL)).toBe('swap');
      expect(canonicalOrientation(SOL, SOME_TOKEN)).toBe('keep');
    });
    
    it('should use lexicographic ordering for unknown pairs', () => {
      const TOKEN_A = 'AAAA1111111111111111111111111111111111111';
      const TOKEN_B = 'BBBB1111111111111111111111111111111111111';
      
      // A < B lexicographically → keep
      expect(canonicalOrientation(TOKEN_A, TOKEN_B)).toBe('keep');
      
      // B > A lexicographically → swap
      expect(canonicalOrientation(TOKEN_B, TOKEN_A)).toBe('swap');
    });
  });
  
  describe('swapPoolFields', () => {
    it('should swap pool mints and price', () => {
      const pool = {
        mint_a: 'MINT_A',
        mint_b: 'MINT_B',
        price_a_per_b: 2.0,
      };
      
      const swapped = swapPoolFields(pool);
      
      expect(swapped.mint_a).toBe('MINT_B');
      expect(swapped.mint_b).toBe('MINT_A');
      expect(swapped.price_a_per_b).toBe(0.5); // Inverted
    });
    
    it('should swap all _a/_b suffixed fields', () => {
      const pool = {
        mint_a: 'MINT_A',
        mint_b: 'MINT_B',
        price_a_per_b: 2.0,
        decimals_a: 6,
        decimals_b: 9,
        account_a: 'ACCOUNT_A',
        account_b: 'ACCOUNT_B',
        amount_a_whole: 100,
        amount_b_whole: 200,
        reserve_a_raw: '1000000',
        reserve_b_raw: '2000000000',
      };
      
      const swapped = swapPoolFields(pool);
      
      expect(swapped.decimals_a).toBe(9);
      expect(swapped.decimals_b).toBe(6);
      expect(swapped.account_a).toBe('ACCOUNT_B');
      expect(swapped.account_b).toBe('ACCOUNT_A');
      expect(swapped.amount_a_whole).toBe(200);
      expect(swapped.amount_b_whole).toBe(100);
      expect(swapped.reserve_a_raw).toBe('2000000000');
      expect(swapped.reserve_b_raw).toBe('1000000');
    });
    
    it('should preserve fields without _a/_b suffix', () => {
      const pool = {
        mint_a: 'MINT_A',
        mint_b: 'MINT_B',
        price_a_per_b: 2.0,
        id: 'POOL_ID',
        dex: 'Raydium',
        fee_bps: 25,
        lp_mint: 'LP_MINT',
        market_id: 'MARKET_ID',
      };
      
      const swapped = swapPoolFields(pool);
      
      // These should not change
      expect(swapped.id).toBe('POOL_ID');
      expect(swapped.dex).toBe('Raydium');
      expect(swapped.fee_bps).toBe(25);
      expect(swapped.lp_mint).toBe('LP_MINT');
      expect(swapped.market_id).toBe('MARKET_ID');
    });
    
    it('should handle pools without price', () => {
      const pool: any = {
        mint_a: 'MINT_A',
        mint_b: 'MINT_B',
        decimals_a: 6,
        decimals_b: 9,
      };
      
      const swapped = swapPoolFields(pool);
      
      expect(swapped.mint_a).toBe('MINT_B');
      expect(swapped.mint_b).toBe('MINT_A');
      expect(swapped.decimals_a).toBe(9);
      expect(swapped.decimals_b).toBe(6);
    });
  });
  
  describe('canonicalizePools', () => {
    it('should canonicalize pools array', () => {
      const pools = [
        { mint_a: SOME_TOKEN, mint_b: USDC, price_a_per_b: 2.0 },
        { mint_a: USDC, mint_b: SOME_TOKEN, price_a_per_b: 0.5 },
      ];
      
      const canonical = canonicalizePools(pools);
      
      // Both should end up as SOME_TOKEN/USDC
      expect(canonical[0].mint_a).toBe(SOME_TOKEN);
      expect(canonical[0].mint_b).toBe(USDC);
      expect(canonical[1].mint_a).toBe(SOME_TOKEN);
      expect(canonical[1].mint_b).toBe(USDC);
      
      // Prices should both be ~2.0 after canonicalization
      expect(canonical[0].price_a_per_b).toBeCloseTo(2.0);
      expect(canonical[1].price_a_per_b).toBeCloseTo(2.0);
    });
    
    it('should handle mixed orientation pools', () => {
      const pools = [
        { mint_a: SOL, mint_b: USDC, price_a_per_b: 150.0 },
        { mint_a: USDC, mint_b: SOL, price_a_per_b: 1/150.0 },
        { mint_a: SOME_TOKEN, mint_b: SOL, price_a_per_b: 0.5 },
        { mint_a: SOL, mint_b: SOME_TOKEN, price_a_per_b: 2.0 },
      ];
      
      const canonical = canonicalizePools(pools);
      
      // SOL/USDC → swap to USDC on B (USDC has higher priority)
      expect(canonical[0].mint_a).toBe(SOL);
      expect(canonical[0].mint_b).toBe(USDC);
      expect(canonical[0].price_a_per_b).toBeCloseTo(150.0);
      
      // USDC/SOL → keep (already correct)
      expect(canonical[1].mint_a).toBe(SOL);
      expect(canonical[1].mint_b).toBe(USDC);
      
      // SOME_TOKEN/SOL → swap (SOL as base)
      expect(canonical[2].mint_a).toBe(SOL);
      expect(canonical[2].mint_b).toBe(SOME_TOKEN);
      expect(canonical[2].price_a_per_b).toBeCloseTo(2.0);
      
      // SOL/SOME_TOKEN → keep (SOL as base)
      expect(canonical[3].mint_a).toBe(SOL);
      expect(canonical[3].mint_b).toBe(SOME_TOKEN);
    });
    
    it('should preserve all pool fields during canonicalization', () => {
      const pools = [
        {
          mint_a: USDC,
          mint_b: SOME_TOKEN,
          price_a_per_b: 0.5,
          decimals_a: 6,
          decimals_b: 9,
          account_a: 'ACCOUNT_A',
          account_b: 'ACCOUNT_B',
          id: 'POOL_ID',
          dex: 'Raydium',
          fee_bps: 25,
        }
      ];
      
      const canonical = canonicalizePools(pools);
      
      // Should swap to SOME_TOKEN/USDC
      expect(canonical[0].mint_a).toBe(SOME_TOKEN);
      expect(canonical[0].mint_b).toBe(USDC);
      
      // Decimals should be swapped
      expect(canonical[0].decimals_a).toBe(9);
      expect(canonical[0].decimals_b).toBe(6);
      
      // Accounts should be swapped
      expect(canonical[0].account_a).toBe('ACCOUNT_B');
      expect(canonical[0].account_b).toBe('ACCOUNT_A');
      
      // Other fields preserved
      expect(canonical[0].id).toBe('POOL_ID');
      expect(canonical[0].dex).toBe('Raydium');
      expect(canonical[0].fee_bps).toBe(25);
    });
  });
});

