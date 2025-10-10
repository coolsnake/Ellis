import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function run(nodeArgs) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, nodeArgs, { stdio: 'inherit', cwd: ROOT });
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
  });
}

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32' });
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`)));
  });
}

async function runMkDocsBuild() {
  // Try mkdocs CLI first (if on PATH)
  try {
    await runCmd('mkdocs', ['build', '--clean']);
    return;
  } catch {}
  // Windows Python launcher
  try {
    await runCmd('py', ['-m', 'mkdocs', 'build', '--clean']);
    return;
  } catch {}
  // Generic python/python3
  try {
    await runCmd('python', ['-m', 'mkdocs', 'build', '--clean']);
    return;
  } catch {}
  await runCmd('python3', ['-m', 'mkdocs', 'build', '--clean']);
}

async function main() {
  await run(['scripts/generate-params-docs.mjs']);
  await run(['scripts/generate-strategies.mjs']);
  await run(['scripts/generate-configs.mjs']);
  await run(['scripts/generate-api.mjs']);
  await run(['scripts/generate-glossary.mjs']);
  await run(['scripts/generate-troubleshooting.mjs']);
  try {
    await runMkDocsBuild();
  } catch (e) {
    console.error('MkDocs build failed. Ensure MkDocs is installed:\n  py -m pip install mkdocs mkdocs-material\n  (or) python -m pip install --user mkdocs mkdocs-material');
    throw e;
  }
  console.log('Docs built. Open site/index.html to view offline.');
}

main().catch(e => { console.error(e); process.exit(1); });
