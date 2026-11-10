# 전체 브랜치 통합

2026-11-10 · DOC-REV 2.0.0 · 로컬 통합 브랜치 `codex/integrate-all-branches`.

## 통합 기준

`main`/`PC-MOBIUS-CORE`의 `d54a43a`를 기준으로 `codex/keyring-namho`의 `432a7aa`, `feature/web-dashboard`의 `80ed37f`를 Git merge로 통합했습니다. 원본 커밋·파일·증거 이력은 통합 브랜치의 ancestry에 포함됩니다. 모든 원격 브랜치를 같은 이름의 로컬 추적 브랜치로 보관합니다.

## 호환 수정

1. Python 3.11의 BLE discovery 완료·취소 경합을 `asyncio.timeout`으로 처리했습니다.
2. CORE의 oneM2M UPDATE 연산, flexContainer/Group 유형, To 주소, MQTT.js 비동기 호출과 즉시 응답 순서를 맞췄습니다.
3. 키링 canonical 명령과 중앙 claim/grant/epoch를 CORE·Group 전달 경로에 연결하고 ACK의 장치·readback 결속을 검증합니다.
4. Gateway 명령 발급·poll·authorize·credential 상태 API를 추가했습니다. 실행 직전 grant/consent/기한/ownership/인증서 revision을 다시 확인합니다.
5. 중앙 HTTPS 서버는 TLS 1.3/mTLS의 인증서 지문을 서버 등록 principal에 연결합니다. 내부 `request.principal`은 검증된 transport가 전달합니다.
6. 정책·MEC·handover·FL·MCP 영수증은 중앙 journal에 기록되며 웹의 혼합 JSONL·감사 검색·서비스 상태에 연결됩니다.
7. handover epoch는 영속 상태와 Gateway 등록 epoch를 이어받습니다. 중앙 JSON 상태 저장은 임시 snapshot·sync·rename을 사용합니다.
8. 루트 `npm run setup`, `npm run verify`로 실행 환경과 검증 절차를 통합했습니다. Node 기준은 22.19 이상입니다.

## 중앙 명령 발급

서버 인증서와 guardian/Gateway 인증서 지문은 `pc-mobius/config/integration-api.example.json`을 기준으로 로컬 설정에 저장합니다. Guardian 인증서로 consent와 grant를 생성한 뒤 다음 본문을 `/v1/gateways/{gatewayId}/commands`에 전송합니다.

```json
{
  "deviceId": "keyring-1",
  "commandId": "command-1",
  "grantId": "<발급된 grantId>",
  "desiredState": { "state": true },
  "deadline": "<grant와 consent 유효기간 안의 RFC3339 시각>"
}
```

서버는 등록된 장치의 household, 소유자와 `bubble:command` scope를 확인하고 claim·revision·epoch를 부여합니다. Gateway는 자신의 인증서로 명령을 조회하고 `authorize`에 Python canonical SHA-256을 전달합니다. 동일 commandId의 동일 의도 재요청은 기존 명령을 반환합니다.

## 실행 증거

루트 `npm run verify`는 CORE·웹·Gateway·Node/Python 교차시험, 계약 검증, oneM2M dry-run, 중앙 데모·재생, TypeScript 검사·웹 빌드를 실행합니다. `.local/verification/verify/`에 각 실행 로그·SHA-256·exit code가 기록됩니다. 공유 검증 요약은 `integration-verification.json`에 보관합니다.

실제 Node/Python 교차시험은 매 실행 새 CA·서버·클라이언트 인증서와 loopback 포트를 생성합니다. 중앙에서 발급한 명령을 Python Gateway TransportHub가 받아 해시·승인·권한 회수를 확인합니다. 종료 시 시험 프로세스와 인증서를 정리합니다.

## 장비·배포 검증 범위

이번 통합의 실행 증거는 로컬 모듈·실제 TLS 통신·웹 빌드와 펌웨어 컴파일입니다. 기존 실제 Mosquitto/Mobius4·POSIX 시험 증거는 `keyring/evidence/2026-10-30-*`에 보존합니다. 배포 CSE, 실물 Pi/BlueZ·키링 BLE·전력·센서·모터 경로는 해당 endpoint·인증서·장비를 연결해 실측 receipt를 추가하는 단계입니다. 웹 이벤트 서버는 시작 시 읽은 영수증 재생 모드입니다.
