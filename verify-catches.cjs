const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'backend', 'src', 'drift', 'client.ts');
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split(/\r?\n/);
let remaining = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const trimmed = line.trim();
  if (trimmed.includes('} catch {') && !trimmed.includes('catch (e')) {
    remaining++;
    console.log('Line ' + (i+1) + ': ' + trimmed.substring(0, 140));
  }
}
console.log('\nRemaining empty catch blocks: ' + remaining);
