import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PRESETS = join(ROOT, 'docs', 'metadata', 'strategy-presets.json');
const PARAMS = join(ROOT, 'docs', 'metadata', 'parameters.json');
const OUT_DIR = join(ROOT, 'docs', 'user-guide', 'strategies');

function linkForParam(key) { return `../../parameters/catalog.md#${key}`; }

function pageForStrategy(name, presets, paramIndex) {
  const title = name[0].toUpperCase() + name.slice(1);
  const tl = `# ${title} Strategy\n\nTL;DR\n- What it does: see chooser\n- Presets: Safe, Balanced, Aggressive\n- Tune via key parameters below\n`;
  const tuningRows = Object.values(paramIndex)
    .filter(p => (p.strategies || []).includes(name))
    .map(p => {
      const safe = presets.find(x => x.name === 'Safe')?.parameters?.[p.key];
      const bal = presets.find(x => x.name === 'Balanced')?.parameters?.[p.key];
      const agg = presets.find(x => x.name === 'Aggressive')?.parameters?.[p.key];
      return `| [${p.label}](${linkForParam(p.key)}) | ${p.purpose || ''} | ${safe ?? ''} | ${bal ?? ''} | ${agg ?? ''} |`;
    }).join('\n');
  const tuning = `## Tuning guide\n\n| Parameter | Purpose | Safe | Balanced | Aggressive |\n|---|---|---|---|---|\n${tuningRows}\n`;

  const presetSections = presets.map(pr => {
    const rows = Object.entries(pr.parameters || {})
      .map(([k, v]) => `- [${k}](${linkForParam(k)}): ${v}`).join('\n');
    return `## ${pr.name} preset\n${pr.description ? pr.description + '\n' : ''}${pr.risks ? `> Risk: ${pr.risks}\n` : ''}\n${rows || '_No parameters defined_'}\n`;
  }).join('\n');

  return [tl, '## When to use / not to use', '', tuning, presetSections].join('\n');
}

async function main() {
  const presets = JSON.parse(await readFile(PRESETS, 'utf8'));
  const params = JSON.parse(await readFile(PARAMS, 'utf8'));
  const paramIndex = Object.fromEntries(params.map(p => [p.key, p]));
  await mkdir(OUT_DIR, { recursive: true });

  const chooser = `# Strategy Chooser\n\n- Threshold: event-driven arb with min profit filter.\n- Grid: range-trading with spaced orders.\n\nSee individual pages for presets and tuning.\n`;
  await writeFile(join(OUT_DIR, 'index.md'), chooser, 'utf8');

  for (const s of presets) {
    const name = s.strategy;
    const md = pageForStrategy(name, s.presets || [], paramIndex);
    await writeFile(join(OUT_DIR, `${name}.md`), md, 'utf8');
  }
  console.log(`Wrote strategy pages to ${OUT_DIR}`);
}

main().catch(e => { console.error(e); process.exit(1); });
