import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = resolve(process.argv.find((value) => value.startsWith('--output='))?.slice(9) ?? join(root, 'docs/final-evidence/external'));
const tempParent = resolve(process.env.RUN_TMP ?? join(root, '.local/external-rehearsal/tmp'));
await mkdir(tempParent, { recursive: true });
const temporary = await mkdtemp(join(tempParent, 'run-'));
const cache = join(temporary, 'cache'); await mkdir(cache);
await mkdir(output, { recursive: true });
const environment = { ...process.env, RUN_TMP: temporary, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
  XDG_CACHE_HOME: cache, PYTHONPYCACHEPREFIX: join(cache, 'python'), BUBBLE_DATABASE_URL: '', BUBBLE_MEC_ENCRYPTION_KEY: '' };
const steps = [
  { id: 'configured-runners', args: ['--test', '--test-reporter=tap', 'pc-mobius/test/external-runner.test.mjs', 'pc-mobius/test/external-scenarios.test.mjs', 'pc-mobius/test/external-fl.test.mjs', 'pc-mobius/test/external-edge-callback.test.mjs', 'pc-mobius/test/external-worker-config.test.mjs'] },
  { id: 'mec-M01-M09', args: ['--test', '--test-reporter=tap', 'pc-mobius/test/mec-http.test.mjs', 'pc-mobius/test/mec-trigger.test.mjs', 'pc-mobius/test/mec-deployment-schema.test.mjs'] },
  { id: 'handover-faults', args: ['--test', '--test-reporter=tap', 'pc-mobius/test/handover-http.test.mjs'] },
  { id: 'fl-faults', args: ['--test', '--test-reporter=tap', 'pc-mobius/test/fl-coordinator.test.mjs'] },
  { id: 'fl-numeric', args: ['pc-mobius/scripts/run-fl-verification.mjs', `--output=${join(temporary, 'fl')}`] },
];
const summary = { generatedAt: new Date().toISOString(), status: 'PASS', mode: 'LOCAL_SIMULATION',
  externalServicesCalled: false, physicalHosts: 1, baseline: 'Root setup and all 13 verify stages passed, supplied by lead; not repeated.',
  steps: [], artifacts: [], cleanup: { temporary, cache, status: 'PENDING' } };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cancellation = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => cancellation.abort());
try {
  for (const step of steps) {
    const started = Date.now();
    const child = spawn(process.execPath, step.args, { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'], signal: cancellation.signal, timeout: 180000 });
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; }); child.stderr.on('data', (chunk) => { text += chunk; });
    const exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
    const log = `${step.id}.log`; await writeFile(join(output, log), text);
    summary.steps.push({ id: step.id, command: [process.execPath, ...step.args], exitCode, milliseconds: Date.now() - started,
      log, sha256: hash(text), passed: Number(text.match(/# pass (\d+)/)?.[1] ?? 0), failed: Number(text.match(/# fail (\d+)/)?.[1] ?? 0) });
    console.log(JSON.stringify({ scenario: step.id, exitCode, log }));
    if (exitCode !== 0) summary.status = 'FAIL';
  }
  for (const file of await readdir(join(temporary, 'fl'))) if (/^(report\.json|model-\d+\.f32|manifest-\d+\.json)$/.test(file)) {
    const target = `fl-${file}`; await copyFile(join(temporary, 'fl', file), join(output, target));
    const bytes = await readFile(join(output, target)); summary.artifacts.push({ file: target, bytes: bytes.length, sha256: hash(bytes) });
  }
} catch (error) {
  summary.status = 'FAIL'; summary.error = error instanceof Error ? error.name : 'UnknownError';
} finally {
  await rm(temporary, { recursive: true, force: true });
  summary.cleanup.status = 'REMOVED';
  summary.cleanup.receipt = 'Only this run-created directory was removed recursively; child handles settled before removal.';
  await writeFile(join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}
if (summary.status !== 'PASS') process.exitCode = 1;
console.log(JSON.stringify({ status: summary.status, summary: join(output, 'summary.json'), cleanup: summary.cleanup.status }));
