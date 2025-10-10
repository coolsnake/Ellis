import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'docs', 'metadata', 'troubleshooting.json');
const OUT = join(ROOT, 'docs', 'troubleshooting', 'index.md');

async function main() {
  const items = JSON.parse(await readFile(SRC, 'utf8'));
  const parts = ['# Troubleshooting', ''];
  for (const it of items) {
    parts.push(`## ${it.symptom}`, '');
    if (it.checks?.length) {
      parts.push('Checks:', ...it.checks.map(c => `- ${c}`), '');
    }
    if (it.links?.length) {
      parts.push('See also:', ...it.links.map(l => `- ${l}`), '');
    }
  }
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, parts.join('\n'), 'utf8');
  console.log(`Wrote ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
