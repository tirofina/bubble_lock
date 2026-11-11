# Mobius4 구독 권한 패치

패치 ID: `BUBBLE_SUBSCRIPTION_SECURITY_V1` · 대상 검증: Mobius4 4.24.5.

구독 생성은 대상 자원의 RETRIEVE 권한으로 검사한다. 알림 전송은 생성자의 현재 RETRIEVE, 수신 AE에 대한 생성자·hosting CSE의 NOTIFY 권한을 다시 검사한다. 삭제 알림은 삭제 직전 자원 문맥과 현재 ACP를 함께 사용한다.

```powershell
node pc-mobius/scripts/apply-mobius-security.mjs --mobius-root=<Mobius4경로>
```

스크립트는 원본 문맥을 대조하고 변경 전후 SHA-256을 반환한다. 반복 적용은 ALREADY_APPLIED로 정산한다. 운영 배포는 반환된 hash를 고정 release와 함께 기록한다.

실제 로컬 PostgreSQL·PostGIS와 CSE 두 개의 격리 재현:

```powershell
$env:MOBIUS4_ROOT = '<Mobius4경로>'
node pc-mobius/scripts/run-acp-isolated.mjs
```

runner는 `.local/postgres/connection.json`의 로컬 개발 DB 설정을 사용해 별도 DB와 소스 사본을 만든다. 프로세스·callback은 loopback에 바인딩한다. 종료 시 해당 CSE 프로세스를 정리하고 DB·설정은 로컬 재현 자료로 보존한다.

2026-11-11 실행에서 역할별 CRUDN/DISCOVER 828건과 위치 보호 5건이 PASS다. 회수 시험은 승인된 변경과 회수 후 변경의 실제 payload label 및 자원 경로로 알림을 구별한다. 초기 subscription verification 메시지도 별도 종류로 식별한다. 공유 receipt는 `docs/verification-evidence/2026-11-11/acp-real-cse.json`에 있다. 실제 운영 CSE 반영은 후속 TODO에서 관리한다.
