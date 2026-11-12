import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const marker = 'BUBBLE_SUBSCRIPTION_SECURITY_V2';
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
    ["const { NCT, effective_nct, notification_carries_subscribed_to } = require('./notification-event-types');", `const { NCT, effective_nct, notification_carries_subscribed_to } = require('./notification-event-types');

// ${marker}: a notification may leave the CSE only for an explicitly approved origin.
const notification_ports = { 'http:': '80', 'https:': '443', 'mqtt:': '1883', 'mqtts:': '8883' };
function notification_origin(value) {
    try {
        const url = new URL(value);
        const port = url.port || notification_ports[url.protocol];
        return port && !url.username && !url.password
            ? url.protocol + '//' + url.hostname + ':' + port : null;
    } catch { return null; }
}
const configured_notification_origins = config.has('cse.notification_allowed_origins')
    ? config.get('cse.notification_allowed_origins') : [];
if (!Array.isArray(configured_notification_origins) || configured_notification_origins.some((value) => {
    if (typeof value !== 'string' || !notification_origin(value)) return true;
    const url = new URL(value);
    return !['', '/'].includes(url.pathname) || Boolean(url.search || url.hash);
})) throw new Error('cse.notification_allowed_origins must contain only URL origins');
const allowed_notification_origins = new Set(configured_notification_origins.map(notification_origin));
function notification_target_allowed(target) {
    const origin = notification_origin(target);
    return origin !== null && allowed_notification_origins.has(origin);
}`],
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
    ['async function http_noti(noti_target, sgn) {', `async function http_noti(noti_target, sgn) {
    if (!notification_target_allowed(noti_target)) {
        logger.warn({ target: noti_target, sur: sgn['m2m:sgn']?.sur }, 'notification target origin denied');
        return false;
    }`],
    ['            timeout: config.cse.notification_timeout_seconds * 1000,', '            timeout: config.cse.notification_timeout_seconds * 1000,\n            maxRedirects: 0,'],
    ['async function mqtt_noti(noti_target, sgn, to_override) {', `async function mqtt_noti(noti_target, sgn, to_override) {
    if (!notification_target_allowed(noti_target)) {
        logger.warn({ target: noti_target, sur: sgn['m2m:sgn']?.sur }, 'notification target origin denied');
        return false;
    }`],
    ["  const url = poa.replace(/\\/+$/, '') + to_path_component(target);", "  const url = poa.replace(/\\/+$/, '') + to_path_component(target);\n  if (!notification_target_allowed(url)) throw new Error('notification target origin denied');"],
    ['    timeout: timeout_ms,', '    timeout: timeout_ms,\n    maxRedirects: 0,'],
    ['    send_verification,\n};', '    send_verification,\n    notification_target_allowed,\n};'],
  ],
  'cse/resources/sub.js': [
    ['const enums = require("../../config/enums");', `const enums = require("../../config/enums");

// ${marker}: refuse URL destinations before persisting a subscription.
function refused_notification_target(resource) {
  const { is_resource_id_target } = require('../subscription-verification');
  const { notification_target_allowed } = require('../noti');
  return [...(resource.nu || []), resource.su].find((target) =>
    typeof target === 'string' && !is_resource_id_target(target) && !notification_target_allowed(target));
}`],
    ['  // TS-0004:7.4.8.2.1 Recv-6.4. Before the insert, not after: a subscription that failed', `  const refused_target = refused_notification_target(prim_res);
  if (refused_target) {
    resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
    resp_prim.pc = { 'm2m:dbg': 'notification target origin denied' };
    return;
  }

  // TS-0004:7.4.8.2.1 Recv-6.4. Before the insert, not after: a subscription that failed`],
    ['    if (prim_res.nu != null && prim_res.nu != undefined) db_res.nu = prim_res.nu;', `    const refused_target = refused_notification_target(prim_res);
    if (refused_target) {
      resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
      resp_prim.pc = { 'm2m:dbg': 'notification target origin denied' };
      return;
    }
    if (prim_res.nu != null && prim_res.nu != undefined) db_res.nu = prim_res.nu;`],
  ],
  'docker/node-config.js': [
    ["            poa: env('CSE_POA') ? [env('CSE_POA')] : undefined,", `            poa: env('CSE_POA') ? [env('CSE_POA')] : undefined,
            // ${marker}: only configured origins may receive outbound notifications.
            notification_allowed_origins: env('NOTIFICATION_ALLOWED_ORIGINS')?.split(',').map((value) => value.trim()).filter(Boolean),`],
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
