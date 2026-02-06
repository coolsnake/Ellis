const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'backend', 'src', 'drift', 'client.ts');
let content = fs.readFileSync(filePath, 'utf8');
console.log('File length:', content.length);

// Detect line ending
const crlf = content.includes('\r\n');
const nl = crlf ? '\r\n' : '\n';
console.log('CRLF:', crlf);

// Split into lines for line-based replacements
const lines = content.split(nl);
console.log('Total lines:', lines.length);

let changeCount = 0;

function replaceLine(lineNum, oldPattern, newLine) {
  const idx = lineNum - 1;
  if (idx < 0 || idx >= lines.length) {
    console.log(`Line ${lineNum} out of range`);
    return;
  }
  const line = lines[idx];
  if (line.includes(oldPattern)) {
    lines[idx] = newLine;
    changeCount++;
    console.log(`Fixed line ${lineNum}`);
  } else {
    console.log(`Pattern not found on line ${lineNum}: expected "${oldPattern.substring(0,50)}" but found "${line.trim().substring(0,50)}"`);
  }
}

// Find lines matching } catch { without (e: any) and not timer cleanup
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const trimmed = line.trim();
  if (trimmed.includes('} catch {') && !trimmed.includes('catch (e') && !trimmed.includes('timer cleanup safe to swallow')) {
    console.log(`Line ${i+1}: ${trimmed.substring(0,100)}`);
  }
}

console.log('---');
console.log('Changes:', changeCount);
