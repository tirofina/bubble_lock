/**
 * Plain Korean labels for protocol values shown on screen.
 * Unknown values fall back to the raw value so new states stay visible.
 */
type Labels = Readonly<Record<string, string>>;

export function label(map: Labels, value: unknown, fallback = '확인 전'): string {
  if (value === undefined || value === null || value === '') return fallback;
  const key = String(value);
  return map[key] ?? key;
}

export const commandStatusLabels: Labels = {
  pending: '대기 중', 'in-flight': '보내는 중', partial: '일부 확인됨', verified: '적용 확인됨', failure: '실패, 다시 시도 대기',
};

export const ackStateLabels: Labels = {
  RECEIVED: '받음', FORWARDED: '전달함', APPLIED: '적용함', READBACK_VERIFIED: '적용 확인됨', RETRY_PENDING: '다시 시도 대기',
};

export const connectionLabels: Labels = {
  connecting: '연결하는 중', connected: '실시간 연결됨', offline: '오프라인', disconnected: '연결 끊김', invalid: '형식 오류로 멈춤', resync: '다시 받기 필요',
};

export const eventTypeLabels: Labels = {
  'command.accepted': '명령 수락', 'command.dispatched': '명령 전송', 'command.ack': '장치 응답',
  'gateway.telemetry': '수신기 상태 보고', 'receipt.review': '기록 검토', 'group.summary': '그룹 처리 요약',
  'integration.receipt': '서비스 기록',
};

export const receiptTypeLabels: Labels = {
  CONSENT_CREATED: '동의 생성', GRANT_ISSUED: '권한 발급', POLICY_APPROVED: '정책 승인',
  MEC_POLICY_RECONCILE: '위치 서비스 정책 반영', UE_LOCATION_UPDATE: '단말 위치 갱신',
  HANDOVER_ACTIVE: '엣지 전환 완료', HANDOVER_DRAINING: '엣지 전환 준비',
  FL_ROUND: '연합 학습 회차', MCP_AUDIT: '자동화 실행 기록', AUTOMATION_INCIDENT_OPENED: '자동화 사건 기록',
};

export const serviceStateLabels: Labels = {
  ACTIVE: '사용 중', COMPLETED: '완료', RUNNING: '진행 중', DRAINING: '전환 준비 중', RUN_COMPLETED: '실행 완료', PENDING: '대기 중',
  true: '예', false: '아니요',
};

export const outcomeLabels: Labels = { allowed: '허용', denied: '거부', pending: '대기' };

export const scopeLabels: Labels = { 'location:read': '위치 보기', 'bubble:command': '키링 켜고 끄기' };
export const scopeList = (scopes: readonly string[]) => scopes.map((scope) => label(scopeLabels, scope)).join(', ');

export const portalStatusLabels: Labels = {
  ACTIVE: '사용 중', REVOKED: '취소됨', EXPIRED: '기간 끝남', INACTIVE: '동의 확인 필요', PENDING: '승인 대기',
  PARTIAL: '일부만 등록됨, 다시 시도 중', QUEUED: '실행 순서 기다리는 중', CONFIRMED_BY_CSE: '키링 적용 확인됨', OPEN: '접수됨', RESOLVED: '처리 완료',
};

export const serviceMeta: Readonly<Record<string, { readonly label: string; readonly description: string }>> = {
  MEC: { label: '위치 서비스', description: 'MEC 위치 정보 (RNIS)' },
  HANDOVER: { label: '엣지 전환', description: 'Handover, 엣지 A에서 B로' },
  FL: { label: '연합 학습', description: 'FL 회차와 모델 이력' },
  MCP: { label: '자동화 실행', description: 'MCP 승인과 실행' },
};

export const serviceFieldLabels: Labels = {
  eventId: '기록 ID', service: '서비스', eventType: '기록 종류', ueId: '단말 ID', status: '상태', allowed: '허용 여부',
  state: '상태', previousEdgeId: '이전 엣지', edgeId: '현재 엣지', epoch: '전환 차수 (epoch)', grantId: '권한 ID',
  roundId: '학습 회차', participantCount: '참여 수', selectionHash: '참여자 선택 해시', modelHash: '모델 해시',
  runId: '실행 ID', action: '동작', cursor: '진행 위치', principalId: '실행 계정', approvalHash: '승인 해시',
};
