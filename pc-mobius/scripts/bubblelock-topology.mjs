/**
 * BubbleLock topology audit and additive reconciliation runner (DOC-REV 2.0.0).
 * The engine is ../multiapp/bubblelock-topology.mjs; this runner only chooses the transport.
 *
 * Direct HTTP (local Mobius4, or a CSE reachable without client certificates):
 *   node scripts/bubblelock-topology.mjs --spec <site.json> --endpoint <cse url> [--mode audit|plan|apply] [--confirm BubbleLock] [--out <report.json>]
 *   An admin originator for the read-only audit can come from the PB_CSE_ADMIN environment variable.
 * Server CSE through its container (the admin originator is read from the container environment and stays there):
 *   node scripts/bubblelock-topology.mjs --spec <site.json> --ssh <ssh target> --container <cse container> [--mode ...] [--confirm ...] [--out ...]
 *   The engine file is streamed over ssh stdin into `docker exec -i <container> node --input-type=module -`.
 *
 * The default mode is plan (read only). apply needs --mode apply and --confirm equal to the AE resource name.
 * Keep site specs and reports under .local/ (gitignored); they carry deployment names and device IDs.
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODES, normalizeSite, redactReport, runTopology } from '../multiapp/bubblelock-topology.mjs';

export const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '../multiapp/bubblelock-topology.mjs');
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SSH_TARGET = /^[A-Za-z0-9_][A-Za-z0-9_.@:-]{0,253}$/;
const RN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The remote command line; every interpolated value is validated against a shell-safe pattern. */
export function remoteCommand({ container, mode = 'plan', confirm = null, spec }) {
  if (!CONTAINER.test(String(container ?? ''))) throw new Error('--container: container name required');
  if (!MODES.includes(mode)) throw new Error(`--mode: one of ${MODES.join(', ')}`);
  if (confirm !== null && !RN.test(String(confirm))) throw new Error('--confirm: resource name required');
  normalizeSite(spec);
  const encoded = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
  const env = ['PB_TOPOLOGY_MAIN=1', `PB_TOPOLOGY_MODE=${mode}`, `PB_TOPOLOGY_SPEC_B64=${encoded}`, ...(confirm ? [`PB_TOPOLOGY_CONFIRM=${confirm}`] : [])];
  return ['docker', 'exec', '-i', ...env.flatMap((item) => ['-e', item]), container, 'node', '--input-type=module', '-'].join(' ');
}

export function parseArgs(argv) {
  const options = { mode: 'plan', confirm: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--spec', '--endpoint', '--ssh', '--container', '--mode', '--confirm', '--out'].includes(key)) throw new Error(`unknown option ${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} needs a value`);
    options[key.slice(2)] = value;
    index += 1;
  }
  if (!options.spec) throw new Error('--spec <site.json> required');
  if (Boolean(options.endpoint) === Boolean(options.ssh)) throw new Error('choose one transport: --endpoint or --ssh with --container');
  if (options.ssh && !SSH_TARGET.test(options.ssh)) throw new Error('--ssh: host or user@host required');
  return options;
}

async function runRemote(options, spec) {
  const command = remoteCommand({ container: options.container, mode: options.mode, confirm: options.confirm, spec });
  const engine = await readFile(ENGINE);
  const child = spawn('ssh', ['-o', 'BatchMode=yes', options.ssh, command], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const out = []; const err = [];
  child.stdout.on('data', (chunk) => out.push(chunk));
  child.stderr.on('data', (chunk) => err.push(chunk));
  child.stdin.end(engine);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
}

export async function main(argv = process.argv.slice(2)) {
  let options; let spec;
  try {
    options = parseArgs(argv);
    spec = JSON.parse(await readFile(resolvePath(options.spec), 'utf8'));
  } catch (error) { console.error(error.message); return 2; }
  const redact = (value) => redactReport(value, { spec, admin: process.env.PB_CSE_ADMIN || null });
  let text; let code;
  if (options.ssh) {
    const remote = await runRemote(options, spec).catch((error) => ({ code: 1, stdout: '', stderr: error.message }));
    code = remote.code;
    let parsed = null;
    try { parsed = JSON.parse(remote.stdout); } catch { parsed = null; }
    text = parsed ? redact(parsed) : redact({ error: 'remote run returned no JSON report', exitCode: remote.code, stderr: remote.stderr.slice(-2000) });
    if (!parsed && code === 0) code = 1;
  } else {
    try {
      const report = await runTopology({ spec, mode: options.mode, confirm: options.confirm, endpoint: options.endpoint, admin: process.env.PB_CSE_ADMIN || null });
      text = redact(report);
      code = report.verify && !report.verify.ok ? 1 : 0;
    } catch (error) {
      text = redact({ error: error.message, code: error.code ?? null });
      code = error.code === 'TOPOLOGY_SPEC' || error.code === 'TOPOLOGY_CONFIRM' ? 2 : 1;
    }
  }
  console.log(text);
  if (options.out) await writeFile(resolvePath(options.out), `${text}\n`, 'utf8');
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) process.exitCode = await main();
