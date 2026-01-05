/**
 * Debug script to verify Orca tick array PDA derivation
 * 
 * Run with: npx tsx backend/src/scripts/debugTickArrayPda.ts <poolId>
 */

import { PublicKey, Connection } from '@solana/web3.js';

const ORCA_WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const ORCA_TICK_ARRAY_SIZE = 88;

function deriveOrcaTickArrayPda(poolId: PublicKey, startTickIndex: number): PublicKey {
  // CRITICAL: Orca SDK encodes startTick as ASCII string, not binary i32
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('tick_array'), poolId.toBuffer(), Buffer.from(startTickIndex.toString())],
    ORCA_WHIRLPOOL_PROGRAM
  );
  return pda;
}

async function main() {
  const poolIdArg = process.argv[2];
  if (!poolIdArg) {
    console.error('Usage: npx tsx backend/src/scripts/debugTickArrayPda.ts <poolId>');
    console.error('Example: npx tsx backend/src/scripts/debugTickArrayPda.ts u41JpbKrcPuzJwRTPU6gDysoFqKPpEZe9YmHdszQTJ1');
    process.exit(1);
  }

  const poolPk = new PublicKey(poolIdArg);
  console.log(`\n=== Orca Tick Array PDA Derivation Debug ===`);
  console.log(`Pool: ${poolPk.toBase58()}`);
  
  // Connect to mainnet
  const connection = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com');
  
  // Fetch pool account
  console.log(`\nFetching pool account...`);
  const accountInfo = await connection.getAccountInfo(poolPk);
  if (!accountInfo) {
    console.error('Pool account not found!');
    process.exit(1);
  }
  
  console.log(`Owner: ${accountInfo.owner.toBase58()}`);
  console.log(`Data length: ${accountInfo.data.length}`);
  
  // Decode pool state
  const data = Buffer.from(accountInfo.data);
  
  // Skip discriminator (8) + config (32) + bump (1) = 41
  const tickSpacing = data.readUInt16LE(41);
  // Skip to tickCurrentIndex
  // 8 + 32 + 1 + 2 + 2 + 2 + 2 + 16 + 16 = 81
  const currentTick = data.readInt32LE(81);
  
  console.log(`\n=== Pool State ===`);
  console.log(`Tick Spacing: ${tickSpacing}`);
  console.log(`Current Tick: ${currentTick}`);
  
  // Calculate tick array indices
  const ticksInArray = ORCA_TICK_ARRAY_SIZE * tickSpacing;
  const centerIdx = Math.floor(currentTick / ticksInArray);
  
  console.log(`\n=== Tick Array Calculation ===`);
  console.log(`Ticks per Array: ${ticksInArray}`);
  console.log(`Center Index: ${centerIdx}`);
  
  // Derive tick arrays for range [-3, +3] and check existence
  console.log(`\n=== Tick Array PDAs ===`);
  
  const tickArrayPdas: { offset: number; pda: PublicKey; startTick: number }[] = [];
  for (let i = -3; i <= 3; i++) {
    const startTick = (centerIdx + i) * ticksInArray;
    const pda = deriveOrcaTickArrayPda(poolPk, startTick);
    tickArrayPdas.push({ offset: i, pda, startTick });
  }
  
  // Batch check existence
  const pdaKeys = tickArrayPdas.map(p => p.pda);
  const accountInfos = await connection.getMultipleAccountsInfo(pdaKeys);
  
  for (let i = 0; i < tickArrayPdas.length; i++) {
    const { offset, pda, startTick } = tickArrayPdas[i];
    const info = accountInfos[i];
    const exists = info && info.owner.equals(ORCA_WHIRLPOOL_PROGRAM);
    const marker = offset === 0 ? ' <-- CENTER' : '';
    
    console.log(`  [${offset >= 0 ? '+' : ''}${offset}] startTick=${startTick.toString().padStart(8)} PDA=${pda.toBase58().slice(0, 12)}... ${exists ? '✅ EXISTS' : '❌ NOT FOUND'}${marker}`);
  }
  
  // Compare with the tick arrays from the user's transaction
  console.log(`\n=== Compare with Transaction Tick Arrays ===`);
  console.log(`From your transaction:`);
  console.log(`  Tick Array 0: 9H4zxzzS8hZU3h44gR3AwbwNxp3t79siVxGGN3PipqFF`);
  console.log(`  Tick Array 1: B7YR2vDb23Aa2Ad1Y1m85naE7zmJse4yg1TJaGWjRjDJ`);
  console.log(`  Tick Array 2: 7uKDD2tipNLnuAhQeY93wGMu7ms5yy8K9bcvWGCfHcAD`);
  
  // Check if any of our derived PDAs match
  const txTickArrays = [
    '9H4zxzzS8hZU3h44gR3AwbwNxp3t79siVxGGN3PipqFF',
    'B7YR2vDb23Aa2Ad1Y1m85naE7zmJse4yg1TJaGWjRjDJ',
    '7uKDD2tipNLnuAhQeY93wGMu7ms5yy8K9bcvWGCfHcAD',
  ];
  
  const derivedAddresses = tickArrayPdas.map(p => p.pda.toBase58());
  const matches = txTickArrays.filter(addr => derivedAddresses.includes(addr));
  
  console.log(`\n=== Match Analysis ===`);
  if (matches.length > 0) {
    console.log(`✅ ${matches.length} tick arrays from transaction MATCH our derivation!`);
    matches.forEach(m => console.log(`  - ${m}`));
  } else {
    console.log(`❌ NO MATCHES! Our derivation may be wrong.`);
    console.log(`\nDerived PDAs:`);
    tickArrayPdas.forEach(p => console.log(`  startTick=${p.startTick}: ${p.pda.toBase58()}`));
  }
}

main().catch(console.error);
