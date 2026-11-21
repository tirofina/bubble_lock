// Subscription lifecycle on an unmodified CSE, using standard procedures only.
//
// TS-0004 7.4.8.2.1 Recv-6.3: creating a <subscription> needs CREATE on the parent and RETRIEVE on
// the subscribed-to resource. A read-only subscriber (the MEC IPE on the desired container) gets
// CREATE only for the moment of creation, then the policy is put back.
//
// TS-0004 7.5.1.2.2: the notification procedure has no privilege re-check at delivery, so removing
// an ACP rule does not stop an existing <subscription>. Revocation deletes the subscriber's
// <subscription> resources first and changes the ACP second, so no notification leaves in between.

const CREATE = 1;
const RETRIEVE = 2;
const DELETED = 2002;
const NOT_FOUND = 4004;

function withPrivileges(pv, subscriberId, bits) {
  const rules = structuredClone(pv.acr ?? []);
  const rule = rules.find((entry) => entry.acor?.length === 1 && entry.acor[0] === subscriberId);
  if (rule) rule.acop |= bits;
  else rules.push({ acor: [subscriberId], acop: bits });
  return { acr: rules };
}

function grants(pv, subscriberId, bit) {
  return (pv?.acr ?? []).some((rule) => rule.acor?.includes(subscriberId) && (rule.acop & bit));
}

async function putPolicy(admin, acpPath, pv) {
  const result = await admin.request('PUT', acpPath, { 'm2m:acp': { pv } });
  if (result.rsc !== 2004) throw new Error(`ACP 갱신 응답 ${result.rsc}`);
  const readback = Object.values(await admin.read(acpPath))[0];
  return readback.pv;
}

// admin: a client allowed to update the ACP (request/read like OneM2mEdgeClient).
// createAsSubscriber: sends the <subscription> CREATE with the subscriber as Originator and
// returns { rsc, ... }. The subscriber must be the Originator so the CSE records it as creator.
export async function subscribeWithTransientCreate({ admin, acpPath, policy, subscriberId, createAsSubscriber }) {
  const widened = await putPolicy(admin, acpPath, withPrivileges(policy, subscriberId, CREATE | RETRIEVE));
  if (!grants(widened, subscriberId, CREATE) || !grants(widened, subscriberId, RETRIEVE)) throw new Error('구독 생성 권한 부여 readback을 확인하세요.');
  let created;
  try {
    created = await createAsSubscriber();
  } finally {
    const restored = await putPolicy(admin, acpPath, policy);
    if (grants(restored, subscriberId, CREATE) && !grants(policy, subscriberId, CREATE)) throw new Error('구독 생성 뒤 CREATE 회수 readback을 확인하세요.');
  }
  return created;
}

// Deletes each <subscription> path, then applies the revoked policy. A subscription that is
// already gone (4004) counts as removed; any other answer stops before the ACP changes.
export async function revokeSubscriber({ admin, subscriptionPaths, acpPath, revokedPolicy }) {
  const removed = [];
  for (const path of subscriptionPaths) {
    const result = await admin.request('DELETE', path);
    if (result.rsc !== DELETED && result.rsc !== NOT_FOUND) throw new Error(`구독 삭제 응답 ${result.rsc}: ${path}`);
    removed.push({ path, rsc: result.rsc });
  }
  const pv = await putPolicy(admin, acpPath, revokedPolicy);
  return { subscriptions: removed, pv };
}
