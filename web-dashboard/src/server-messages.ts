/**
 * English copies of the Korean messages the dashboard server and the portal runtime return.
 * The UI is English by default; Korean stays available through the language setting.
 * Unknown messages pass through unchanged so new server wording stays visible.
 */
export type UiLang = 'ko' | 'en';

/** Language for code outside React components. LangProvider sets <html lang>; anything but Korean reads as English. */
export function uiLang(): UiLang {
  try { return typeof document !== 'undefined' && document.documentElement.lang === 'ko' ? 'ko' : 'en'; } catch { return 'en'; }
}

/** Pick the Korean or English copy for the current page language (non-hook code). */
export function pick(ko: string, en: string, lang: UiLang = uiLang()): string {
  return lang === 'ko' ? ko : en;
}

const serverMessages: Readonly<Record<string, string>> = {
  // Portal boundary (web-dashboard/server/portal.ts)
  '등록된 로컬 화면에서 접근해 주세요.': 'Open this page from the registered local screen.',
  '로그인하여 대시보드에 연결하세요.': 'Sign in to connect to the dashboard.',
  '로그인하여 사용자 공간에 연결하세요.': 'Sign in to connect to your family space.',
  '운영 조회 권한을 확인하세요.': 'This account needs operator read access.',
  '로그인한 화면에서 요청하세요.': 'Send the request from the signed-in page.',
  '로그인한 화면의 동일 origin에서 요청하세요.': 'Send the request from the signed-in page (same origin).',
  '역할을 확인해 주세요.': 'Check the selected role.',
  '요청 크기를 확인해 주세요.': 'The request is too large.',
  '요청 형식을 확인해 주세요.': 'Check the request format.',
  '사용자 범위를 확인해 주세요.': 'Check what this account is allowed to see.',
  '현재 기기 접근 범위를 확인하세요.': 'Check the current keyring access scope.',
  '현재 위치 관측 연결을 확인하세요.': 'Check the connection to the current location feed.',
  '위치 응답의 조회 유효기간을 확인하세요.': 'Check the read window of the location response.',
  '이 경로의 요청 방식을 확인해 주세요.': 'This path does not accept that request method.',
  '요청 경로를 확인해 주세요.': 'Check the request path.',
  'JSON 요청 형식을 사용해 주세요.': 'Send the request as JSON.',
  '입력값과 현재 권한을 확인해 주세요.': 'Check what you entered and your current permissions.',
  '입력값과 요청 형식을 확인해 주세요.': 'Check what you entered and the request format.',
  '승인은 저장했지만 CSE 명령 게시를 확인해야 해요.': 'The approval was saved, but publishing the command to the CSE needs a check.',
  '포털 환경을 확인하세요.': 'Check the portal setup.',
  '방문 돌봄 기기 그룹이 설정되지 않았어요.': 'The caregiver device group is not set up.',
  '방문 돌봄자 화면에서 눌러 주세요.': 'Press this from the caregiver (visitor) view.',
  '방문 돌봄 기기 그룹은 로컬 체험 포털에서만 실행하세요.': 'The caregiver device group runs only in the local demo portal.',
  // Portal runtime (pc-mobius/integration/src/portal-service.mjs, policy-service.mjs, gateway-control.mjs, location-privacy.mjs)
  '운영자가 등록한 기기·Gateway·가구 연결을 확인하세요.': 'Ask the operator to enroll this keyring on the receiver for this family space first.',
  '기기의 기존 가구 연결을 확인하세요.': 'This keyring is already linked to another family space or receiver.',
  '가구 구성원 역할을 확인하세요.': 'Check the member role in this family space.',
  '가구 구성원과 보호자 권한을 확인하세요.': 'Check family membership and guardian permission.',
  '가구 소유자 일치를 확인하세요.': 'Only the owner of this family space can do this.',
  '가구에 연결된 기기를 선택하세요.': 'Choose keyrings connected to this family space.',
  '가구의 위치 공유 기기를 선택하세요.': 'Choose the keyrings to share for this family space.',
  '1~16개 기기를 선택하세요.': 'Choose 1 to 16 keyrings.',
  '가구 전체 명령에는 2~16개 등록 기기가 필요합니다.': 'A whole-household command needs 2 to 16 registered devices.',
  '가구 전체 명령은 기기 목록 없이 요청하세요.': 'Send a whole-household command without a device list.',
  '명령 대상은 household로 지정하세요.': 'Set the command target to household.',
  '기기 목표 상태를 확인하세요.': 'Check the target state for the keyrings.',
  '명령 유효기간을 확인하세요.': 'Check how long the command stays valid.',
  '요청 유효기간은 1~900초로 설정하세요.': 'Set the request validity to 1 to 900 seconds.',
  '새 명령 요청으로 유효기간을 갱신하세요.': 'Send a new request to renew the validity.',
  '승인 대기 중인 요청을 선택하세요.': 'Choose a request that is waiting for approval.',
  '승인된 명령을 확인하세요.': 'Check the approved command.',
  '승인한 보호자 권한을 확인하세요.': 'Check the approving guardian permission.',
  '현재 가구의 유효한 명령 승인 권한을 확인하세요.': 'Turn on a valid command permission for this family space first.',
  'Group 명령 요청을 선택하세요.': 'Choose a group command request.',
  '그룹 fan-out 결과를 확인하세요.': 'Check the group fan-out result.',
  '가구 Group 명령 서비스 설정을 확인하세요.': 'Check the household group command setup.',
  '도움·분실·안전 요청 유형을 선택하세요.': 'Choose help, lost or safety as the request type.',
  '같은 가구의 진행 중인 사건을 선택하세요.': 'Choose an open help request in the same family space.',
  '같은 요청 키에는 원래 요청 내용을 사용하세요.': 'This request key was already used with different content.',
  '본인 알림을 선택하세요.': 'Choose one of your own notifications.',
  '알림을 찾지 못했어요.': 'Notification not found.',
  '사용자 동의 범위에서 제공하는 기능을 선택하세요.': 'Choose features offered within the consent scope.',
  '동의 소유자 권한을 확인하세요.': 'Only the owner of the consent can do this.',
  '승인 grant와 같은 조회 목적을 선택하세요.': 'Use the same purpose as the approved permission.',
  '보호자의 현재 위치 grant를 선택하세요.': 'Choose the guardian\'s current location permission.',
  '보호자의 현재 MEC 위치 grant를 선택하세요.': 'Choose the guardian\'s current MEC location permission.',
  '현재 수집 승인 grant를 확인하세요.': 'Check the current collection permission.',
  '등록된 가구 수신자를 선택하세요.': 'Choose a recipient from this family space.',
  '위치 공유 승인을 선택하세요.': 'Choose a location sharing approval.',
  '위치 공유 유효기간을 1~300초로 설정하세요.': 'Set location sharing to 1 to 300 seconds.',
  '위치 참조의 원본 내용을 유지하세요.': 'Keep the original location reference unchanged.',
  '암호화 위치 원본 hash를 확인하세요.': 'Check the hash of the encrypted location source.',
  '등록된 키링·Gateway·릴레이 UE 연결을 확인하세요.': 'Check the registered keyring, receiver and relay UE link.',
  '이 가족의 보호자 계정으로 로그인해 주세요.': 'Sign in with a guardian account of this family.',
  // Guardian alerts (web-dashboard/server/guardian-alerts.ts)
  '공유 초안이 아직 도착하지 않았어요. 잠시 후 다시 눌러 주세요.': 'The share draft has not arrived yet. Try again in a moment.',
  '도움 요청 버튼이 눌린 알림은 괜찮음으로 닫을 수 없어요.': 'An alert raised with the help button cannot be closed as fine.',
  '보호자가 승인한 위치 공유가 열려 있을 때만 위치를 보여 드려요.': 'Location is shown only while a guardian-approved share is open.',
  '승인할 위치 공유 초안을 찾지 못했어요.': 'No location share draft to approve was found.',
  '이 공유를 받을 보호자만 승인할 수 있어요.': 'Only the guardian who receives this share can approve it.',
  '초안 hash를 확인해야 해요.': 'The draft hash must be checked.',
  '화면의 초안과 저장된 초안이 달라요. 새로고침해 주세요.': 'The draft on screen differs from the saved draft. Refresh the page.',
  '재생 모드에서만 쓸 수 있어요.': 'Available only in replay mode.',
  '보호자 기록 컨테이너를 찾지 못했어요.': 'The guardian record container was not found.',
  '승인 요청 컨테이너를 찾지 못했어요.': 'The approval request container was not found.',
  '승인 결과 형식을 확인하세요.': 'Check the approval result format.',
  '대시보드 연결 상태를 확인하세요.': 'Check the dashboard connection.',
  // Auth (web-dashboard/server/oidc-session.ts), shown on the sign-in screen
  '로그인 갱신이 필요합니다.': 'Your sign-in needs to be renewed.',
  '로그인 세션을 확인하세요.': 'Check your sign-in session.',
  '로그인을 새로 시작해 사용자 인증을 연결하세요.': 'Start a new sign-in to connect your account.',
  '진행 중인 로그인 처리가 완료된 뒤 다시 연결하세요.': 'Wait for the current sign-in to finish, then reconnect.',
  '인증 서비스를 준비하고 있습니다.': 'The sign-in service is starting.',
  '구현 대조 기록을 준비하고 있습니다.': 'The implementation evidence is being prepared.',
  // Keyring enrollment by the operator (portal-service.mjs, server/portal.ts)
  '등록할 가구를 선택하세요.': 'Choose the family space to enroll into.',
  '등록된 수신기를 선택하세요.': 'Choose an enrolled receiver.',
  '사용 중인 수신기를 선택하세요.': 'Choose an active receiver.',
  '이미 다른 가구나 수신기에 등록된 키링이에요.': 'This keyring is already enrolled for another family space or receiver.',
  '키링 등록 권한을 확인해 주세요.': 'You need the device:enroll permission to enroll keyrings.',
  // English runtime message; Korean copy for the Korean setting (English passes through unchanged)
  '키링 등록 권한이 필요해요.': 'Scope device:enroll requires an active grant',
  // Notification titles (portal-service.mjs event() and enrollment)
  '운영자가 새 키링을 등록했습니다. 가족과 키링 화면에서 연결하세요.': 'The operator enrolled a new keyring. Connect it on the Family and keyrings page.',
  '새 가구가 등록되었습니다.': 'A new family space was created.',
  '새 동의가 저장되었습니다.': 'A new consent was saved.',
  '승인 권한이 발급되었습니다.': 'An approval permission was issued.',
  '동의가 회수되어 연결된 권한이 종료되었습니다.': 'The consent was revoked and its permissions ended.',
  '명령 승인 권한이 회수되었습니다.': 'The command approval permission was revoked.',
  '새 안전 요청이 도착했습니다.': 'A new safety request arrived.',
  '안전 요청 처리가 완료되었습니다.': 'The safety request was resolved.',
  '기기 명령 승인을 기다리고 있습니다.': 'A keyring command is waiting for approval.',
  '명령이 승인되어 Gateway 전달을 기다리고 있습니다.': 'The command was approved and is waiting for the receiver.',
  '일부 명령이 전달 대기 중입니다. 남은 기기 상태를 확인하세요.': 'Some commands are still waiting to be delivered. Check the remaining keyrings.',
  '가구 전체 Group 명령을 한 번에 보냈습니다.': 'The whole-household group command was sent at once.',
  '실패한 구성원에게 Group 명령을 다시 보냈습니다.': 'The group command was sent again to the members that failed.',
};

/** Messages with a variable part: [Korean pattern, English pattern, English template, Korean template]. `$1` is the captured part. */
const serverPatterns: readonly (readonly [RegExp, RegExp, string, string])[] = [
  [/^(.+) 기기가 등록되었습니다\.$/u, /^Keyring (.+) was registered\.$/u, 'Keyring $1 was registered.', '$1 기기가 등록되었습니다.'],
];

const englishToKorean: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(serverMessages).map(([ko, en]) => [en, ko]));

/** Translate a server message for the selected language (Korean to English, or English to Korean where mapped). Unknown messages pass through. */
export function translateServerMessage(message: string, lang: UiLang): string {
  if (lang === 'ko') {
    const direct = englishToKorean[message];
    if (direct !== undefined) return direct;
    for (const [, en, , koTemplate] of serverPatterns) if (en.test(message)) return message.replace(en, koTemplate);
    return message;
  }
  const direct = serverMessages[message];
  if (direct !== undefined) return direct;
  for (const [ko, , enTemplate] of serverPatterns) if (ko.test(message)) return message.replace(ko, enTemplate);
  // A Korean server message without a mapping still reads as English.
  if (/[가-힣]/.test(message)) return 'The request could not be completed. Check the input and your permissions, then try again.';
  return message;
}
