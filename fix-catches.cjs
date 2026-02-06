const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'backend', 'src', 'drift', 'client.ts');
let content = fs.readFileSync(filePath, 'utf8');
const crlf = content.includes('\r\n');
const nl = crlf ? '\r\n' : '\n';
const lines = content.split(nl);
console.log('Total lines:', lines.length, 'CRLF:', crlf);

// Find all lines with empty catch blocks
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const trimmed = line.trim();
  if (trimmed.includes('} catch {') && !trimmed.includes('catch (e') && !trimmed.includes('timer cleanup')) {
    console.log('Line ' + (i+1) + ': ' + trimmed.substring(0, 120));
  }
}
