#!/usr/bin/env bash
# Provision the oneM2M side of the MEC IPE on the team's server CSE (Mobius4, cseId /bubble-cse):
#   /Mobius/<household AE>/<device>                 container, acpi <device>-mec-access
#   /Mobius/<household AE>/<device>/location        container, acpi <device>-mec-access (MEC013 cins)
#   /Mobius/<household AE>/<device>/rnis            container, acpi <device>-mec-access (MEC012 cins)
#   /Mobius/<household AE>/<device>-mec-access      ACP (new child of the household AE)
# The household AE, its acpi and its existing containers stay as they are. The IPE registers its own AE
# (pb-mec-ipe) and creates its request containers and ACPs itself through its mTLS route.
#
# Runs on the VM as the VM user. The requests go from inside the cse container (docker exec, node fetch to
# the CSE's own HTTP port), with the admin originator taken from that container's environment; the value
# never leaves the container and the output masks it:
#   ssh mec@<VM_IP> 'bash -s' < deploy/mec-sandbox/ipe/provision-server-cse.sh
#   ssh mec@<VM_IP> 'DEVICE=keyring-1 bash -s' < deploy/mec-sandbox/ipe/provision-server-cse.sh
# Re-running updates the ACP privileges and the acpi of the three containers (4105 then 2004).
set -euo pipefail
CONTAINER="${CSE_CONTAINER:-bubblelock-nocert-cse-1}"
HOUSEHOLD="${HOUSEHOLD_AE:-bubble-household-1}"
DEVICE="${DEVICE:-resident-relay}"
# IPE: CREATE+RETRIEVE+UPDATE (7) for the cins and the container loc. Dashboard readers created by the
# server owner: guardian RETRIEVE+DISCOVER+NOTIFY (50), operator RETRIEVE+DISCOVER (34).
IPE="${IPE_ORIGINATOR:-Cpb-mec-ipe}"; IPE_ACOP="${IPE_ACOP:-7}"
GUARDIANS="${GUARDIAN_READERS:-Cpb-dash-guardian}"; GUARDIAN_ACOP="${GUARDIAN_ACOP:-50}"
OPERATORS="${OPERATOR_READERS:-Cpb-dash-operator}"; OPERATOR_ACOP="${OPERATOR_ACOP:-34}"
ACP_RN="${ACP_RN:-$DEVICE-mec-access}"

docker exec -i \
  -e PB_HOUSEHOLD="$HOUSEHOLD" -e PB_DEVICE="$DEVICE" -e PB_ACP_RN="$ACP_RN" \
  -e PB_IPE="$IPE" -e PB_IPE_ACOP="$IPE_ACOP" -e PB_GUARDIANS="$GUARDIANS" -e PB_GUARDIAN_ACOP="$GUARDIAN_ACOP" \
  -e PB_OPERATORS="$OPERATORS" -e PB_OPERATOR_ACOP="$OPERATOR_ACOP" \
  "$CONTAINER" node --input-type=module - <<'JS'
const env = process.env;
const admin = env.CSE_ADMIN;
if (!admin) { console.error('CSE_ADMIN is not set in the cse container'); process.exit(2); }
const base = `http://127.0.0.1:${env.HTTP_PORT || 7599}`;
const cb = env.CSE_BASE_RN || 'Mobius';
const RN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
for (const value of [env.PB_HOUSEHOLD, env.PB_DEVICE, env.PB_ACP_RN]) if (!RN.test(value ?? '')) { console.error(`invalid resource name: ${value}`); process.exit(2); }
const list = (value) => String(value ?? '').split(/[;,\s]+/).filter(Boolean);
const mask = (value) => JSON.stringify(value, null, 1).replaceAll(admin, '[admin]');
let seq = 0;
async function m2m(origin, method, path, { ty, body } = {}) {
  const response = await fetch(`${base}/${path}`, { method, headers: { 'X-M2M-Origin': origin, 'X-M2M-RI': `pb-provision-${process.pid}-${++seq}`, 'X-M2M-RVI': '4', accept: 'application/json', ...(body ? { 'content-type': `application/json${ty ? `;ty=${ty}` : ''}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  const text = await response.text(); let payload = null; try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return { rsc: Number(response.headers.get('x-m2m-rsc')), payload };
}
async function ensure(parent, ty, tag, body, update) {
  const created = await m2m(admin, 'POST', parent, { ty, body: { [tag]: body } });
  if (created.rsc === 2001) return { path: `${parent}/${body.rn}`, ri: created.payload?.[tag]?.ri, rsc: '2001' };
  if (created.rsc === 4105) {
    const updated = await m2m(admin, 'PUT', `${parent}/${body.rn}`, { body: { [tag]: update } });
    return { path: `${parent}/${body.rn}`, ri: updated.payload?.[tag]?.ri, rsc: `4105/${updated.rsc}` };
  }
  throw new Error(`${parent}/${body.rn}: ${created.rsc} ${mask(created.payload).slice(0, 300)}`);
}
const household = `${cb}/${env.PB_HOUSEHOLD}`;
const before = await m2m(admin, 'GET', household);
if (before.rsc !== 2000) { console.error(`household AE ${household} not readable: ${before.rsc}`); process.exit(1); }
const acr = [{ acor: [admin], acop: 63 }, { acor: [env.PB_IPE], acop: Number(env.PB_IPE_ACOP) }];
if (list(env.PB_GUARDIANS).length) acr.push({ acor: list(env.PB_GUARDIANS), acop: Number(env.PB_GUARDIAN_ACOP) });
if (list(env.PB_OPERATORS).length) acr.push({ acor: list(env.PB_OPERATORS), acop: Number(env.PB_OPERATOR_ACOP) });
const acp = await ensure(household, 1, 'm2m:acp', { rn: env.PB_ACP_RN, pv: { acr }, pvs: { acr: [{ acor: [admin], acop: 63 }] }, lbl: ['pb:mec-device-access'] }, { pv: { acr } });
const device = `${household}/${env.PB_DEVICE}`;
const containers = [];
for (const [parent, rn, mni, label] of [[household, env.PB_DEVICE, 10, `pb:mec-device:${env.PB_DEVICE}`], [device, 'location', 1000, 'pb:location'], [device, 'rnis', 1000, 'pb:rnis']]) {
  const result = await ensure(parent, 3, 'm2m:cnt', { rn, acpi: [acp.ri], mni, lbl: [label] }, { acpi: [acp.ri] });
  containers.push({ path: result.path, rsc: result.rsc, acpi: (await m2m(admin, 'GET', result.path)).payload?.['m2m:cnt']?.acpi ?? null });
}
// ACP self-check (GET only): the IPE and the readers read the location container, an unlisted originator does not.
const location = `${device}/location`;
const first = (value) => list(value)[0];
const selfCheck = { ipeRetrieveLocation: (await m2m(env.PB_IPE, 'GET', location)).rsc, guardianRetrieveLocation: (await m2m(first(env.PB_GUARDIANS), 'GET', location)).rsc, operatorRetrieveLocation: (await m2m(first(env.PB_OPERATORS), 'GET', location)).rsc, unlistedRetrieveLocation: (await m2m('Cpb-unlisted-probe', 'GET', location)).rsc };
const after = await m2m(admin, 'GET', household);
selfCheck.householdAcpiUnchanged = JSON.stringify(before.payload?.['m2m:ae']?.acpi) === JSON.stringify(after.payload?.['m2m:ae']?.acpi);
console.log(mask({ cse: `${env.CSE_ID} (docker exec, ${base})`, household, acp: { ...acp, privileges: acr.map(({ acor, acop }) => ({ acor, acop })) }, containers, selfCheck }));
JS
