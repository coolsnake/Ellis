import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'docs', 'metadata', 'glossary.json');
const OUT = join(ROOT, 'docs', 'reference', 'glossary.md');

async function main() {
  const terms = JSON.parse(await readFile(SRC, 'utf8'));
  terms.sort((a, b) => a.term.localeCompare(b.term));
  const parts = ['# Glossary', ''];
  for (const t of terms) {
    parts.push(`<a id="${t.term.toLowerCase().replace(/\s+/g, '-')}"></a>`);
    parts.push(`## ${t.term}\n\n${t.definition}\n`);
  }
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, parts.join('\n'), 'utf8');
  console.log(`Wrote ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
