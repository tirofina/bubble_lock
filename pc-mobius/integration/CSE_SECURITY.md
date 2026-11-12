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

runner는 `CSE_DB_CONFIG` 또는 `.local/postgres/connection.json`의 로컬 개발 DB 설정을 사용해 별도 DB와 소스 사본을 만든다. 프로세스·callback은 loopback에 바인딩한다. 종료 시 해당 CSE 프로세스와 이번 실행의 DB만 정리하고 `docs/final-evidence/cse/cleanup.json`에 결과를 남긴다. `CSE_HOLD=1`은 그룹 시험 재사용 동안 프로세스를 유지한다.

2026-11-11 실행에서 역할별 CRUDN/DISCOVER 828건과 위치 보호 5건이 PASS다. 회수 시험은 승인된 변경과 회수 후 변경의 실제 payload label 및 자원 경로로 알림을 구별한다. 초기 subscription verification 메시지도 별도 종류로 식별한다. 공유 receipt는 `docs/verification-evidence/2026-11-11/acp-real-cse.json`에 있다. 실제 운영 CSE 반영은 후속 TODO에서 관리한다.

## 2026-11-12 고정 배포 산출물

기존 `keyring/dev/mobius4/upstream.json`의 commit
`e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8`을 사용했다. 실제 버전은 4.25.0이며
위의 4.24.5 과거 시험과 구분한다. 세 파일의 패치 문맥과 재적용을 확인하고,
패키지에서 실제 로컬 CSE 두 개를 실행해 ACP 828/828과 위치 보호 5/5를 다시 통과했다.
위치 입력은 모의 GPS/BLE이고 CSE·HTTP·PostGIS는 실제 로컬 실행이다.

배포 산출물·이미지·환경변수 계약은 `deployment/cse/README.md`,
원본 archive와 세 파일 변경 전후 SHA-256은 `deployment/cse/artifacts/manifest.json`,
실행 명령과 로그는 `docs/final-evidence/cse/`에 보존한다.
실제 배포 이미지는 384MiB 제한에서 HTTP 200 / RSC 2000과 세 패치 파일 hash를 확인했다.
원격 서버에 배포하지 않았다.
