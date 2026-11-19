// Generates the nginx map include and the Mosquitto ACL from one originator binding table.
//   node pc-mobius/scripts/build-originator-binding-configs.mjs --table=<bindings.json> --out=<dir> [--receiver=/Mobius4] [--mount-point=ext/]
// Output files stay in the given directory (use a .local path); nothing is written to the repository.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseBindingTable, renderNginxOriginatorMap } from '../src/originator-binding.mjs';
import { renderMosquittoAcl } from '../src/mqtt-originator-guard.mjs';

const option = (name) => process.argv.filter((arg) => arg.startsWith(`--${name}=`)).map((arg) => arg.slice(name.length + 3));
const [tablePath] = option('table'); const [out] = option('out');
if (!tablePath || !out) throw new Error('--table=<bindings.json> and --out=<directory> are required.');
const receivers = option('receiver').flatMap((value) => value.split(',')).filter(Boolean);
const [mountPoint = 'ext/'] = option('mount-point');
const table = parseBindingTable(await readFile(resolve(tablePath), 'utf8'));
const nginx = renderNginxOriginatorMap(table);
const acl = renderMosquittoAcl(table, { receivers: receivers.length ? receivers : [table.cseId ?? '/Mobius4'], mountPoint });
await mkdir(resolve(out), { recursive: true });
await writeFile(join(resolve(out), 'originator-map.conf'), nginx.text, { mode: 0o644 });
await writeFile(join(resolve(out), 'originator.acl'), acl.text, { mode: 0o644 });
console.log(JSON.stringify({ tableRevision: table.revision, tableSha256: table.sha256, nginxEntries: nginx.entries, nginxSkipped: nginx.skipped, mqttUsers: acl.users, mqttSkipped: acl.skipped, mountPoint, out: resolve(out) }, null, 2));
