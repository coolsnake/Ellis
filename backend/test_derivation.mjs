import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

const PUMPSWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const onChainCreator = new PublicKey('JAQxz7QgBJCqf2g5d2SPGpXt1rFvEpaaHTZruJACHmua'); // From pool account parsing
const quoteMint = new PublicKey('So11111111111111111111111111111111111111112'); // SOL

// Derive vault authority
const [vaultAuthority] = PublicKey.findProgramAddressSync(
  [
    Buffer.from('creator_vault'),
    onChainCreator.toBuffer(),
  ],
  PUMPSWAP_PROGRAM_ID
);

console.log('On-chain creator:', onChainCreator.toBase58());
console.log('Vault authority:', vaultAuthority.toBase58());

// Derive vault ATA
const vaultAta = getAssociatedTokenAddressSync(
  quoteMint,
  vaultAuthority,
  true
);

console.log('Vault ATA:', vaultAta.toBase58());

