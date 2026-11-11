import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const marker = 'BUBBLE_SUBSCRIPTION_SECURITY_V1';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const changes = {
  'cse/reqPrim.js': [[
    '    const access_grant = await hostingCSE.access_decision(req_prim, resp_prim);',
    `    // ${marker}: TS-0001 9.6.8 authorizes subscription creation by RETRIEVE.
    const access_req = req_prim.op === 1 && req_prim.ty === 23 ? { ...req_prim, op: 2 } : req_prim;
    const access_grant = await hostingCSE.access_decision(access_req, resp_prim);`,
  ]],
  'cse/hostingCSE.js': [
    ['async function access_decision(req_prim, resp_prim) {', `// ${marker}: deletion notifications retain the resource context and read current ACPs.
async function access_decision(req_prim, resp_prim, notification_snapshot = null) {`],
    ['\tawait retrieve_a_res(temp_req, temp_resp);\n\t// An empty pc', '\tif (notification_snapshot) { temp_resp.pc = notification_snapshot; }\n\telse { await retrieve_a_res(temp_req, temp_resp); }\n\t// An empty pc'],
    ['\tconst tmp_resp = {};\n\tawait retrieve_a_res(req_prim, tmp_resp);', '\tconst tmp_resp = {};\n\tawait retrieve_a_res(req_prim, tmp_resp);\n\tconst notification_snapshot = {};\n\tawait retrieve_a_res({ ...req_prim, int_cr_req: true }, notification_snapshot);'],
    ['noti.check_and_send_noti(req_prim, tmp_resp, "delete")', 'noti.check_and_send_noti(req_prim, tmp_resp, "delete", null, notification_snapshot.pc)'],
  ],
  'cse/noti.js': [
    ['async function check_and_send_noti(req_prim, resp_prim, event_type, before_pc = null) {', 'async function check_and_send_noti(req_prim, resp_prim, event_type, before_pc = null, deleted_snapshot = null) {'],
    ['            }), 2, ae_poa_map);', '            }), 2, ae_poa_map, deleted_snapshot);'],
    ['async function send_a_noti(sub_res, event_obj, notificationEventType, ae_poa_map = {}) {\n    if (sub_res == null) return;', `// ${marker}: re-evaluate subscription data and notification-target privileges at delivery.
async function send_a_noti(sub_res, event_obj, notificationEventType, ae_poa_map = {}, deleted_snapshot = null) {
    if (sub_res == null) return;
    const creator = sub_res.int_cr || sub_res.cr;
    if (!creator) return;
    const { access_decision } = require('./hostingCSE');
    const parent = await Lookup.findByPk(sub_res.pi);
    const snapshot_resource = deleted_snapshot && Object.values(deleted_snapshot)[0];
    const snapshot = !parent && notificationEventType === 2 && snapshot_resource?.ri === sub_res.pi ? deleted_snapshot : null;
    if (!parent && !snapshot) return;
    const readable = await access_decision({ ri: sub_res.pi, to_ty: parent?.ty || snapshot_resource?.ty, op: 2, fr: creator }, {}, snapshot);
    if (!readable) return;`],
    ['        const urls = ae_poa_map[res_id] ?? await get_urls_from_poa(res_id);', `        const target = await Lookup.findOne({ where: { [Op.or]: [{ ri: res_id }, { sid: res_id }] } });
        if (!target) continue;
        const target_request = { ri: target.ri, to_ty: target.ty, op: 5 };
        const creator_notify = await access_decision({ ...target_request, fr: creator }, {});
        const host_notify = await access_decision({ ...target_request, fr: config.cse.cse_id }, {});
        if (!creator_notify || !host_notify) continue;
        const urls = ae_poa_map[res_id] ?? await get_urls_from_poa(res_id);`],
  ],
};

export async function applyMobiusSecurity(mobiusRoot) {
  const root = resolve(mobiusRoot); const pending = []; const receipts = [];
  for (const [relative, edits] of Object.entries(changes)) {
    const path = join(root, relative); const original = await readFile(path, 'utf8');
    let value = original.replaceAll('\r\n', '\n');
    if (value.includes(marker)) { receipts.push({ file: relative, status: 'ALREADY_APPLIED', sha256: sha256(original) }); continue; }
    for (const [before, after] of edits) {
      const index = value.indexOf(before);
      if (index < 0) throw new Error(`보안 패치 문맥 확인: ${relative}`);
      value = value.slice(0, index) + after + value.slice(index + before.length);
    }
    pending.push({ path, value }); receipts.push({ file: relative, status: 'APPLIED', beforeSHA256: sha256(original), sha256: sha256(value) });
  }
  for (const entry of pending) await writeFile(entry.path, entry.value);
  return { patch: marker, files: receipts };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = process.argv.find((value) => value.startsWith('--mobius-root='))?.slice(14);
  if (!argument) throw new Error('--mobius-root=<Mobius4 경로>를 지정하세요.');
  console.log(JSON.stringify(await applyMobiusSecurity(argument), null, 2));
}
