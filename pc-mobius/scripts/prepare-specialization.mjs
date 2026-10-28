import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const rootArgIndex = args.indexOf('--mobius-root');
if (rootArgIndex >= 0 && !args[rootArgIndex + 1]) {
  throw new Error('--mobius-root requires the Mobius4 source directory path.');
}
const mobiusRoot = resolve(rootArgIndex >= 0 ? args[rootArgIndex + 1] : process.env.MOBIUS4_ROOT ?? '../../../../mobius4');
const sourceXsd = fileURLToPath(new URL('../specializations/binarySwitch.xsd', import.meta.url));
const configDir = join(mobiusRoot, 'config');
const specializationDir = join(configDir, 'privacy-bubble');
const targetXsd = join(specializationDir, 'binarySwitch.xsd');
const existingManifestPath = join(configDir, 'specializations.manifest.json');
const targetRegistry = join(configDir, 'specializations.json');
const temporaryManifest = join(configDir, '.privacy-bubble-specializations.manifest.json');
const cnd = 'org.onem2m.common.moduleclass.binarySwitch';
const xsdRelativeToManifest = 'privacy-bubble/binarySwitch.xsd';

if (!existsSync(mobiusRoot)) throw new Error(`Mobius4 root path required: ${mobiusRoot}`);
await mkdir(specializationDir, { recursive: true });
await copyFile(sourceXsd, targetXsd);

const previousManifest = existsSync(existingManifestPath)
  ? JSON.parse(await readFile(existingManifestPath, 'utf8'))
  : [];
const merged = previousManifest.filter((entry) => entry.cnd !== cnd);
merged.push({
  cnd,
  xsd: xsdRelativeToManifest,
  description: 'Privacy Bubble binary switch specialization managed by pc-mobius.'
});
await writeFile(temporaryManifest, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

if (existsSync(targetRegistry)) {
  const backup = `${targetRegistry}.bak-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}`;
  await copyFile(targetRegistry, backup);
  console.log(`Registry backup: ${backup}`);
}

const script = join(mobiusRoot, 'scripts', 'build-specializations.js');
await new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, [script, '--manifest', temporaryManifest, '--out', targetRegistry], {
    cwd: mobiusRoot,
    stdio: 'inherit'
  });
  child.on('error', reject);
  child.on('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`specialization build exit code: ${code}`)));
});
console.log(JSON.stringify({
  status: 'READY',
  mobiusRoot,
  cnd,
  xsd: targetXsd,
  registry: targetRegistry,
  next: 'Restart Mobius4 and run npm run validate && node scripts/run-contract.mjs'
}, null, 2));
