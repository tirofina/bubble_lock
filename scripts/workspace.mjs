import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2] ?? 'verify';
if (!['setup', 'test', 'verify'].includes(mode)) throw new Error('setup/test/verify 모드를 선택하세요.');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm run setup, npm test, npm run verify로 실행하세요.');
const envPython = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
let python = existsSync(envPython) ? envPython : process.env.PYTHON ?? 'python';
const logRoot = join(root, '.local', 'verification', mode);
mkdirSync(logRoot, { recursive: true });
const results = [];

function run(label, executable, args, cwd = root, env = {}) {
  console.log(`\n[${label}]`);
  const started = Date.now();
  const result = spawnSync(executable, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? String(result.error) : ''}`;
  process.stdout.write(output);
  const log = `${String(results.length + 1).padStart(2, '0')}-${label}.log`;
  writeFileSync(join(logRoot, log), output);
  results.push({ label, exitCode: result.status, durationMs: Date.now() - started, log, sha256: createHash('sha256').update(output).digest('hex') });
  writeFileSync(join(logRoot, 'results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, mode, status: results.every((r) => r.exitCode === 0) ? 'RUNNING' : 'FAIL', results }, null, 2) + '\n');
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const npm = (label, folder, ...args) => run(label, process.execPath, [npmCli, ...args], join(root, folder));
if (mode === 'setup') {
  npm('core-install', 'pc-mobius', 'ci');
  npm('web-install', 'web-dashboard', 'ci');
  if (!existsSync(envPython)) run('python-environment', python, ['-m', 'venv', join(root, '.venv')]);
  python = envPython;
  run('gateway-install', python, ['-m', 'pip', 'install', '-e', join(root, 'keyring/raspberry-pi-gateway')]);
  run('verification-install', python, ['-m', 'pip', 'install', '-r', join(root,'tests/requirements.txt')]);
} else {
  npm('core-tests', 'pc-mobius', 'test');
  npm('web-tests', 'web-dashboard', 'test');
  run('gateway-tests', python, ['-m', 'unittest', 'discover', '-s', 'tests', '-v'], join(root, 'keyring/raspberry-pi-gateway'), {
    PYTHONPATH: [join(root, 'keyring/raspberry-pi-gateway/src'), join(root, 'keyring/raspberry-pi-gateway/tests')].join(delimiter),
    PYTHONIOENCODING: 'utf-8'
  });
  run('cross-runtime-mtls', python, ['-m', 'unittest', 'discover', '-s', 'tests/integration', '-v'], root, { PYTHONIOENCODING: 'utf-8' });
  if (mode === 'verify') {
    run('sdt-xsd-closure',python,['pc-mobius/scripts/build-sdt-closure.py'],root,{PYTHONIOENCODING:'utf-8'});
    npm('core-contract', 'pc-mobius', 'run', 'validate');
    npm('canonical-sdt-contract','pc-mobius','run','validate','--','contracts/oneM2M-test-contract.v2.json');
    npm('integration-contract', 'pc-mobius', 'run', 'integration:validate');
    npm('onem2m-dry-run', 'pc-mobius', 'run', 'dry-run');
    npm('integration-demo', 'pc-mobius', 'run', 'integration');
    npm('integration-replay', 'pc-mobius', 'run', 'integration:replay');
    npm('web-contract-types', 'web-dashboard', 'run', 'typecheck:contract');
    npm('web-build', 'web-dashboard', 'run', 'build');
  }
}
writeFileSync(join(logRoot, 'results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, mode, status: 'PASS', results }, null, 2) + '\n');
console.log(`\n검증 기록: ${join(logRoot, 'results.json')}`);
