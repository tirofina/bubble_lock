import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** POSIX local ledger. The directory is provisioned separately as owner-only. */
export function createFileSettlementCommit(path) {
  const directory = resolve(path);
  return async function commitIfAbsent(key, candidate) {
    const info = await lstat(directory);
    if (typeof process.getuid !== 'function' || !info.isDirectory() || info.uid !== process.getuid()
        || (info.mode & 0o077) !== 0) throw new Error('PRIVATE_SETTLEMENT_DIRECTORY_REQUIRED');
    const name = createHash('sha256').update(JSON.stringify(key)).digest('hex');
    const target = join(directory, `${name}.json`);
    const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let temporaryCreated = false;
    try {
      const file = await open(temporary, 'wx', 0o600);
      temporaryCreated = true;
      try {
        await file.writeFile(JSON.stringify(candidate) + '\n', 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      let created = false;
      try {
        await link(temporary, target);
        created = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      // A retry may observe the winning link before the first writer syncs it.
      const settled = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      let record;
      try {
        const stats = await settled.stat();
        if (!stats.isFile() || stats.uid !== process.getuid() || (stats.mode & 0o077) !== 0 || stats.size > 8192) {
          throw new Error('INVALID_SETTLEMENT_FILE');
        }
        record = JSON.parse(await settled.readFile('utf8'));
      } finally {
        await settled.close();
      }
      await directoryHandle.sync();
      return { created, record };
    } finally {
      try {
        if (temporaryCreated) await unlink(temporary);
      } finally {
        await directoryHandle.close();
      }
    }
  };
}
