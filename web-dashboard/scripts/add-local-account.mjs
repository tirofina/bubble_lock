#!/usr/bin/env node
// Adds or updates a self-hosted dashboard account.
// Usage: node scripts/add-local-account.mjs <username> <guardian|operator> [--password <pw>] [--file <path>]
// Without --password the password is read from stdin. The file defaults to LOCAL_ACCOUNTS_FILE or <repo>/.local/portal-accounts.json.
import { randomBytes, scrypt } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${name} 값을 지정하세요.`);
  args.splice(index, 2);
  return value;
};
const fail = (message) => { console.error(message); process.exit(1); };

let password = option('--password');
const file = resolve(option('--file') ?? process.env.LOCAL_ACCOUNTS_FILE ?? fileURLToPath(new URL('../../.local/portal-accounts.json', import.meta.url)));
const [username, role] = args;
if (!username || !/^[A-Za-z0-9._-]{1,64}$/.test(username)) fail('사용법: add-local-account.mjs <username> <guardian|operator> [--password <pw>] [--file <path>]');
if (role !== 'guardian' && role !== 'operator') fail('역할은 guardian 또는 operator로 지정하세요.');
if (password === undefined) {
  if (process.stdin.isTTY) process.stderr.write('비밀번호를 입력하고 Enter, 이어서 Ctrl+Z(Windows) 또는 Ctrl+D를 누르세요: ');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}
if (password.length < 8 || password.length > 1024) fail('비밀번호는 8자 이상으로 지정하세요.');

const N = 16384, r = 8, p = 1;
const salt = randomBytes(16);
const hash = await new Promise((done, reject) => scrypt(password, salt, 64, { N, r, p, maxmem: 256 * N * r }, (error, key) => error ? reject(error) : done(key)));
const passwordHash = `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;

let accounts = [];
try {
  accounts = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(accounts)) fail(`${file} 형식을 확인하세요: 계정 배열이어야 합니다.`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const existing = accounts.findIndex((account) => account?.username === username);
const entry = { username, role, passwordHash };
if (existing === -1) accounts.push(entry); else accounts[existing] = entry;
await mkdir(dirname(file), { recursive: true });
const temporary = `${file}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(accounts, null, 2)}\n`, { mode: 0o600 });
await rename(temporary, file);
console.log(`${existing === -1 ? '추가' : '갱신'}: ${username} (${role}) -> ${file}`);
