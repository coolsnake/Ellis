import { describe, it, expect } from 'vitest';
import { determineSwapOrientation, verifySwapOrientation } from '../../pools/orientation.js';
import type { PoolInfo, HopInfo } from '../../pools/orientation.js';

describe('Swap Orientation', () => {
  const pool: PoolInfo = {
    mint_a: 'MINT_A',
    mint_b: 'MINT_B',
    account_a: 'VAULT_A',
    account_b: 'VAULT_B',
    decimals_a: 6,
    decimals_b: 9,
  };
  
  describe('determineSwapOrientation', () => {
    it('should determine AtoB direction correctly', () => {
      const hop: HopInfo = {
        inputMint: 'MINT_A',
        outputMint: 'MINT_B',
        userSourceAta: 'USER_SOURCE',
        userDestAta: 'USER_DEST',
      };
      
      const oriented = determineSwapOrientation(pool, hop);
      
      expect(oriented.direction).toBe('AtoB');
      expect(oriented.inputIsA).toBe(true);
      expect(oriented.outputIsB).toBe(true);
      expect(oriented.poolVaultInput).toBe('VAULT_A');
      expect(oriented.poolVaultOutput).toBe('VAULT_B');
      expect(oriented.userAccountInput).toBe('USER_SOURCE');
      expect(oriented.userAccountOutput).toBe('USER_DEST');
      expect(oriented.decimalsInput).toBe(6);
      expect(oriented.decimalsOutput).toBe(9);
      expect(oriented.mintInput).toBe('MINT_A');
      expect(oriented.mintOutput).toBe('MINT_B');
    });
    
    it('should determine BtoA direction correctly', () => {
      const hop: HopInfo = {
        inputMint: 'MINT_B',
        outputMint: 'MINT_A',
        userSourceAta: 'USER_SOURCE',
        userDestAta: 'USER_DEST',
      };
      
      const oriented = determineSwapOrientation(pool, hop);
      
      expect(oriented.direction).toBe('BtoA');
      expect(oriented.inputIsA).toBe(false);
      expect(oriented.outputIsB).toBe(false);
      expect(oriented.poolVaultInput).toBe('VAULT_B');
      expect(oriented.poolVaultOutput).toBe('VAULT_A');
      expect(oriented.userAccountInput).toBe('USER_SOURCE');
      expect(oriented.userAccountOutput).toBe('USER_DEST');
      expect(oriented.decimalsInput).toBe(9);
      expect(oriented.decimalsOutput).toBe(6);
      expect(oriented.mintInput).toBe('MINT_B');
      expect(oriented.mintOutput).toBe('MINT_A');
    });
    
    it('should use pool decimals when available', () => {
      const hop: HopInfo = {
        inputMint: 'MINT_A',
        outputMint: 'MINT_B',
        userSourceAta: 'USER_SOURCE',
        userDestAta: 'USER_DEST',
        inputDecimals: 999, // Should be ignored in favor of pool decimals
        outputDecimals: 999,
      };
      
      const oriented = determineSwapOrientation(pool, hop);
      
      expect(oriented.decimalsInput).toBe(6); // From pool.decimals_a
      expect(oriented.decimalsOutput).toBe(9); // From pool.decimals_b
    });
    
    it('should fallback to hop decimals when pool decimals missing', () => {
      const poolWithoutDecimals: PoolInfo = {
        mint_a: 'MINT_A',
        mint_b: 'MINT_B',
      };
      
      const hop: HopInfo = {
        inputMint: 'MINT_A',
        outputMint: 'MINT_B',
        userSourceAta: 'USER_SOURCE',
        userDestAta: 'USER_DEST',
        inputDecimals: 8,
        outputDecimals: 12,
      };
      
      const oriented = determineSwapOrientation(poolWithoutDecimals, hop);
      
      expect(oriented.decimalsInput).toBe(8);
      expect(oriented.decimalsOutput).toBe(12);
    });
    
    it('should use default decimals when both pool and hop decimals missing', () => {
      const poolWithoutDecimals: PoolInfo = {
        mint_a: 'MINT_A',
        mint_b: 'MINT_B',
      };
      
      const hop: HopInfo = {
        inputMint: 'MINT_A',
        outputMint: 'MINT_B',
        userSourceAta: 'USER_SOURCE',
        userDestAta: 'USER_DEST',
      };
      
      const oriented = determineSwapOrientation(poolWithoutDecimals, hop);
      
      expect(oriented.decimalsInput).toBe(6); // Default
      expect(oriented.decimalsOutput).toBe(6); // Default
    });
    
    it('should handle missing vault addresses', () => {
      const poolWithoutVaults: PoolInfo = {
        mint_a: 'MINT_A',
        mint_b: 'MINT_B',
        decimals_a: 6,
        decimals_b: 9,
      };
      
      const hop: HopInfo = {
        inputMint: 'MINT_A',
        outputMint: 'MINT_B',
        userSourceAta: 'USER_SOURCE',
        userDestAta: 'USER_DEST',
      };
      
      const oriented = determineSwapOrientation(poolWithoutVaults, hop);
      
      expect(oriented.poolVaultInput).toBeUndefined();
      expect(oriented.poolVaultOutput).toBeUndefined();
      expect(oriented.userAccountInput).toBe('USER_SOURCE');
      expect(oriented.userAccountOutput).toBe('USER_DEST');
    });
  });
  
  describe('verifySwapOrientation', () => {
    it('should verify valid AtoB orientation', () => {
      const hop: HopInfo = {
        inputMint: 'MINT_A',
        outputMint: 'MINT_B',
        userSourceAta: 'USER_SOURCE',
        userDestAta: 'USER_DEST',
      };
      
      const oriented = determineSwapOrientation(pool, hop);
      const verification = verifySwapOrientation(pool, hop, oriented);
      
      expect(verification.valid).toBe(true);
      expect(verification.errors).toHaveLength(0);
    });
    
    it('should verify valid BtoA orientation', () => {
      const hop: HopInfo = {
        inputMint: 'MINT_B',
        outputMint: 'MINT_A',
        userSourceAta: 'USER_SOURCE',
        userDestAta: 'USER_DEST',
      };
      
      const oriented = determineSwapOrientation(pool, hop);
      const verification = verifySwapOrientation(pool, hop, oriented);
      
      expect(verification.valid).toBe(true);
      expect(verification.errors).toHaveLength(0);
    });
    
    it('should detect invalid input mint', () => {
      const hop: HopInfo = {
        inputMint: 'WRONG_MINT',
        outputMint: 'MINT_B',
        userSourceAta: 'USER_SOURCE',
        userDestAta: 'USER_DEST',
      };
      
      const oriented = determineSwapOrientation(pool, hop);
      const verification = verifySwapOrientation(pool, hop, oriented);
      
      expect(verification.valid).toBe(false);
      expect(verification.errors.length).toBeGreaterThan(0);
      expect(verification.errors.some(e => e.includes('Input mint mismatch'))).toBe(true);
    });
    
    it('should detect invalid output mint', () => {
      const hop: HopInfo = {
        inputMint: 'MINT_A',
        outputMint: 'WRONG_MINT',
        userSourceAta: 'USER_SOURCE',
        userDestAta: 'USER_DEST',
      };
      
      const oriented = determineSwapOrientation(pool, hop);
      const verification = verifySwapOrientation(pool, hop, oriented);
      
      expect(verification.valid).toBe(false);
      expect(verification.errors.length).toBeGreaterThan(0);
      expect(verification.errors.some(e => e.includes('Output mint mismatch'))).toBe(true);
    });
    
    it('should detect direction inconsistency', () => {
      const hop: HopInfo = {
        inputMint: 'MINT_A',
        outputMint: 'MINT_B',
        userSourceAta: 'USER_SOURCE',
        userDestAta: 'USER_DEST',
      };
      
      const oriented = determineSwapOrientation(pool, hop);
      
      // Manually corrupt the orientation
      const corruptedOriented = {
        ...oriented,
        direction: 'AtoB' as const,
        inputIsA: false, // This is wrong for AtoB
        outputIsB: false, // This is wrong for AtoB
      };
      
      const verification = verifySwapOrientation(pool, hop, corruptedOriented);
      
      expect(verification.valid).toBe(false);
      expect(verification.errors.some(e => e.includes('Direction AtoB but flags inconsistent'))).toBe(true);
    });
  });
});

