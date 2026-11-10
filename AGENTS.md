# 통합 저장소 개발 지침

기준은 `PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md`의 DOC-REV 2.0.0과 현재 사용자 요청입니다. 통합 작업 브랜치는 `codex/integrate-all-branches`입니다.

- 역할은 PC-MOBIUS-CORE, PC-MOBIUS-INTEGRATION, KEYRING, WEB-DASHBOARD로 나누고 공유 계약의 변경을 관련 소비자와 함께 검증합니다.
- 원본 브랜치의 이력은 로컬 추적 브랜치와 `origin/*`에 보관합니다.
- CORE oneM2M 계약은 `pc-mobius/contracts/`, 키링 계약은 `contracts/keyring/`, 웹 이벤트 계약은 `web-dashboard/contracts/`에서 관리합니다.
- 중앙에서 발급한 claim·grant revision·ownership epoch·deadline과 payload hash를 Gateway·BLE·ACK 경로 전체에서 보존합니다.
- 인증서, 개인키, 운영 설정, SQLite DB, 로컬 상태는 `.local/`·`.venv/` 등 gitignore 대상에 보관합니다.
- 변경 후 `npm run verify`로 모듈 시험·실제 TLS 교차시험·계약·데모·웹 빌드를 실행하고 결과를 기록합니다.
- 펌웨어 검증은 `keyring/firmware/BUILD_PROFILES.md`의 프로필을 사용합니다. 실물 검증은 장비·인증서·endpoint·시험 receipt를 함께 기록합니다.
- 구현·로컬 검증·실물 검증·배포 상태는 각각의 실행 증거로 표시합니다.
