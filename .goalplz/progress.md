# KEYRING 진행 기록

## 2026-10-28 — 지속 목표 시작 / DOC-REV 2.0.0 인수

- 사용자 승인: KEYRING 계속 구현, 팀 변경 인수·연동, 역할 브랜치 Git 업로드, 임시 Mobius4 환경 구성. 운영 merge·장비 flash·전면 테스트는 승인 범위로 간주하지 않는다.
- baseline commit `19cb374`: 기존 펌웨어·Pi Gateway·계약·배포 문서 소스를 보존했다. 이전의 uncommitted 작업을 사용자 요청으로 commit했다.
- 원격에서 `PC-MOBIUS-CORE`와 갱신된 main을 읽었다. CORE/source plan revision `91a281b12769493fab6d34d573a6a979f37f7b02`, DOC-REV 2.0.0.
- merge commit `7d1d454`: 역할 브랜치로 팀 코드를 인수했다. 루트 계획서 add/add 충돌은 원격 최신 2.0.0 채택으로 해결했고 이전 1.0.0은 baseline commit에 남아 있다. main/CORE 원격 브랜치를 수정하지 않았다.
- 새 소스: CORE UUID profile/identity extension, telemetry·성공 ACK projection, SQLite CORE sequence, MQTT command 수신과 승인 필드 fail-closed, 임시 Mobius4 compose/PKI/launch 문서.
- upstream `IoTKETI/mobius4`는 저장소 외부 `github_upload/_local/mobius4`에 clone했고 commit `e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8`을 기록했다. 실제 upstream CSE 코드에 손대지 않았다.
- Docker provisioning 준비에서 engine pipe 부재가 확인됐다. Desktop 시작 후 사용자가 오류·종료를 보고했고 재실행했다고 알려 왔다. 종료 원인은 미확인이다. 재시작 반복·DB 삭제는 하지 않았다. 다음으로 요청된 로컬 서버 provisioning을 진행한다.
- 테스트·린트·펌웨어 빌드·flash·장비/COM 연결·통합 시험: 미실행. 원격 commit 업로드 상태와 실제 서버 기동은 각 도구 결과로 별도 기록한다.

## 다음 구현 순서

### 로컬 서버 provisioning 진행

사용자의 Docker 재실행 후 이미지와 CA/client certificate를 실제 생성했다. Compose 출력에서 postgres healthy, broker/mobius4/tls started를 확인했다. 최초 AE 생성 실패 원인은 Mobius4 AE-ID 저장소 varchar(30)에 49자 임시 관리자 ID를 사용한 것이었다. ID를 25자로 제한했고 Mobius4의 초기 DB identity 고정 때문에 기존 volume을 삭제·migration하지 않고 새 pgdata_v2/identity_v2 volume을 생성했다. 최초 volume과 local env 백업은 보존했다. 이후 bootstrap 출력에서 AE 및 첫 container HTTP201/rsc2001 생성이 관찰됐다. 전체 bootstrap 완료 결과는 후속 기록한다.

upstream 서버 image의 npm ci가 자체 출력한 audit summary는 25 vulnerabilities(7 moderate,17 high,1 critical)였다. 별도의 npm audit/test/fix 명령은 실행하지 않았고 dependency 원본은 변경하지 않았다. 서버는 loopback 개발 범위로 제한되어 있으며 운영 적합성을 주장하지 않는다.

Bootstrap가 완료되어 AE(ty2), container 3개(ty3), binarySwitch(ty28) 모두 HTTP201/rsc2001 생성됐다. 실제 설치 결과는 `keyring/dev/mobius4/provisioning-receipt.json`에 공개 가능한 필드만 보관한다. synthetic 관측·장치 command는 생성하지 않았다. 서비스 주소는 localhost:8759/8883이며 Pi 접근·INTEGRATION API·실물 연결은 별도 미완료다. 소스 checkpoint의 원격 업로드를 진행한다.

### Git 업로드 결과와 원격 요청 중단

- source commit `7835874`: CORE 연동과 임시 Mobius4 구성 및 실제 empty-resource 설치 receipt를 commit했다.
- `git push -u origin codex/keyring-namho`가 성공했고 새 원격 역할 브랜치가 생성됐다. main/CORE에는 push하지 않았다.
- 검토용 Draft PR 생성 요청은 GitHub connector에서 `403 Resource not accessible by integration`을 반환했다. PR은 생성되지 않았다.
- 사용자 웹 접근 지침에 따라 해당 오류 이후 GitHub API·CLI 등 다른 경로 재시도와 추가 push/fetch를 중단했다. 재접속은 사용자가 명시적으로 요청할 때 진행한다.
- 이 마지막 상태 기록은 로컬에만 남는다. 전체 goal은 active이며 미완료다. GitHub 재접속이 없어도 남은 독립 firmware/Gateway 구현은 계속할 수 있다.

1. 격리된 임시 Mobius4 provisioning과 실제 생성/기동 상태를 기록한다. 시작과 E2E 검증은 구분한다.
2. CORE와 MQTT app-level receipt/durable ingress 및 BLE frame 확장을 맞추고, INTEGRATION의 claim/grant/current authorization API가 생기면 실제 adapter를 연결한다. 없는 승인 값을 만들지 않는다.
3. 장치 journal 정산·보관 계약, motion wake와 남은 주변장치 드라이버를 하드웨어 출처에 맞춰 구현한다.
4. 사용자 명시 실행 요청과 실물 장비가 확보되면 power/range/reconnect/ACK·시연 evidence를 수집한다. 그 전에는 전체 goal을 complete로 표시하지 않는다.
