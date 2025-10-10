import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'docs', 'metadata', 'parameters.json');
const OUT = join(ROOT, 'docs', 'parameters', 'catalog.md');

function esc(s) { return String(s ?? '').replace(/\|/g, '\\|'); }

function sectionForParam(p) {
  const badges = [
    `Type: ${esc(p.type)}`,
    `Default: ${esc(p.default)}`,
    p.min != null ? `Min: ${esc(p.min)}` : null,
    p.max != null ? `Max: ${esc(p.max)}` : null
  ].filter(Boolean).join(' • ');
  const ranges = (p.recommendedRanges || [])
    .map(r => `- ${esc(r.market)}: ${esc(r.range)}`).join('\n');
  const examples = (p.examples || []).map(e => `- ${esc(e)}`).join('\n');
  const strategies = (p.strategies || []).join(', ');

  return [
    `<a id="${p.key}"></a>`,
    `## ${p.label} (${p.key})`,
    '',
    `> ${badges}`,
    '',
    `**Purpose**: ${p.purpose || ''}`,
    `**When to change**: ${p.whenToChange || ''}`,
    `**Risks**: ${p.risks || ''}`,
    p.rationale ? `**Rationale**: ${p.rationale}` : '',
    '',
    ranges ? '### Recommended ranges\n' + ranges : '',
    '',
    examples ? '### Examples\n' + examples : '',
    '',
    strategies ? `Used by: ${strategies}` : ''
  ].filter(Boolean).join('\n');
}

async function main() {
  const raw = await readFile(SRC, 'utf8');
  const params = JSON.parse(raw);
  const byCategory = {};
  for (const p of params) {
    if (!p.key || !p.label) throw new Error(`Invalid param entry: ${JSON.stringify(p)}`);
    byCategory[p.category || 'other'] ||= [];
    byCategory[p.category || 'other'].push(p);
  }
  for (const k of Object.keys(byCategory)) {
    byCategory[k].sort((a, b) => a.key.localeCompare(b.key));
  }
  const parts = [
    '# Parameters Catalog',
    'Use anchors (copy link) to reference parameters from the UI tooltips.',
    ''
  ];
  for (const [cat, list] of Object.entries(byCategory)) {
    parts.push(`### ${cat[0].toUpperCase()}${cat.slice(1)}`);
    parts.push('');
    for (const p of list) parts.push(sectionForParam(p), '');
  }
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, parts.join('\n'), 'utf8');
  console.log(`Wrote ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
