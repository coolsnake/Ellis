const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'backend', 'src', 'drift', 'client.ts');
let content = fs.readFileSync(filePath, 'utf8');

// Show context around each catch block for verification
const lines = content.split(/\r?\n/);
const targets = [1543, 1684, 1722, 1868, 1901, 1919, 2069, 2084, 2157, 2175, 2306];
for (const ln of targets) {
  const idx = ln - 1;
  const start = Math.max(0, idx - 3);
  const end = Math.min(lines.length - 1, idx + 3);
  console.log('=== Line ' + ln + ' ===');
  for (let i = start; i <= end; i++) {
    const marker = i === idx ? '>>>' : '   ';
    console.log(marker + ' ' + (i+1) + ': ' + lines[i].substring(0, 130));
  }
  console.log('');
}
