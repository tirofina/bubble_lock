import { cp, readFile, writeFile, mkdir, symlink, lstat } from 'node:fs/promises';
import { createServer as netServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

export async function freePort() {
  const probe = netServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const { port } = probe.address(); await new Promise((done) => probe.close(done)); return port;
}

/**
 * Start one real Mobius4 child on a free loopback port with its own PostgreSQL database.
 * Mobius4 source stays read-only: it is copied into .local and the registry is merged there.
 */
export async function startMobius({ label = 'multiapp', cseId = '/multiapp-cse', subscriptionVerification = true, logLevel = 'error' } = {}) {
  const upstream = resolve(process.env.MOBIUS4_ROOT ?? join(repositoryRoot, '..', 'mobius4'));
  const runId = `${Date.now()}_${randomBytes(3).toString('hex')}`;
  const directory = join(repositoryRoot, '.local', `${label}-cse`, runId);
  const source = join(repositoryRoot, '.local', `${label}-cse`, 'source');
  await mkdir(directory, { recursive: true });
  await cp(upstream, source, { recursive: true, filter: (path) => !['node_modules', '.git', 'logs'].includes(basename(path)) });
  try { await lstat(join(source, 'node_modules')); } catch { await symlink(join(upstream, 'node_modules'), join(source, 'node_modules'), 'junction'); }
  const prepared = spawnSync(process.execPath, [join(repositoryRoot, 'pc-mobius/scripts/prepare-specialization.mjs'), '--mobius-root', upstream, '--config-dir', join(source, 'config')], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true });
  if (prepared.status !== 0) throw new Error(`specialization registry: ${prepared.stderr}`);
  const preload = join(directory, 'loopback-only.cjs');
  await writeFile(preload, "const net = require('node:net'); const original = net.Server.prototype.listen; net.Server.prototype.listen = function(...args) { if (typeof args[0] === 'number' && typeof args[1] !== 'string') args.splice(1,0,'127.0.0.1'); return original.apply(this,args); };\n");
  const connection = JSON.parse(await readFile(join(repositoryRoot, '.local/postgres/connection.json'), 'utf8'));
  const pool = new pg.Pool({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database: connection.database });
  const database = `bubble_${label}_${runId}`.toLowerCase();
  await pool.query(`CREATE DATABASE "${database}"`);
  const db = new pg.Client({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database });
  await db.connect(); await db.query('CREATE EXTENSION IF NOT EXISTS postgis'); await db.end();
  const port = await freePort();
  const admin = `S${randomBytes(11).toString('hex')}`;
  const secrets = [connection.password, admin];
  const sanitize = (text) => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[secret]'); return value; };
  const config = {
    http: { port }, https: { enabled: false },
    db: { host: connection.host, port: connection.port, user: connection.user, pw: connection.password, name: database },
    cse: { admin, cse_id: cseId, csebase_rn: 'Mobius', cse_type: 1, subscription_verification: subscriptionVerification, poa: [`http://127.0.0.1:${port}`] },
    mqtt: { enabled: false }, logging: { level: logLevel, file: { enabled: false } }, security: { rateLimit: { enabled: false } },
  };
  let diagnostic = '';
  const child = spawn(process.execPath, ['--require', preload, 'mobius4.js'], { cwd: source, env: { ...process.env, NODE_ENV: 'production', NODE_CONFIG: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  child.stdout.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-64000); });
  child.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-64000); });
  await new Promise((ready, reject) => {
    const timeout = setTimeout(() => reject(new Error(`CSE start timeout: ${sanitize(diagnostic)}`)), 30000);
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`CSE exited ${code}: ${sanitize(diagnostic)}`)); });
    child.on('message', (message) => { if (message === 'ready') { clearTimeout(timeout); ready(); } });
  });
  const pkg = JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8'));
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8', windowsHide: true }).stdout.trim() || null;
  const registrySHA256 = createHash('sha256').update(await readFile(join(source, 'config/specializations.json'))).digest('hex');
  const postgres = (await pool.query('SELECT version()')).rows[0].version;
  const stop = async ({ dropDatabase = true } = {}) => {
    if (child.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), new Promise((done) => setTimeout(done, 5000))]); }
    if (dropDatabase) { try { await pool.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); } catch { /* reported by caller */ } }
    await pool.end();
  };
  return { endpoint: `http://127.0.0.1:${port}`, cseBase: '/Mobius', cseId, admin, database, directory, child, version: pkg.version, revision, registrySHA256, postgres, sanitize, diagnostic: () => sanitize(diagnostic), stop };
}
