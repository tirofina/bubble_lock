import { cp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { applyMobiusSecurity } from './apply-mobius-security.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const upstream = resolve(process.env.MOBIUS4_ROOT ?? join(root, '..', 'mobius4'));
const runId = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const directory = join(root, '.local/acp-cse', runId); const source = join(directory, 'source');
await mkdir(directory, { recursive: true });
await cp(upstream, source, { recursive: true, filter: (path) => !['node_modules', '.git', 'logs'].includes(basename(path)) });
await symlink(join(upstream, 'node_modules'), join(source, 'node_modules'), 'junction');
const patch = await applyMobiusSecurity(source);
await applyMobiusSecurity(source); // The deployment step is repeatable.
const prepared = spawnSync(process.execPath, [join(root, 'pc-mobius/scripts/prepare-specialization.mjs'), '--mobius-root', upstream, '--config-dir', join(source, 'config')], { cwd: root, encoding: 'utf8', windowsHide: true });
if (prepared.status !== 0) throw new Error('CSE canonical registry 생성을 확인하세요.');
const preload = join(directory, 'loopback-only.cjs');
await writeFile(preload, "const net=require('node:net');const original=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){if(typeof args[0]==='number'&&typeof args[1]!=='string')args.splice(1,0,'127.0.0.1');return original.apply(this,args);};\n");
const connection = JSON.parse(await readFile(join(root, '.local/postgres/connection.json'), 'utf8'));
const credentials = { host: connection.host, port: connection.port, user: connection.user, password: connection.password };
const pool = new pg.Pool({ ...credentials, database: connection.database });
const children = []; const secrets = [connection.password]; const edges = [];
function sanitized(value) { let text = String(value); for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[secret]'); return text; }
async function freePort() { const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise((done) => probe.close(done)); return port; }
async function execute(script, args = []) {
  const child = spawn(process.execPath, [join(root, 'pc-mobius/scripts', script), ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  const [status] = await once(child, 'exit'); console.log(sanitized(output)); if (status !== 0) throw new Error(`${script} 검증 상태 ${status}`);
}
try {
  for (const label of ['a', 'b']) {
    const database = `bubble_acp_${runId}_${label}`; await pool.query(`CREATE DATABASE "${database}"`);
    const db = new pg.Client({ ...credentials, database }); await db.connect(); await db.query('CREATE EXTENSION IF NOT EXISTS postgis'); await db.end();
    const port = await freePort(); const admin = `S${randomBytes(11).toString('hex')}`; secrets.push(admin); const edgeId = `acp-${label}`;
    const config = { http: { port }, https: { enabled: false }, db: { host: connection.host, port: connection.port, user: connection.user, pw: connection.password, name: database }, cse: { admin, cse_id: `/${edgeId}`, csebase_rn: 'Mobius', cse_type: 1, subscription_verification: true, poa: [`http://127.0.0.1:${port}`] }, mqtt: { enabled: false }, logging: { level: 'error', file: { enabled: false } }, security: { rateLimit: { enabled: false } } };
    let diagnostic = ''; const child = spawn(process.execPath, ['--require', preload, 'mobius4.js'], { cwd: source, env: { ...process.env, NODE_ENV: 'production', NODE_CONFIG: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }); children.push(child);
    child.stdout.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-64000); }); child.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-64000); });
    await new Promise((ready, reject) => { const timer = setTimeout(() => reject(new Error(`CSE 시작 대기: ${sanitized(diagnostic)}`)), 30000); child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`CSE 시작 ${code}: ${sanitized(diagnostic)}`)); }); child.on('message', (message) => { if (message === 'ready') { clearTimeout(timer); ready(); } }); });
    edges.push({ edgeId, endpoint: `http://127.0.0.1:${port}`, cseId: `/${edgeId}`, cseBase: '/Mobius', originator: admin, simulation: false, timeoutMs: 5000 });
  }
  const configPath = join(directory, 'cse-edges.json'); await writeFile(configPath, JSON.stringify(edges), { mode: 0o600 });
  await execute('run-acp-real.mjs', [`--config=${configPath}`]);
  await execute('run-location-privacy-real.mjs', [`--config=${configPath}`]);
  const receiptPath = join(root, 'pc-mobius/receipts/acp-real-cse.json');
  const evidence = JSON.parse(await readFile(receiptPath, 'utf8'));
  evidence.securityPatch = patch; evidence.sourceRevision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8', windowsHide: true }).stdout.trim();
  evidence.cseVersion = JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8')).version;
  evidence.runtimeEvidenceDirectory = directory;
  await writeFile(receiptPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'PASS', caseCount: evidence.caseCount, patch: patch.patch, cseVersion: evidence.cseVersion }));
} catch (error) { console.error(sanitized(error.stack)); process.exitCode = 1; }
finally { for (const child of children) if (child.exitCode === null) child.kill(); await pool.end(); }
