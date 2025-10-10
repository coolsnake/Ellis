import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'docs', 'metadata', 'routes.json');
const OUT = join(ROOT, 'docs', 'reference', 'api.md');

async function main() {
  let routes;
  try {
    routes = JSON.parse(await readFile(SRC, 'utf8'));
  } catch {
    routes = null;
  }
  const parts = ['# API', ''];
  if (!routes) {
    parts.push('_No routes metadata found. Add docs/metadata/routes.json to populate this page._');
  } else {
    parts.push('| Method | Path | Description | Auth |', '|---|---|---|---|');
    for (const r of routes) {
      parts.push(`| ${r.method} | ${r.path} | ${r.description || ''} | ${r.auth || ''} |`);
    }
  }
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, parts.join('\n'), 'utf8');
  console.log(`Wrote ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
