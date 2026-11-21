import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const exec = promisify(execFile);
const project = process.env.COMPOSE_PROJECT_NAME ?? 'bubblelock-deploy';
const destination = resolve(process.env.BACKUP_DIR ?? `.local/backups/${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(destination, { recursive: true, mode: 0o700 });
const records = [];
for (const [service, user, database] of [['postgres', 'bubble', 'bubble'], ['cse-db', 'mobius', 'mobius']]) {
  const id = (await exec('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`, '--filter', `label=com.docker.compose.service=${service}`])).stdout.trim();
  if (!id) throw new Error(`Missing ${service}`);
  const dump = (await exec('docker', ['exec', id, 'pg_dump', '-U', user, '-Fc', database], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })).stdout;
  const file = resolve(destination, `${service}.dump`);
  await writeFile(file, dump, { mode: 0o600 });
  // A separate database proves restore without overwriting the active namespace.
  const restored = `restore_${Date.now()}`;
  await exec('docker', ['exec', id, 'createdb', '-U', user, restored]);
  try {
    const child = spawn('docker', ['exec', '-i', id, 'pg_restore', '-U', user, '--exit-on-error', '-d', restored], { stdio: ['pipe', 'ignore', 'pipe'], env: process.env });
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.stdin.end(dump);
    await new Promise((resolveExit, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolveExit() : reject(new Error(`Restore failed: ${errors}`)));
    });
    const output = (await exec('docker', ['exec', id, 'psql', '-U', user, '-d', restored, '-Atc', "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')"])).stdout.trim();
    const count = Number(output);
    if (!Number.isInteger(count) || count < 1) throw new Error(`Restored ${service} contains no application tables`);
    records.push({ service, bytes: dump.length, restoredTables: count, restore: 'PASS' });
  } finally {
    await exec('docker', ['exec', id, 'dropdb', '-U', user, restored]);
  }
}
console.log(JSON.stringify({ status: 'BACKUP_RESTORE_PASS', destination, records }, null, 2));
