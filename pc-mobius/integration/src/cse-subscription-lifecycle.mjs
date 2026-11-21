// 수정하지 않은 CSE에서 oneM2M 표준 절차로 구독 수명주기를 관리한다.
//
// TS-0004 7.4.8.2.1 Recv-6.3에 따라 <subscription> 생성자는 부모의 CREATE와
// 구독 대상의 RETRIEVE를 함께 가진다. RETRIEVE 전용 주체에는 생성 순간에만
// CREATE를 더하고 원래 정책을 복원한다.
//
// TS-0004 7.5.1.2.2의 알림 절차에는 전송 시점 권한 재검사가 없다. 회수는 해당
// 주체의 <subscription>을 먼저 삭제하고 ACP를 두 번째로 바꾼다.

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

// createAsSubscriber는 subscriberId를 Originator로 사용해 CREATE를 보내고 { rsc, ... }를 반환한다.
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

// 4004는 이미 삭제된 구독으로 정산한다. 다른 응답은 ACP 변경 전에 중단한다.
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
