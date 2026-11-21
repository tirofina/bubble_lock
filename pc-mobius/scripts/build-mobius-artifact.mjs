import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { applyMobiusDependencies } from './apply-mobius-dependencies.mjs';

const execute = promisify(execFile);
const npmCli = process.env.npm_execpath ?? (process.platform === 'win32' ? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : null);
const windowsGnuTar = 'C:/Program Files/Git/usr/bin/tar.exe';
const releaseTar = process.platform === 'win32' && existsSync(windowsGnuTar) ? windowsGnuTar : 'tar';
const releaseTarEnv = releaseTar === windowsGnuTar
  ? { ...process.env, PATH: `${dirname(windowsGnuTar)}${delimiter}${process.env.PATH ?? ''}` }
  : process.env;
const root = fileURLToPath(new URL('../..', import.meta.url));
const deployment = join(root, 'deployment/cse');
const pin = JSON.parse(await readFile(join(deployment, 'upstream.json'), 'utf8'));
assert.match(pin.revision, /^[a-f0-9]{40}$/);
const temporary = resolve(process.env.RUN_TMP);
const output = resolve(process.env.CSE_ARTIFACT_DIR ?? join(deployment, 'artifacts'));
const archive = join(temporary, 'upstream.tar.gz');
await mkdir(temporary, { recursive: true });
await mkdir(output, { recursive: true });
await execute('curl', ['-fL', '--retry', '2', pin.archive, '-o', archive]);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
assert.equal(sha256(await readFile(archive)), pin.archiveSHA256, 'upstream archive digest');
// Extract to a dedicated build directory; a previous installed checkout stays untouched.
const staging = await mkdtemp(join(temporary, 'artifact-build-'));
await execute('tar', ['xzf', archive, '-C', staging]);
const preparedSource = join(staging, `mobius4-${pin.revision}`);
assert.equal(JSON.parse(await readFile(join(preparedSource, 'package.json'))).version, pin.version);
const dependencyPatch = await applyMobiusDependencies(preparedSource);
const repeatedDependencies = await applyMobiusDependencies(preparedSource);
assert.ok(repeatedDependencies.files.every((file) => file.status === 'ALREADY_APPLIED'));
await execute(npmCli ? process.execPath : 'npm', [...(npmCli ? [npmCli] : []), 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: preparedSource, env: process.env });
await execute(process.execPath, [join(root, 'pc-mobius/scripts/prepare-specialization.mjs'), '--mobius-root', preparedSource]);
const filename = `mobius4-${pin.revision}-upstream.tar.gz`;
const artifact = join(output, filename);
// prepare-specialization creates a timestamped operator backup; it is not release input.
const tarPath = (value) => releaseTar === windowsGnuTar ? value.replaceAll('\\', '/') : value;
await execute(releaseTar, [...(releaseTar === windowsGnuTar ? ['--force-local'] : []), '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--exclude=node_modules', '--exclude=./config/specializations.json.bak-*', '-I', 'gzip -n', '-cf', tarPath(artifact), '-C', tarPath(preparedSource), '.'], { env: releaseTarEnv });
const manifest = {
  ...pin, cseSource: 'upstream-unmodified', artifact: filename, artifactSHA256: sha256(await readFile(artifact)),
  lockSHA256: sha256(await readFile(join(preparedSource, 'package-lock.json'))),
  dependencyPatch, repeatedDependencies,
  dependencyPatcherSHA256: sha256(await readFile(join(root, 'pc-mobius/scripts/apply-mobius-dependencies.mjs'))),
};
await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ status: 'PACKAGED', artifact, ...manifest }, null, 2));
