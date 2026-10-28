# KEYRING 개발 지침

이 작업의 담당은 남호 / `KEYRING`이다. 매 작업 시작에 루트 `PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md`를 읽고 현재 DOC-REV·역할·계약·완료 기준을 적용한다. 현재 기준은 원격 `main`에서 인수한 DOC-REV 2.0.0이다.

- `keyring/`, `contracts/keyring/`, 키링 인수인계 문서를 담당한다. 중앙 CSE·권한 정책의 owner는 각각 PC-MOBIUS-CORE와 PC-MOBIUS-INTEGRATION이다.
- 작업 checkpoint에 원격 팀 브랜치를 읽고 변경된 계약을 확인한다. GitHub 요청은 직렬, 최소 5초 간격·분당 10회 이하로 하고 접속 이상이면 추가 요청을 중단한다.
- 현재 역할 브랜치 `codex/keyring-namho`에 작은 commit과 일반 push를 한다. 팀 브랜치 직접 쓰기·자동 merge·force push는 하지 않는다. 팀 코드를 받을 때는 키링 브랜치로만 merge하고 이전 변경을 보존한다.
- 임시 Mobius4 환경은 `keyring/dev/mobius4/`와 저장소 외부 upstream source로 분리한다. 실제 서버로 바뀔 때 endpoint·계약 설정을 교체하고 개발용 credential·mock 승인을 운영 환경에 복사하지 않는다.
- 사용자 지침 `C:/Users/NH/.codex/skills/code-edit-no-validation/SKILL.md`를 따른다. 명시적으로 요청한 임시 서버 구성 외 테스트·빌드·린트·실행·장비/COM 시험을 자동 수행하지 않는다.
- 명령 current grant/epoch/deadline, BLE MITM, TLS 검증을 유지한다. 기존 중앙 명령에 없는 claimId/grantRevision을 임의 생성해 승인된 것처럼 처리하지 않는다.
- `.goalplz/goal-contract.md`와 `.goalplz/progress.md`에 진행·다음 작업·실제 증거를 남긴다. `implemented`, `verified`, `released`를 혼동하지 않는다.
- 실제 키·passkey·운영 credential·로컬 DB·raw 관측값은 commit하지 않는다. 실물 시험·영상은 실제 evidence를 확보해야 완료로 표시한다.
