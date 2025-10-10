import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'docs', 'metadata', 'configs.json');
const OUT = join(ROOT, 'docs', 'reference', 'config-files.md');

async function trySample(filePath) {
  try {
    const raw = await readFile(join(ROOT, filePath), 'utf8');
    const trimmed = raw.split('\n').slice(0, 30).join('\n');
    return '```json\n' + trimmed + '\n```';
  } catch {
    return '_File not found at build time._';
  }
}

async function main() {
  const cfg = JSON.parse(await readFile(SRC, 'utf8'));
  const parts = ['# Config Files', ''];
  for (const f of cfg.files || []) {
    parts.push(`## ${f.path}`, '', f.purpose || '', '');
    if (f.keys?.length) {
      parts.push('Keys:', ...f.keys.map(k => `- ${k.name}: ${k.description || ''}`), '');
    }
    parts.push('Example:', await trySample(f.path), '');
  }
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, parts.join('\n'), 'utf8');
  console.log(`Wrote ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
