/**
 * BubbleLock topology audit and additive reconciliation for Mobius4 (DOC-REV 2.0.0).
 *
 * Target tree: one AE directly under CSEBase. Gateways, the resident relay and shared services sit
 * below it as container, flexContainer, group and subscription resources (no nested AE):
 *
 *   /<cb>/BubbleLock                              AE   lbl pb-app-bubblelock, pb-household-<h>
 *     acp-bubblelock                              ACP  only when readers are configured
 *     <gateway>                                   cnt  lbl pb-gateway-<g>, pb-household-<h>
 *       observations | receipts | health          cnt  Gateway daemon feeds (gateway-container layout)
 *       <deviceId>                                cnt  lbl pb-keyring, pb-sdt-binarySwitch, pb-device-<d>, pb-gateway-<g>, pb-household-<h>
 *         observation | button | battery | command | receipt   cnt  CONTAINER_POLICY of topology.mjs
 *         switch                                  fcnt cod:binSh, cnd binarySwitch
 *     <resident relay>                            cnt  lbl pb-resident-relay, pb-household-<h>
 *       location | rnis                           cnt
 *     services                                    cnt  lbl pb-services
 *       incidents                                 cnt  lbl pb-incidents, pb-household-<h>
 *     grp-switches                                grp  mt 28, mid = every device switch (fopt fan-out)
 *     <subscriptions from the site spec>          sub
 *
 * Rules: CREATE what is missing; UPDATE only to append missing labels or group members; never DELETE,
 * move, rename or rewrite another attribute. Legacy roots (the household AE tree) are read only.
 * Modes: audit (read only), plan (default: read only plus the action list), apply (explicit, needs
 * confirm equal to the AE resource name).
 *
 * The module imports only node: builtins, so the same file runs inside the CSE container with the
 * admin originator from that container's environment (CSE_ADMIN never leaves it and is masked):
 *   docker exec -i -e PB_TOPOLOGY_MAIN=1 -e PB_TOPOLOGY_SPEC_B64=<base64 spec> <container> node --input-type=module - < bubblelock-topology.mjs
 * pc-mobius/scripts/bubblelock-topology.mjs wraps that call (ssh mode) and the direct HTTP mode.
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BINARY_SWITCH_CND = 'org.onem2m.common.moduleclass.binarySwitch';
export const KEYRING_STREAMS = Object.freeze(['observation', 'button', 'battery', 'command', 'receipt']);
export const STREAM_POLICY = Object.freeze({ observation: { mni: 100, mbs: 262144 }, button: { mni: 20 }, battery: { mni: 20 }, command: { mni: 20, mia: 900 }, receipt: { mni: 50 } });
export const GATEWAY_FEEDS = Object.freeze(['observations', 'receipts', 'health']);
export const RELAY_FEEDS = Object.freeze(['location', 'rnis']);
export const FEED_MNI = 1000;
export const LABELS = Object.freeze({
  app: 'pb-app-bubblelock', keyring: 'pb-keyring', sdt: 'pb-sdt-binarySwitch', incidents: 'pb-incidents', relay: 'pb-resident-relay', services: 'pb-services',
  stream: (stream) => `pb-stream-${stream}`, feed: (feed) => `pb-feed-${feed}`,
  device: (deviceId) => `pb-device-${deviceId}`, gateway: (gatewayId) => `pb-gateway-${gatewayId}`, household: (householdId) => `pb-household-${householdId}`,
});
export const TAGS = Object.freeze({ 1: 'm2m:acp', 2: 'm2m:ae', 3: 'm2m:cnt', 9: 'm2m:grp', 23: 'm2m:sub', 28: 'cod:binSh' });
export const MODES = Object.freeze(['audit', 'plan', 'apply']);
export const ACP_REF = '$acp';
const DRIFT_KEYS = Object.freeze({ 2: ['api'], 3: ['mni', 'mbs', 'mia'], 9: ['mt', 'csy'], 23: ['nu', 'nct'], 28: ['cnd'] });
const RN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ORIGINATOR = /^[CS][A-Za-z0-9._-]{1,127}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

const fail = (message) => { throw Object.assign(new Error(message), { code: 'TOPOLOGY_SPEC' }); };
const checkRn = (value, what) => { if (!RN.test(String(value ?? ''))) fail(`${what}: resource name required ([A-Za-z0-9._-], max 64)`); return value; };
const checkLabels = (values, what) => { for (const value of values) if (!LABEL.test(String(value))) fail(`${what}: invalid label`); return values; };
const checkRelative = (value, what) => {
  const segments = String(value ?? '').split('/');
  if (!segments.length || segments.some((segment) => !RN.test(segment))) fail(`${what}: path relative to the CSEBase required`);
  return segments.join('/');
};
const unique = (values) => [...new Set(values)];

/** Spec defaults and validation. Throws on anything that would put an unsafe name into a request path. */
export function normalizeSite(input = {}) {
  const ae = { rn: 'BubbleLock', api: 'Npb.bubblelock', originator: 'Cpb-bubblelock', ...(input.ae ?? {}) };
  checkRn(ae.rn, 'ae.rn');
  if (!/^[NR][A-Za-z0-9._-]{1,127}$/.test(String(ae.api))) fail('ae.api: App-ID starting with N or R required');
  if (!ORIGINATOR.test(String(ae.originator))) fail('ae.originator: AE-ID starting with C or S required');
  const householdId = checkRn(input.householdId, 'householdId');
  const gateways = (input.gateways ?? []).map((gateway, index) => {
    const rn = checkRn(gateway.rn, `gateways[${index}].rn`);
    const feeds = (gateway.feeds ?? GATEWAY_FEEDS).map((feed) => checkRn(feed, `gateways[${index}].feeds`));
    const devices = unique(gateway.devices ?? []).map((device) => checkRn(device, `gateways[${index}].devices`));
    return { rn, gatewayId: checkRn(gateway.gatewayId ?? rn, `gateways[${index}].gatewayId`), feeds, devices };
  });
  const residentRelays = (input.residentRelays ?? [{ rn: 'resident-relay' }]).map((relay, index) => ({
    rn: checkRn(relay.rn, `residentRelays[${index}].rn`), feeds: (relay.feeds ?? RELAY_FEEDS).map((feed) => checkRn(feed, `residentRelays[${index}].feeds`)),
  }));
  const readers = (input.readers ?? []).map((reader, index) => {
    if (!ORIGINATOR.test(String(reader.originator))) fail(`readers[${index}].originator: AE-ID required`);
    const acop = Number(reader.acop);
    if (!Number.isInteger(acop) || acop < 1 || acop > 63) fail(`readers[${index}].acop: 1..63 required`);
    return { originator: reader.originator, acop };
  });
  const subscriptions = (input.subscriptions ?? []).map((sub, index) => {
    const nu = Array.isArray(sub.nu) ? sub.nu.map(String) : [];
    if (!nu.length) fail(`subscriptions[${index}].nu: notification target required`);
    return { parent: checkRelative(sub.parent, `subscriptions[${index}].parent`), rn: checkRn(sub.rn, `subscriptions[${index}].rn`), nu, net: sub.net ?? [3], nct: sub.nct ?? 1 };
  });
  const legacyRoots = (input.legacyRoots ?? []).map((root, index) => checkRelative(root, `legacyRoots[${index}]`));
  const labelAdditions = (input.labelAdditions ?? []).map((entry, index) => {
    const ty = Number(entry.ty ?? 3);
    if (![2, 3, 9, 28].includes(ty)) fail(`labelAdditions[${index}].ty: 2, 3, 9 or 28 required`);
    return { path: checkRelative(entry.path, `labelAdditions[${index}].path`), ty, add: checkLabels(unique(entry.add ?? []), `labelAdditions[${index}].add`) };
  });
  const cseBase = checkRn(input.cseBase ?? 'Mobius', 'cseBase');
  for (const entry of labelAdditions) if (entry.path === ae.rn || entry.path.startsWith(`${ae.rn}/`)) fail('labelAdditions: target outside the BubbleLock AE required');
  return { cseBase, ae, householdId, gateways, residentRelays, services: input.services !== false, readers, subscriptions, legacyRoots, labelAdditions };
}

/**
 * Desired resources in creation order (parents first). Paths are CSE-relative without a leading slash,
 * the same form Mobius4 uses for group member IDs.
 */
export function desiredTopology(siteInput) {
  const site = normalizeSite(siteInput);
  const nodes = [];
  const household = LABELS.household(site.householdId);
  const aePath = `${site.cseBase}/${site.ae.rn}`;
  const acpi = site.readers.length ? { acpi: [ACP_REF] } : {};
  const add = (parent, rn, ty, attrs, extra = {}) => { const path = `${parent}/${rn}`; nodes.push({ path, parent, rn, ty, attrs, create: true, ...extra }); return path; };

  add(site.cseBase, site.ae.rn, 2, { api: site.ae.api, rr: false, srv: ['4'], lbl: [LABELS.app, household] });
  if (site.readers.length) {
    const acr = [{ acor: [site.ae.originator], acop: 63 }, ...site.readers.map(({ originator, acop }) => ({ acor: [originator], acop }))];
    add(aePath, 'acp-bubblelock', 1, { pv: { acr }, pvs: { acr: [{ acor: [site.ae.originator], acop: 63 }] }, lbl: [LABELS.app] }, { acp: true });
  }
  const switches = [];
  for (const gateway of site.gateways) {
    const gatewayLabels = [LABELS.gateway(gateway.gatewayId), household];
    const gatewayPath = add(aePath, gateway.rn, 3, { lbl: gatewayLabels, ...acpi });
    for (const feed of gateway.feeds) add(gatewayPath, feed, 3, { mni: FEED_MNI, lbl: [LABELS.feed(feed), ...gatewayLabels], ...acpi });
    for (const deviceId of gateway.devices) {
      const common = [LABELS.device(deviceId), ...gatewayLabels];
      const root = add(gatewayPath, deviceId, 3, { lbl: [LABELS.keyring, LABELS.sdt, ...common], ...acpi });
      for (const stream of KEYRING_STREAMS) add(root, stream, 3, { ...STREAM_POLICY[stream], lbl: [LABELS.stream(stream), ...common], ...acpi });
      switches.push(add(root, 'switch', 28, { cnd: BINARY_SWITCH_CND, state: false, lbl: [LABELS.stream('switch'), ...common], ...acpi }));
    }
  }
  for (const relay of site.residentRelays) {
    const relayLabels = [LABELS.relay, household];
    const relayPath = add(aePath, relay.rn, 3, { lbl: relayLabels, ...acpi });
    for (const feed of relay.feeds) add(relayPath, feed, 3, { mni: FEED_MNI, lbl: [LABELS.feed(feed), ...relayLabels], ...acpi });
  }
  if (site.services) {
    const services = add(aePath, 'services', 3, { lbl: [LABELS.services, household], ...acpi });
    add(services, 'incidents', 3, { mni: 50, mia: 86400, lbl: [LABELS.incidents, household], ...acpi });
  }
  if (switches.length) add(aePath, 'grp-switches', 9, { mt: 28, mnm: Math.max(16, switches.length), mid: switches, csy: 1, lbl: [LABELS.app, household], ...acpi });
  for (const sub of site.subscriptions) add(`${aePath}/${sub.parent}`, sub.rn, 23, { nu: sub.nu, enc: { net: sub.net }, nct: sub.nct, lbl: [LABELS.app] });
  for (const entry of site.labelAdditions) {
    const path = `${site.cseBase}/${entry.path}`;
    nodes.push({ path, parent: path.split('/').slice(0, -1).join('/'), rn: path.split('/').at(-1), ty: entry.ty, attrs: { lbl: entry.add }, create: false, legacy: true });
  }
  return nodes;
}

/** Minimal oneM2M HTTP binding (TS-0009) with a per-request originator. Paths are CSE-relative. */
export function createClient({ endpoint, rvi = '4', fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
  if (!endpoint) throw new Error('CSE endpoint required');
  const base = String(endpoint).replace(/\/$/, '');
  let sequence = 0;
  return async function request(origin, method, path, { ty, body, query } = {}) {
    if (typeof path !== 'string' || path.startsWith('/') || path.split('/').some((segment) => !segment || segment === '..')) throw new Error(`oneM2M path: ${path}`);
    const url = new URL(`${base}/${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.append(key, String(value));
    const response = await fetchImpl(url.href, {
      method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json', 'X-M2M-Origin': origin, 'X-M2M-RI': `pb-topology-${process.pid}-${++sequence}`, 'X-M2M-RVI': rvi, ...(body ? { 'Content-Type': `application/json${ty ? `;ty=${ty}` : ''}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 300) }; }
    return { rsc: Number(response.headers.get('x-m2m-rsc')), payload };
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stripSlash = (value) => String(value).replace(/^\//, '');
const acrKey = (rule) => JSON.stringify([[...(rule?.acor ?? [])].map(String).sort(), Number(rule?.acop)]);

/**
 * Read-only comparison of the desired nodes with the CSE. A child of a missing node is missing without a
 * request; a child of a conflicting or unreadable node is blocked and never planned.
 */
export async function auditTopology(request, nodes, { reader }) {
  const status = new Map();
  const entries = [];
  for (const node of nodes) {
    const parentStatus = status.get(node.parent);
    let entry;
    if (parentStatus === 'missing') entry = { status: 'missing', inferred: true };
    else if (['conflict', 'unreadable', 'blocked', 'absent'].includes(parentStatus)) entry = { status: 'blocked', reason: `parent ${parentStatus}` };
    else {
      const read = await request(reader, 'GET', node.path);
      const resource = read.payload?.[TAGS[node.ty]];
      if (read.rsc === 4004) entry = { status: node.create ? 'missing' : 'absent' };
      else if (read.rsc !== 2000) entry = { status: 'unreadable', rsc: read.rsc };
      else if (!resource) entry = { status: 'conflict', reason: `expected ${TAGS[node.ty]}, found ${Object.keys(read.payload ?? {})[0] ?? 'nothing'}` };
      else {
        const lbl = Array.isArray(resource.lbl) ? resource.lbl : [];
        const missing = {};
        const lblMissing = (node.attrs.lbl ?? []).filter((label) => !lbl.includes(label));
        if (lblMissing.length) missing.lbl = lblMissing;
        const existingMid = (Array.isArray(resource.mid) ? resource.mid : []).map(stripSlash);
        if (node.ty === 9) {
          const midMissing = node.attrs.mid.filter((member) => !existingMid.includes(stripSlash(member)));
          if (midMissing.length) missing.mid = midMissing;
        }
        const existingAcr = Array.isArray(resource.pv?.acr) ? resource.pv.acr : [];
        if (node.ty === 1) {
          const acrMissing = node.attrs.pv.acr.filter((rule) => !existingAcr.some((item) => acrKey(item) === acrKey(rule)));
          if (acrMissing.length) missing.acr = acrMissing;
        }
        const drift = node.create ? (DRIFT_KEYS[node.ty] ?? []).filter((key) => key in node.attrs && !same(node.attrs[key], resource[key])).map((key) => ({ key, desired: node.attrs[key], actual: resource[key] ?? null })) : [];
        entry = { status: 'present', ri: resource.ri ?? null, existing: { lbl, ...(node.ty === 9 ? { mid: existingMid, mnm: resource.mnm ?? null } : {}), ...(node.ty === 1 ? { acr: existingAcr } : {}) },...(Object.keys(missing).length ? { missing } : {}), ...(drift.length ? { drift } : {}) };
      }
    }
    status.set(node.path, entry.status);
    entries.push({ path: node.path, ty: node.ty, ...entry });
  }
  return entries;
}

/** Additive action list: CREATE for missing nodes, label/member append UPDATE for present nodes. */
export function planActions(nodes, audit) {
  const actions = [];
  const skipped = [];
  nodes.forEach((node, index) => {
    const entry = audit[index];
    const tag = TAGS[node.ty];
    if (entry.status === 'missing') actions.push({ op: 'create', path: node.path, parent: node.parent, ty: node.ty, ...(node.acp ? { acp: true } : {}), body: { [tag]: { rn: node.rn, ...node.attrs } } });
    else if (entry.status === 'present' && entry.missing) {
      const update = {};
      if (entry.missing.lbl) update.lbl = [...entry.existing.lbl, ...entry.missing.lbl];
      if (entry.missing.mid) {
        update.mid = [...entry.existing.mid, ...entry.missing.mid.map(stripSlash)];
        if (entry.existing.mnm !== null && update.mid.length > entry.existing.mnm) update.mnm = update.mid.length;
      }
      if (entry.missing.acr) update.pv = { acr: [...entry.existing.acr, ...entry.missing.acr] };
      actions.push({ op: 'update', path: node.path, ty: node.ty, ...(node.legacy ? { legacy: true } : {}), body: { [tag]: update } });
    } else if (['conflict', 'unreadable', 'blocked', 'absent'].includes(entry.status)) skipped.push({ path: node.path, status: entry.status, ...(entry.reason ? { reason: entry.reason } : {}), ...(entry.rsc ? { rsc: entry.rsc } : {}) });
  });
  return { actions, skipped };
}

/** Read-only view of legacy roots (household AE trees): resource type and container children. */
export async function auditLegacy(request, site, { reader }) {
  const result = [];
  for (const root of site.legacyRoots) {
    const path = `${site.cseBase}/${root}`;
    const read = await request(reader, 'GET', path);
    const type = read.rsc === 2000 ? Object.keys(read.payload ?? {})[0] ?? null : null;
    const discovery = read.rsc === 2000 ? await request(reader, 'GET', path, { query: { fu: 1, ty: 3, lim: 500 } }) : null;
    const containers = (discovery?.payload?.['m2m:uril'] ?? []).map(stripSlash).filter((uri) => uri !== path).sort();
    result.push({ root: path, rsc: read.rsc, type, containers, action: 'preserve' });
  }
  return result;
}

/** Executes a plan in order. CREATE accepts 2001, and 4105 as an idempotent race; UPDATE accepts 2004. */
export async function applyPlan(request, plan, audit, { writer, admin }) {
  const results = [];
  const failed = [];
  let acpRi = audit.find((entry) => entry.ty === 1 && entry.status === 'present')?.ri ?? null;
  for (const action of plan.actions) {
    const blockedBy = failed.find((path) => action.path.startsWith(`${path}/`));
    if (blockedBy) { results.push({ op: action.op, path: action.path, outcome: 'skipped', reason: `parent failed: ${blockedBy}` }); continue; }
    const tag = TAGS[action.ty];
    const body = structuredClone(action.body);
    if (Array.isArray(body[tag].acpi) && body[tag].acpi.includes(ACP_REF)) {
      if (!acpRi) { failed.push(action.path); results.push({ op: action.op, path: action.path, outcome: 'failed', reason: 'acp unresolved' }); continue; }
      body[tag].acpi = body[tag].acpi.map((value) => (value === ACP_REF ? acpRi : value));
    }
    if (action.op === 'create') {
      const response = await request(writer, 'POST', action.parent, { ty: action.ty, body });
      const ok = response.rsc === 2001 || response.rsc === 4105;
      if (ok && action.acp) acpRi = response.payload?.[tag]?.ri ?? (await request(admin ?? writer, 'GET', action.path)).payload?.[tag]?.ri ?? null;
      if (!ok) failed.push(action.path);
      results.push({ op: 'create', path: action.path, rsc: response.rsc, outcome: ok ? (response.rsc === 2001 ? 'created' : 'exists') : 'failed', ...(ok ? {} : { reason: debugOf(response.payload) }) });
    } else {
      const response = await request(action.legacy ? (admin ?? writer) : writer, 'PUT', action.path, { body });
      const ok = response.rsc === 2004;
      results.push({ op: 'update', path: action.path, rsc: response.rsc, outcome: ok ? 'updated' : 'failed', fields: Object.keys(body[tag]), ...(ok ? {} : { reason: debugOf(response.payload) }) });
    }
  }
  return results;
}

function debugOf(payload) {
  const text = typeof payload?.['m2m:dbg'] === 'string' ? payload['m2m:dbg'] : JSON.stringify(payload ?? null);
  return String(text).slice(0, 200);
}

function summarize(audit, plan) {
  const counts = {};
  for (const entry of audit) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  return { nodes: audit.length, ...counts, creates: plan.actions.filter((action) => action.op === 'create').length, updates: plan.actions.filter((action) => action.op === 'update').length, drift: audit.filter((entry) => entry.drift).length };
}

/**
 * audit: read only. plan: read only plus actions. apply: plan, execute, then re-audit; the verify block
 * must show zero remaining actions for an idempotent result.
 */
export async function runTopology({ spec, mode = 'plan', confirm = null, endpoint, rvi, admin = null, fetchImpl, timeoutMs }) {
  if (!MODES.includes(mode)) throw Object.assign(new Error(`mode: one of ${MODES.join(', ')}`), { code: 'TOPOLOGY_SPEC' });
  const site = normalizeSite(spec);
  if (mode === 'apply' && confirm !== site.ae.rn) throw Object.assign(new Error(`apply requires confirm=${site.ae.rn}`), { code: 'TOPOLOGY_CONFIRM' });
  const request = createClient({ endpoint, rvi, fetchImpl, timeoutMs });
  const reader = admin ?? site.ae.originator;
  const nodes = desiredTopology(site);
  const audit = await auditTopology(request, nodes, { reader });
  const legacy = await auditLegacy(request, site, { reader });
  const plan = planActions(nodes, audit);
  const report = { tool: 'bubblelock-topology', docRev: '2.0.0', mode, target: { ae: `${site.cseBase}/${site.ae.rn}`, nodes: nodes.length }, summary: summarize(audit, plan), legacy, skipped: plan.skipped };
  if (mode === 'audit') return { ...report, audit };
  if (mode === 'plan') return { ...report, actions: plan.actions };
  const applied = await applyPlan(request, plan, audit, { writer: site.ae.originator, admin });
  const reaudit = await auditTopology(request, nodes, { reader });
  const replan = planActions(nodes, reaudit);
  const legacyAfter = await auditLegacy(request, site, { reader });
  const legacyPreserved = legacy.every((before, index) => before.rsc !== 2000 || before.containers.every((path) => legacyAfter[index].containers.includes(path)));
  return {
    ...report, applied,
    verify: { summary: summarize(reaudit, replan), remainingActions: replan.actions.length, legacyPreserved, ok: applied.every((item) => item.outcome !== 'failed') && replan.actions.length === 0 && legacyPreserved },
  };
}

/** JSON text with configured device IDs and the admin originator replaced by placeholders. */
export function redactReport(report, { spec, admin }) {
  let text = JSON.stringify(report, null, 1);
  if (admin) text = text.replaceAll(admin, '[admin]');
  const devices = (spec?.gateways ?? []).flatMap((gateway) => gateway.devices ?? []);
  devices.sort((a, b) => b.length - a.length).forEach((deviceId) => { text = text.replaceAll(deviceId, `[device-${devices.indexOf(deviceId) + 1}]`); });
  return text;
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** Entry for the container (PB_TOPOLOGY_* environment) and for a direct local run (--spec, --mode, ...). */
export async function main(argv = process.argv.slice(2), env = process.env) {
  let spec;
  try {
    if (env.PB_TOPOLOGY_SPEC_B64) spec = JSON.parse(Buffer.from(env.PB_TOPOLOGY_SPEC_B64, 'base64').toString('utf8'));
    else spec = JSON.parse(readFileSync(argValue(argv, '--spec') ?? env.PB_TOPOLOGY_SPEC_FILE, 'utf8'));
  } catch (error) { console.error(`topology spec: ${error.message}`); return 2; }
  if (env.CSE_BASE_RN && !spec.cseBase) spec.cseBase = env.CSE_BASE_RN;
  const admin = env.CSE_ADMIN || null;
  try {
    const report = await runTopology({
      spec, mode: argValue(argv, '--mode') ?? env.PB_TOPOLOGY_MODE ?? 'plan', confirm: argValue(argv, '--confirm') ?? env.PB_TOPOLOGY_CONFIRM ?? null,
      endpoint: argValue(argv, '--endpoint') ?? env.PB_CSE_URL ?? `http://127.0.0.1:${env.HTTP_PORT || 7599}`, rvi: env.PB_RVI || '4', admin,
    });
    console.log(redactReport(report, { spec, admin }));
    return report.verify && !report.verify.ok ? 1 : 0;
  } catch (error) {
    console.error(redactReport({ error: error.message, code: error.code ?? null }, { spec, admin }));
    return error.code === 'TOPOLOGY_SPEC' || error.code === 'TOPOLOGY_CONFIRM' ? 2 : 1;
  }
}

const invokedDirectly = (() => {
  try { return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]); } catch { return false; }
})();
if (process.env.PB_TOPOLOGY_MAIN === '1' || invokedDirectly) process.exitCode = await main();
