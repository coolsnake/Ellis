const fs = require('fs');
const path = require('path');

// Input files
const inputFiles = [
  'soldocs/JupLSTTokens.json',
  'soldocs/JupOrganic100.json',
  'soldocs/JupToptraded.json',
  'soldocs/JupTopTrending.json',
  'soldocs/JupVerfifiedTokens.json'
];

// Output file
const outputFile = 'soldocs/JupMergedTokens.json';

// Map to store unique tokens by address (id)
const tokenMap = new Map();

// Process each input file
for (const file of inputFiles) {
  const filePath = path.join(__dirname, '..', file);
  console.log(`Processing: ${file}`);
  
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  
  for (const token of data) {
    // Only add if we haven't seen this token yet (deduplicate by id)
    if (!tokenMap.has(token.id)) {
      // Transform to JupToken structure (including tokenProgram)
      tokenMap.set(token.id, {
        address: token.id,
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals,
        tokenProgram: token.tokenProgram,
        usdPrice: token.usdPrice
      });
    }
  }
  
  console.log(`  Found ${data.length} tokens, ${tokenMap.size} unique so far`);
}

// Convert map to array and write output
const mergedTokens = Array.from(tokenMap.values());

fs.writeFileSync(
  path.join(__dirname, '..', outputFile),
  JSON.stringify(mergedTokens, null, 2),
  'utf8'
);

console.log(`\nMerged ${mergedTokens.length} unique tokens to ${outputFile}`);
