#!/usr/bin/env node
// docs/rubric-audit.json 의 모든 항목을 개별 행으로 옮겨 final-acceptance.json/.md 를 만든다.
// 사용: node docs/final-acceptance-build.mjs   (repo 루트에서)
// 입력: docs/rubric-audit.json, .local/verification/verify/results.json 과 단계 로그, docs/final-evidence/<scope>/
// 원본 대비 개수·고유 ID·누락, PASS 근거 규칙이 하나라도 어긋나면 종료 코드 1.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const audit = JSON.parse(readFileSync(join(root, 'docs/rubric-audit.json'), 'utf8'));
const currentVerifyDir = '.local/verification/verify';
const verifyDir = 'docs/final-evidence/final';
const currentVerify = JSON.parse(readFileSync(join(root, currentVerifyDir, 'results.json'), 'utf8'));
mkdirSync(join(root, verifyDir), { recursive: true });
for (const file of ['results.json', ...currentVerify.results.map((stage) => stage.log)]) {
  copyFileSync(join(root, currentVerifyDir, file), join(root, verifyDir, file));
}
const verifyPath = `${verifyDir}/results.json`;
const verify = JSON.parse(readFileSync(join(root, verifyPath), 'utf8'));
const HW = '테스트 대기';
const PASS = 'PASS(소프트웨어)';

// 기능 계열 -> 이번 verify 단계. 계열 회귀 근거일 뿐 항목 PASS 근거가 아니다.
const FAMILY_STAGES = {
  CORE: ['core-tests', 'sdt-xsd-closure', 'core-contract', 'canonical-sdt-contract', 'onem2m-dry-run'],
  GROUP: ['core-tests', 'integration-demo'],
  TRANSPORT: ['gateway-tests', 'cross-runtime-mtls'],
  POLICY: ['core-tests', 'cross-runtime-mtls'],
  STORE: ['core-tests'],
  MEC: ['integration-contract', 'integration-demo'],
  HANDOVER: ['integration-replay'],
  FL: ['integration-demo'],
  MCP: ['core-tests'],
  APP: ['web-tests', 'web-contract-types'],
  WEB: ['web-tests', 'web-contract-types', 'web-build'],
  HARDWARE: ['gateway-tests'],
  EVIDENCE: ['integration-demo', 'integration-replay'],
  PUBLIC: [],
};
const LANE_FAMILIES = {
  cse: ['CORE', 'POLICY'], group: ['GROUP'], deployment: ['POLICY', 'HANDOVER'],
  external: ['MEC', 'FL', 'HANDOVER'], map: ['WEB'],
};
// Root가 실제 receipt·diff·화면을 검토한 범위다. 항목 전체의 PASS 판정과 분리한다.
const REVIEWED_ACTUAL = {
  cse: '실제 Mobius4 4.25.0 두 CSE ACP 828/828·위치 5/5 PASS; acp-real-cse.json, location-privacy-real-cse.json. 센서 입력은 모의. 실물·MQTT 우회 검증은 별도.',
  group: '실제 CSE /fopt 2004/4103→실패 멤버만 2004, 별도 모의 장치 ACK/readback 2명 SETTLED, 재시작 2회 PASS; actual-cse-group.json, http-trace.json. 실물·PostgreSQL 다중 프로세스는 별도.',
  map: '키 없는 실제 지도 UI 선택·BLE 원·확대·타일 실패/복구 PASS, 데스크톱·모바일 화면 확인, 외부 공급자 진행 0건; browser-verification.json. 실제 공급자 인증은 별도.',
  external: '로컬 설정 실행기·M01–M09·handover·FL 56시험 및5단계 PASS; summary.json. 모의30회 전환/1000관측, 합성3seed×10round와33모델 readback. 실제 외부 계정·독립 호스트 수용은 대기.',
  deployment: '로컬 Compose 실검사 PASS(포트19080/19443/19883만, 전용volume, non-root); 세 역할 실제 브라우저 로그인·갱신·로그아웃 PASS. PostgreSQL 승인→CSE 두 멤버 DISPATCHED(물리ACK 아님), MQTT 실제RSC2000/위조4103. DB98/58table 격리복원 PASS; docs/final-evidence/deployment 원문 참조. 노트북 배포·공인인증서 발급은 미실행.',
};

// 하드웨어: 장치 이름(키링, BLE, firmware)만으로는 판단하지 않는다. 실물 행동·측정 표지가 있어야 한다.
const HW_RE = /(실물|실장비|물리\s*(횟수|count)|physicalCount|보드\s*(계측|revision|조립)|board revision|assembly|계측|현장|영상|녹화|촬영|배터리|충전|전원\s*(측정|시험)|소비\s*전류|PCB\s*(조립|실장|제작)|납땜|플래시|flash|실제\s*(장치|기기|조명|키링|보드|ACK)|장치\s*ACK|두\s*조명|조명\s*2|RSSI\s*(측정|반경 실측)|현장\s*RSSI|MAX9850|PCM\s*재생|Raspberry\s*Pi\s*(실행|설치|배치)|Bluetooth\s*실기)/i;
// 소유자·외부: 실계정·실 endpoint·배포·공개 활동 표지. 계열 이름(MEC/FL)만으로는 판단하지 않는다.
const OWNER_RE = /(ESTIMED|계정|account|\bVM\b|\blive\b|LIVE|배포|deployment|공개\s*(Article|영상|활동|게시|발표)|외부\s*공개|Article|forum|interview|두\s*(호스트|host)|edge host|실제\s*(MEC|endpoint|CSE|host|호스트)|endpoint URL|callback ingress|OIDC|공급자\s*키|provider key|도메인|runtime image digest|hostId|permission ticket)/i;

const stageByLabel = Object.fromEntries(verify.results.map((r) => [r.label, r]));
const stageOk = (label) => verify.status === 'PASS' && stageByLabel[label]?.exitCode === 0;
const stageRef = (label) => {
  const s = stageByLabel[label];
  return `${verifyDir}/${s.log} (종료코드 ${s.exitCode}, sha256 ${s.sha256.slice(0, 12)})`;
};
const coreLog = readFileSync(join(root, verifyDir, stageByLabel['core-tests'].log), 'utf8').split('\n');
const passLine = (prefix) => coreLog.find((l) => l.includes('✔') && l.includes(prefix))?.trim().replace(/\s*\([\d.]+ms\)$/, '');

const lanes = [];
const evDir = join(root, 'docs/final-evidence');
if (existsSync(evDir)) {
  for (const name of readdirSync(evDir).sort()) {
    if (!statSync(join(evDir, name)).isDirectory()) continue;
    lanes.push({ scope: name, path: `docs/final-evidence/${name}`, families: LANE_FAMILIES[name] ?? [], actual: REVIEWED_ACTUAL[name] ?? 'root 검토 대기' });
  }
}

const text = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

// exact: { kind:'PASS'|'PARTIAL'|'NONE', actual, evidence[] } 항목 단위 직접 근거. 없으면 계열 근거만 쓴다.
function row({ section, id, title, expected, families, historical, source, context = '', original, exact }) {
  families = families ?? [];
  const blob = `${title} ${expected} ${context}`;
  const needsHw = HW_RE.test(blob);
  const needsOwner = OWNER_RE.test(blob);
  const stages = [...new Set(families.flatMap((f) => FAMILY_STAGES[f] ?? []))].filter((s) => stageByLabel[s]);
  const laneRefs = lanes.filter((l) => l.families.some((f) => families.includes(f))).map((l) => l.path);
  let software;
  if (exact?.kind === 'PASS') software = { status: '항목 직접 근거 PASS', actual: exact.actual, evidence: exact.evidence };
  else if (exact?.kind === 'PARTIAL') software = { status: '항목 일부만 직접 근거', actual: exact.actual, evidence: exact.evidence };
  else if (exact?.kind === 'NONE') software = { status: '이번 실행에 근거 없음', actual: exact.actual, evidence: exact.evidence ?? [] };
  else if (stages.length) software = {
    status: stages.every(stageOk) ? '계열 회귀 통과·항목 미판정' : '계열 회귀 실패 있음',
    actual: `이번 verify(${verify.generatedAt})의 관련 계열 단계 ${stages.length}개 결과. 계열 회귀 근거일 뿐 이 항목 expected를 직접 실행한 결과는 아님.`,
    evidence: stages.map(stageRef),
  };
  else software = { status: '소프트웨어 근거 없음', actual: '이번 실행에서 이 항목에 대응하는 소프트웨어 시험 없음.', evidence: [] };
  software.familyStages = stages;
  const hardware = needsHw ? HW : '해당 없음';
  const ownerInput = needsOwner ? '소유자 정보·외부 실증 대기' : '해당 없음';
  let verdict;
  if (needsHw) verdict = HW;
  else if (needsOwner) verdict = '외부 실증 대기';
  else if (exact?.kind === 'PASS') verdict = PASS;
  else if (exact?.kind === 'PARTIAL') verdict = '소프트웨어 일부 확인·나머지 대기';
  else verdict = stages.length && exact?.kind !== 'NONE' ? '소프트웨어 부분 확인·항목 판정 대기' : '증거 없음·판정 대기';
  return {
    section, id, title, expected, families, source, historicalStatus: historical, original,
    software, hardware, ownerInput,
    laneEvidence: { status: laneRefs.length ? '아래 actual의 검토 범위만 확인' : '해당 lane 없음', paths: laneRefs,
      actual: lanes.filter((l) => l.families.some((f) => families.includes(f))).map((l) => `${l.path}: ${l.actual}`) },
    verdict,
  };
}

// 필수 명령: evidenceLabel 을 이번 verify 단계와 직접 대응시킨다.
function commandExact(c) {
  if (c.evidenceLabel === 'ALL') {
    const ok = verify.status === 'PASS' && verify.results.every((r) => r.exitCode === 0);
    return { kind: ok ? 'PASS' : 'NONE', actual: `npm run verify 전체 ${verify.status}, ${verify.results.filter((r) => r.exitCode === 0).length}/${verify.results.length} 단계 종료코드 0 (${verify.generatedAt}).`, evidence: [verifyPath] };
  }
  if (!c.evidenceLabel || !stageByLabel[c.evidenceLabel]) {
    return { kind: 'NONE', actual: `이번 verify에 이 명령 단계가 없음. 감사 당시 기록: ${c.status}.`, evidence: [] };
  }
  const s = stageByLabel[c.evidenceLabel];
  return { kind: stageOk(c.evidenceLabel) ? 'PASS' : 'NONE', actual: `verify 단계 ${s.label} 종료코드 ${s.exitCode}, ${s.durationMs}ms. 감사 당시 로그 이름 ${c.log ?? '없음'}는 현재 ${s.log}로 바뀜.`, evidence: [stageRef(c.evidenceLabel)] };
}

// 장애 fixture: core-tests 로그의 이름 붙은 통과 시험과 expected 를 사람이 대조한 결과.
// PASS 는 시험 이름이 expected 시나리오 전체를 다룰 때만. 일부만 다루면 PARTIAL.
const FIXTURE_MATCH = {
  D01: ['PARTIAL', 'D01/D02', '시험 이름은 예약 만료만 다룬다. revoke commit에 따른 GRANT_REVISION 취소는 이름에 없음.'],
  D02: ['PASS', 'D01/D02', '예약 명령이 admission 전에 만료되어 취소되는 시나리오와 일치.'],
  D05: ['PARTIAL', 'D05/D07', 'claim 재시도와 deadline 보존은 확인. process restart 후 같은 claimId 재개는 이름에 없음.'],
  D07: ['PASS', 'A11/D07', 'ACK 소실 뒤 cutover가 같은 claim readback 정산까지 막히는 시나리오와 일치.'],
  D09: ['PASS', 'D09', 'desiredGeneration fence와 지연 receipt 처리, 최신 readback 일치. 물리 횟수 기록은 실물 항목.'],
  M01: ['PASS', 'M01:', 'service·UE·provider identity 바인딩 검사와 일치.'],
  M02: ['PASS', 'M02:', 'old generation·만료·회수 route의 최소 receipt와 일치.'],
  M03: ['PASS', 'M03:', '동시 전달과 payload 병합이 row/outbox 1건으로 끝나는 시나리오와 일치.'],
  M04: ['PASS', 'M04:', '역순·stale·future·unknown 시각에서 watermark 보존과 일치.'],
  M05: ['PASS', 'M05:', 'revocation commit이 대기 callback보다 우선하는 시나리오와 일치.'],
  M06: ['PASS', 'M06:', 'restart 뒤에도 현재 grant가 복호화를 막는 시나리오와 일치.'],
  M07: ['PASS', 'M07:', 'POST timeout·late callback·reconcile 뒤 구독 1개와 일치.'],
  M08: ['PASS', 'M08:', 'cancel timeout·restart·late callback·새 generation 독립과 일치.'],
  M09: ['PASS', 'M09:', '상대 링크 정규화와 외부 링크·과대 payload review와 일치.'],
  F01: ['PASS', 'F01 ', 'participant·originator·task·dataset 범위 바인딩과 일치.'],
  F02: ['PASS', 'F02 ', 'count·finite/shape·base version·중복 update 검증과 일치.'],
  F03: ['PASS', 'F03/F04', '선정 뒤 consent 회수 시 update 차단과 일치.'],
  F04: ['PASS', 'F03/F04', '집계 전 회수 시 acceptedSet 재계산·재선정과 일치.'],
  F05: ['PASS', 'F05/F11', 'commit 뒤 회수 시 publication 대체·읽기 중지·재학습 승인과 일치.'],
  F06: ['PASS', 'F06 ', 'artifact·commit·publication 경계 restart 뒤 commit 1건과 일치.'],
  F07: ['PASS', 'F07 ', 'coordinator epoch CAS와 동시 finalize 단일 commit과 일치.'],
  F08: ['PARTIAL', 'F08 ', 'partial artifact 무결성·heartbeat·GC는 확인. late join/이탈 재선정과 48h 기준은 이름에 없음.'],
  F09: ['PASS', 'F09 ', '고정 seed 재현 학습과 sample 가중 FedAvg와 일치.'],
  F10: ['PASS', 'F10 ', 'consent 변경 뒤 CAS로 새 acceptedSet·manifest 요구와 일치.'],
  F11: ['PASS', 'F05/F11', '지연 publication이 대체되고 승인된 새 모델만 승격되는 시나리오와 일치.'],
};
function fixtureExact(id) {
  const m = FIXTURE_MATCH[id];
  if (!m) return { kind: 'NONE', actual: 'core-tests 로그에 이 ID 이름의 시험이 없음.', evidence: [] };
  const [kind, prefix, note] = m;
  const line = passLine(prefix);
  if (!line || !stageOk('core-tests')) return { kind: 'NONE', actual: `기대한 통과 시험 "${prefix}" 를 이번 로그에서 찾지 못함.`, evidence: [] };
  return { kind, actual: `${line}. 대조: ${note}`, evidence: [stageRef('core-tests')], testLine: line };
}

const S = [];
const add = (key, label, list, fn) => S.push({ key, label, sourceCount: list.length, rows: list.map(fn) });

add('rubrics', '루브릭 R', audit.rubrics, (r) => row({
  section: 'rubrics', id: r.id, title: r.title, families: r.audit?.evidenceFamilies, source: r.source, original: r,
  expected: `설계: ${r.design} / Expert(4~5): ${r.levels?.Expert_4_5 ?? ''} / 필요 증거: ${r.evidence_required} / 담당 ${r.owner}, W ${text(r.work_packages)}, A ${text(r.acceptance_tests)}`,
  historical: `${r.evidence_status} / ${r.audit?.status} / 실제 점수 ${r.actual_score ?? 'null'}`,
}));
add('acceptanceTests', '수용 시험 A', audit.acceptanceTests, (t) => row({
  section: 'acceptanceTests', id: t.id, title: t.title, families: t.audit?.evidenceFamilies, source: t.source, original: t,
  expected: `절차: ${t.procedure} / 수락: ${t.accept_when} / 증거: ${t.evidence}`,
  context: text(t.audit?.externalEvidenceNext), historical: `${t.status} / ${t.audit?.status}`,
}));
add('workPackages', '작업 패키지 W', audit.workPackages, (w) => row({
  section: 'workPackages', id: w.id, title: w.title, families: w.audit?.evidenceFamilies, source: w.source, original: w,
  expected: `${w.done_when} / 기간 ${w.start}~${w.end}, 담당 ${w.owner}, 선행 ${text(w.dependencies)}`,
  historical: `${w.status} / ${w.audit?.status}`,
}));
add('gates', 'Gate', audit.gates, (g) => row({
  section: 'gates', id: g.id, title: `gate ${g.id}`, families: g.audit?.evidenceFamilies, source: g.source, original: g,
  expected: `receipt: ${text(g.requirement?.receipts)} / 수행 ${text(g.requirement?.performer)}, 승인 ${g.requirement?.approver ?? ''}`,
  historical: g.audit?.status, exact: { kind: 'NONE', actual: '실제 검토 receipt가 이번 실행에 없음.' },
}));
add('liveStages', 'LIVE 단계', audit.liveStages, (l) => {
  const wp = audit.workPackages.find((w) => `${w.id}-LIVE` === l.requirement.stage);
  return row({
    section: 'liveStages', id: l.requirement.stage, title: `${wp?.title ?? ''} 실환경 실행`,
    families: l.audit?.evidenceFamilies ?? wp?.audit?.evidenceFamilies, source: l.source, original: l,
    expected: `LIVE runtime receipt(${text(l.requirement.runtime_receipt_fields)}) 와 task completion receipt / ${wp?.done_when ?? ''}`,
    historical: `${l.requirement.execution_status} / ${text(l.audit?.status)}`,
    exact: { kind: 'NONE', actual: 'LIVE runtime receipt가 이번 실행에 없음.' },
  });
});
add('completionCriteria', '완료 기준 C', audit.completionCriteria, (c) => row({
  section: 'completionCriteria', id: c.id, title: c.requirement, families: c.evidenceFamilies, source: c.source, original: c,
  expected: `${c.requirement} / 감사 소견: ${c.finding}`, historical: c.status,
}));
add('requiredCommands', '필수 명령', audit.requiredCommands, (c) => row({
  section: 'requiredCommands', id: `${c.cwd}: ${c.command}`, title: c.scope, families: [], source: c.source, original: c,
  expected: `${c.command} 종료코드 0`, historical: `${c.status} (감사 당시 기록)`, exact: commandExact(c),
}));
const faults = audit.faultFixtures.flatMap((g) => g.fixtures.map((f) => ({ ...f, group: g.group })));
const FAULT_FAM = { dispatch_protocol: ['POLICY'], callback_ingestion: ['MEC'], fl_update_trust: ['FL'] };
add('faultFixtures', '장애 fixture D/M/F', faults, (f) => row({
  section: 'faultFixtures', id: f.id, title: f.group, families: FAULT_FAM[f.group] ?? [], source: f.source, original: f,
  expected: text(f.requirement), historical: '감사 당시 개별 실행 기록 없음', exact: fixtureExact(f.id),
}));
add('planRequirementInventory', '계획 요구사항 P', audit.planRequirementInventory, (p) => row({
  section: 'planRequirementInventory', id: p.id, title: p.section, families: p.evidenceFamilies, source: p.source, original: p,
  expected: p.requirement, historical: p.status,
}));
add('contractClauseAudit', '계약 조항', audit.contractClauseAudit, (c) => row({
  section: 'contractClauseAudit', id: c.id, title: c.id, families: c.evidenceFamilies, source: c.source, original: c,
  expected: text(c.requirement), historical: c.status,
}));

// 검증
const errors = [];
for (const s of S) {
  const ids = s.rows.map((r) => r.id);
  if (s.rows.length !== s.sourceCount) errors.push(`${s.key}: 행 ${s.rows.length} != 원본 ${s.sourceCount}`);
  if (new Set(ids).size !== ids.length) errors.push(`${s.key}: 중복 ID`);
  if (ids.some((x) => !x)) errors.push(`${s.key}: 빈 ID`);
  for (const r of s.rows) {
    if (r.hardware !== HW && r.hardware !== '해당 없음') errors.push(`${r.id}: 하드웨어 표기 오류`);
    if (r.hardware === HW && r.verdict !== HW) errors.push(`${r.id}: 하드웨어 행 판정은 테스트 대기여야 함`);
    if (r.verdict === PASS && (r.software.status !== '항목 직접 근거 PASS' || !r.software.evidence.length)) errors.push(`${r.id}: 직접 근거 없는 PASS`);
    if (r.verdict === PASS && r.ownerInput !== '해당 없음') errors.push(`${r.id}: 외부 입력 필요 항목 PASS`);
  }
}
const expectIds = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`);
for (const [key, prefix, n] of [['rubrics', 'R', 17], ['acceptanceTests', 'A', 26], ['workPackages', 'W', 25]]) {
  const have = new Set(S.find((s) => s.key === key).rows.map((r) => r.id));
  const missing = expectIds(prefix, n).filter((x) => !have.has(x));
  if (missing.length || have.size !== n) errors.push(`${key}: 누락 ${missing.join(',')} 또는 개수 ${have.size}`);
}
const fixedCounts = { gates: 11, liveStages: 24, completionCriteria: 7, requiredCommands: 10, faultFixtures: 29, planRequirementInventory: 237, contractClauseAudit: 153 };
for (const [k, n] of Object.entries(fixedCounts)) if (S.find((s) => s.key === k).rows.length !== n) errors.push(`${k}: ${n}개 아님`);

const total = S.reduce((a, s) => a + s.rows.length, 0);
const verdicts = {};
for (const s of S) for (const r of s.rows) verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
const out = {
  generatedBy: 'docs/final-acceptance-build.mjs',
  source: 'docs/rubric-audit.json',
  verify: { path: verifyPath, generatedAt: verify.generatedAt, status: verify.status, stages: verify.results.map((r) => ({ label: r.label, exitCode: r.exitCode, log: r.log, sha256: r.sha256 })) },
  lanes, counts: Object.fromEntries(S.map((s) => [s.key, s.rows.length])),
  total, verdicts, checks: { ok: errors.length === 0, errors },
  sections: S,
};
writeFileSync(join(root, 'docs/final-acceptance.json'), JSON.stringify(out, null, 2) + '\n');

const esc = (v) => text(v).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const md = [];
md.push('# 최종 요구사항 수용표', '');
md.push('`node docs/final-acceptance-build.mjs` 로 만든 문서다. 직접 고치지 말고 스크립트를 다시 돌린다. 기계용 사본은 `docs/final-acceptance.json` 이고, 원본 항목 전체 필드는 각 행의 `original` 에 그대로 있다.', '');
md.push('## 읽는 법', '');
md.push(`- 소프트웨어 근거는 이번 \`npm run verify\` (${verify.generatedAt}, ${verify.status}, ${verify.results.length}단계) 결과다.`);
md.push(`- \`${PASS}\` 는 항목 expected 를 직접 다룬 현재 근거가 있을 때만 붙는다. 필수 명령은 같은 verify 단계의 종료코드, 장애 fixture는 core-tests 로그의 이름 붙은 통과 시험을 expected 와 하나씩 대조한 결과다. 시험이 시나리오 일부만 다루면 \`소프트웨어 일부 확인·나머지 대기\` 다.`);
md.push('- `계열 회귀 통과·항목 미판정` 은 같은 기능 계열의 시험이 통과했다는 뜻일 뿐이다. 그 항목 자체를 통과로 보지 않는다.');
md.push('- 실물 행동이나 측정(실물, 계측, 현장, 영상, 물리 횟수, 실제 장치 ACK 등)이 들어간 항목은 하드웨어 칸과 판정 칸 모두 정확히 `테스트 대기` 다. 키링·BLE 같은 이름만 나오는 schema 조항은 여기에 넣지 않는다. 실물 시험 순서는 `docs/hardware-tester-checklist.md` 를 본다.');
md.push('- 실계정·실 endpoint·배포·공개 활동이 필요한 항목은 `외부 실증 대기` 다. 이 표는 외부·실물 시험 성공을 주장하지 않는다.');
md.push('- "과거 기록" 열은 감사 시점(2026-11-11) 값이다. 새 결과로 취급하지 않는다.');
md.push(`- lane 증거 폴더: ${lanes.length ? lanes.map((l) => '`' + l.path + '`').join(', ') : '아직 없음'}. lane actual은 root가 검토한 실행 범위이며 항목 전체 판정과 분리한다.`, '');
md.push('## 개수 확인', '', '| 구분 | 원본 | 표 |', '|---|---|---|');
for (const s of S) md.push(`| ${s.label} | ${s.sourceCount} | ${s.rows.length} |`);
md.push(`| 합계 | ${S.reduce((a, s) => a + s.sourceCount, 0)} | ${total} |`, '');
md.push(`검사 결과: ${errors.length ? '실패 ' + errors.join('; ') : '통과 (개수 일치, ID 고유, R01~R17·A01~A26·W01~W25 누락 없음, PASS 행은 모두 직접 근거 있음, 하드웨어 행은 모두 테스트 대기)'}`, '');
md.push('판정 분포: ' + Object.entries(verdicts).map(([k, v]) => `${k} ${v}`).join(', '), '');
md.push('## 이번 verify 단계', '', '| 단계 | 종료코드 | 로그 | sha256 |', '|---|---|---|---|');
for (const r of verify.results) md.push(`| ${r.label} | ${r.exitCode} | ${verifyDir}/${r.log} | ${r.sha256.slice(0, 16)} |`);
md.push('');
for (const s of S) {
  md.push(`## ${s.label} (${s.rows.length})`, '');
  md.push('| ID | 제목 | expected | 과거 기록 | 소프트웨어 상태 | 소프트웨어 actual | 근거 | 하드웨어 | 소유자·외부 입력 | lane 증거 | 판정 |');
  md.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of s.rows) {
    const ev = r.software.evidence.length ? r.software.evidence.join('; ') : (r.software.familyStages.length ? `계열 단계: ${r.software.familyStages.join(', ')}` : '없음');
    md.push(`| ${esc(r.id)} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.historicalStatus)} | ${esc(r.software.status)} | ${esc(r.software.actual)} | ${esc(ev)} | ${r.hardware} | ${r.ownerInput} | ${esc(r.laneEvidence.actual.join('; ') || '없음')} | ${r.verdict} |`);
  }
  md.push('');
}
md.push('## 새 lane 증거로 갱신하는 법', '');
md.push('1. `npm run verify` 를 다시 돌려 `.local/verification/verify/` 를 갱신한다.');
md.push('2. lane 결과를 `docs/final-evidence/<scope>/` 에 둔다 (cse, group, deployment, external, map).');
md.push('3. repo 루트에서 `node docs/final-acceptance-build.mjs` 를 실행한다. 현재 verify 영수증과 단계 원문을 `docs/final-evidence/final/`에 보존하고 수용표가 그 경로를 참조한다. 종료코드 0이어야 한다.');
md.push('4. 검토한 lane 결과나 새 시험으로 항목을 PASS로 올리려면 스크립트에 항목별 직접 근거(`FIXTURE_MATCH` 같은 대조표나 `exact`)를 추가한다. 폴더가 있다는 사실만으로는 판정이 바뀌지 않는다.', '');
writeFileSync(join(root, 'docs/final-acceptance.md'), md.join('\n'));

console.log(JSON.stringify({ counts: out.counts, total, verdicts, lanes: lanes.map((l) => l.scope), ok: errors.length === 0, errors }, null, 1));
process.exit(errors.length ? 1 : 0);
