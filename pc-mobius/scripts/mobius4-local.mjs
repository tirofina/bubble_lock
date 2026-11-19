// Local Mobius4 launcher for real-CSE runs (FL coordination plane and similar).
// Copies MOBIUS4_ROOT (read-only) into .local, creates a per-run PostgreSQL database with PostGIS,
// spawns Mobius4 on a free loopback port with NODE_CONFIG, and drops the database on stop().
import { cp, mkdir, readFile, writeFile, symlink, lstat } from 'node:fs/promises';
import { createServer as netServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

export async function freePort() {
  const probe = netServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const { port } = probe.address(); await new Promise((done) => probe.close(done)); return port;
}

export async function startLocalMobius4({ label = 'fl', workDirectory, cseId = '/fl-in-cse', subscriptionVerification = false, logLevel = 'error' } = {}) {
  const root = repositoryRoot;
  const upstream = resolve(process.env.MOBIUS4_ROOT ?? join(root, '..', 'mobius4'));
  const cseVersion = JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8')).version;
  const sourceRevision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8', windowsHide: true }).stdout?.trim() || null;
  const runId = `${Date.now()}_${randomBytes(3).toString('hex')}`;
  const base = workDirectory ?? join(root, '.local', `${label}-cse`);
  const directory = join(base, runId); const source = join(base, 'source');
  await mkdir(directory, { recursive: true });
  await cp(upstream, source, { recursive: true, filter: (path) => !['node_modules', '.git', 'logs'].includes(basename(path)) });
  try { await lstat(join(source, 'node_modules')); } catch { await symlink(join(upstream, 'node_modules'), join(source, 'node_modules'), 'junction'); }
  const prepared = spawnSync(process.execPath, [join(root, 'pc-mobius/scripts/prepare-specialization.mjs'), '--mobius-root', upstream, '--config-dir', join(source, 'config')], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (prepared.status !== 0) throw new Error(`Mobius4 specialization registry: ${prepared.stderr || prepared.stdout}`);
  const preload = join(directory, 'loopback-only.cjs');
  await writeFile(preload, "const net = require('node:net'); const original = net.Server.prototype.listen; net.Server.prototype.listen = function(...args) { if (typeof args[0] === 'number' && typeof args[1] !== 'string') args.splice(1,0,'127.0.0.1'); return original.apply(this,args); };\n");
  const connection = JSON.parse(await readFile(join(root, '.local/postgres/connection.json'), 'utf8'));
  const pool = new pg.Pool({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database: connection.database, max: 2 });
  const database = `bubble_${label}_${runId}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  await pool.query(`CREATE DATABASE "${database}"`);
  const db = new pg.Client({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database });
  await db.connect(); await db.query('CREATE EXTENSION IF NOT EXISTS postgis'); await db.end();
  const postgresVersion = (await pool.query('SELECT version()')).rows[0].version;
  const port = await freePort(); const admin = `S${randomBytes(11).toString('hex')}`;
  const secrets = [connection.password, admin];
  const sanitize = (value) => { let text = String(value); for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[secret]'); return text; };
  const config = { http: { port }, https: { enabled: false }, db: { host: connection.host, port: connection.port, user: connection.user, pw: connection.password, name: database }, cse: { admin, cse_id: cseId, csebase_rn: 'Mobius', cse_type: 1, subscription_verification: subscriptionVerification, poa: [`http://127.0.0.1:${port}`] }, mqtt: { enabled: false }, logging: { level: logLevel, file: { enabled: false } }, security: { rateLimit: { enabled: false } } };
  let diagnostic = '';
  const child = spawn(process.execPath, ['--require', preload, 'mobius4.js'], { cwd: source, env: { ...process.env, NODE_ENV: 'production', NODE_CONFIG: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  child.stdout.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-64000); });
  child.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-64000); });
  let stopped = false;
  const stop = async ({ dropDatabase = true } = {}) => {
    if (stopped) return; stopped = true;
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))]); }
    if (dropDatabase) { try { await pool.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); } catch (error) { process.stderr.write(`database drop: ${sanitize(error.message)}\n`); } }
    await pool.end();
  };
  try {
    await new Promise((ready, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Mobius4 start timeout: ${sanitize(diagnostic)}`)), 30000);
      child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Mobius4 exited ${code}: ${sanitize(diagnostic)}`)); });
      child.on('message', (message) => { if (message === 'ready') { clearTimeout(timeout); ready(); } });
    });
  } catch (error) { await stop(); throw error; }
  return { endpoint: `http://127.0.0.1:${port}`, cseBase: '/Mobius', cseId, admin, port, pid: child.pid, cseVersion, sourceRevision, postgresVersion, database, directory, sanitize, diagnostic: () => sanitize(diagnostic), stop, child };
}
