import { PublicKey } from '@solana/web3.js';

/**
 * Sanitizes a key string by trimming and removing reverse suffix
 */
export function sanitizeKeyString(v: any): string {
  try {
    return String(v || '').trim().replace(/-rev$/, '');
  } catch {
    return '';
  }
}

/**
 * Checks if a PublicKey-like value is valid (not a placeholder)
 */
export function isValidPublicKey(value: any): boolean {
  try {
    if (!value) return false;
    
    let keyString: string;
    if (value instanceof PublicKey) {
      keyString = value.toBase58();
    } else if (typeof value === 'string') {
      keyString = value.trim();
    } else if (value && typeof value === 'object') {
      // Try to extract string representation
      keyString = String(value.toBase58?.() || value.toString?.() || value.address || value.pubkey || '');
    } else {
      return false;
    }

    // Check for placeholder keys (common pattern: all 1s)
    if (/^11111+$/.test(keyString)) {
      return false;
    }

    // Check for system default
    if (keyString === PublicKey.default.toBase58()) {
      return false;
    }

    // Try to construct PublicKey to validate format
    new PublicKey(keyString);
    return true;
  } catch {
    return false;
  }
}

/**
 * Type-safe PublicKey coercion with improved placeholder detection
 */
export function coerceToPublicKey(value: any, fallback?: any): PublicKey {
  const primary = sanitizeKeyString(value);
  try {
    if (primary) {
      const pk = new PublicKey(primary);
      // Validate it's not a placeholder
      if (!isValidPublicKey(pk)) {
        throw new Error('Placeholder key detected');
      }
      return pk;
    }
  } catch {}

  const fb = sanitizeKeyString(fallback);
  if (fb) {
    try {
      const pk = new PublicKey(fb);
      if (isValidPublicKey(pk)) {
        return pk;
      }
    } catch {}
  }

  throw new Error(`Invalid PublicKey: primary=${String(value)}, fallback=${String(fallback)}`);
}

/**
 * Normalizes a PublicKey from various SDK formats
 * Handles different SDK versions and their PublicKey representations
 */
export function normalizePublicKey(value: any): PublicKey {
  try {
    // Already a PublicKey instance
    if (value instanceof PublicKey) {
      return value;
    }

    // Extract inner value from various SDK formats
    const inner = (value && (value.address || value.pubkey || value.pubKey || value.publicKey)) || value;

    // Try byte-based paths first (most reliable)
    if (inner && typeof inner.toBytes === 'function') {
      try {
        return new PublicKey(inner.toBytes());
      } catch {}
    }

    if (inner && typeof inner.toBuffer === 'function') {
      try {
        return new PublicKey(inner.toBuffer());
      } catch {}
    }

    // Handle PublicKey-like objects from different web3.js instances
    // Check for toBase58 method before trying other paths
    if (inner && typeof inner.toBase58 === 'function') {
      try {
        return new PublicKey(inner.toBase58());
      } catch {}
    }

    // Handle BN-like internals (some SDKs use BN internally)
    if (inner && typeof inner === 'object') {
      const bn = (inner as any)._bn || (inner as any).bn || (inner as any).value;
      if (bn && typeof bn === 'object') {
        if (typeof bn.toArrayLike === 'function') {
          try {
            return new PublicKey(bn.toArrayLike(Uint8Array, 'be', 32));
          } catch {}
        }
        if (typeof bn.toArray === 'function') {
          try {
            return new PublicKey(Uint8Array.from(bn.toArray('be', 32)));
          } catch {}
        }
      }
    }

    // Direct byte array
    if (Array.isArray(inner) && inner.length >= 32) {
      try {
        return new PublicKey(Uint8Array.from(inner));
      } catch {}
    }

    // String fallback
    if (typeof inner === 'string') {
      return new PublicKey(inner);
    }

    // Final attempt: stringify
    return new PublicKey(String(inner));
  } catch (e) {
    // If normalization fails, try coerceToPublicKey as fallback
    return coerceToPublicKey(value);
  }
}

