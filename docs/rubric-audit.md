# ZIP·루브릭 최종 정리

마감일: 2026-11-11. 사용자 지시에 따라 현재 구현·로컬 검증 결과를 확정하고 나머지 항목을 [후속 TODO](remaining-todo.md)로 관리한다.

전체 기준은 ZIP 1098개 항목·중첩 archive 9개, R01–R17, A01–A26, W01–W25, gate 11개, LIVE stage 24개, 장애 fixture 29개, 완료 자료 7종, plan 목록 237개와 계약 조항 153개다. 원문·출처 hash·초기 항목별 판정은 [초기 감사](rubric-audit-initial.md)와 [초기 JSON](rubric-audit-initial.json)에 보존한다. 현재 [감사 JSON](rubric-audit.json)은 최신 검증·증거·TODO를 연결한다.

## 확정한 개발·검증 결과

| 영역 | 현재 근거 |
|---|---|
| 사용자·운영 포털 | 별도 진입·가구/장치·동의/권한·명령 승인·사건·알림·OIDC BFF |
| 지도·위치 보호 | 실제 지도 타일·키링 핀·정확도/BLE 원, 사건·수신자·목적·기한별 lease, 회수 후 지도 제거 |
| 중앙·Gateway | TLS 1.3/mTLS·등록/CSR 인증서·LOST·현재 grant·claim TTL·전송 입장·generation·영속 receipt |
| oneM2M·SDT | canonical R4/명시적 어댑터·XSD closure, 실제 두 CSE·독립 클라이언트·fanout/readback |
| ACP | 실제 두 CSE에서 CREATE/RETRIEVE/UPDATE/DELETE/NOTIFY/DISCOVER 역할 행렬 828건 PASS, 구독 권한 패치 및 위치 보호 5건 PASS |
| MEC·handover·Edge | HTTP 구독·callback·현재 정책·dwell/health/cooldown, 자원 복원·rollback, 실제 별도 process identity·lease |
| FL·MCP | 수치 FedAvg·3seed×10round·mTLS worker·실제 CSE 모델 게시, MCP 3 HTTP 서버·협상·승인·복구 |
| DB·보존 | 실제 PostgreSQL 동시성·재시작·이행, TTL·JSON/SQL receipt 정리·삭제 증거 |
| 펌웨어 | MAX9850 PCM 포함 4개 프로필 컴파일·실제 C++ mock I2C 검증 |
| 기존 실물 증거 | Feather→Pi 인증 BLE·버튼·90초/45관측과 BlueZ 수정 기록 |

2026-11-11 `npm run verify`의 13단계가 PASS다. CORE 155개, 웹 69개, Gateway 63개, 실제 TLS 통합 6개로 총 293개 시험을 수행했다. 타입 검사·웹 빌드·SDT·계약·데모·replay도 같은 실행에 포함한다.

- [검증 summary](development-verification.json), [단계별 로그와 SHA-256](verification/2026-11-11/results.json)
- [공유 실행 증거 manifest](verification-evidence/2026-11-11/manifest.json)
- [브라우저 검증](ui-evidence/2026-11-10/browser-verification.json)
- [펌웨어 receipt](../keyring/evidence/2026-11-10-headphone-pcm/receipt.json)
- [전체 개발 기록](development-completion.md)

## 후속 수용

외부 계정·실물·독립 호스트·배포 설정·공개 제출과 전체 항목별 최종 수용 판정은 [후속 TODO](remaining-todo.md), 준비 자료는 [외부 실증 TODO](external-validation-todo.md)에 기록했다. 초기 감사의 추가 구현 목록은 당시 스냅샷이며 현재 구현은 위 최종 증거와 개발 기록으로 추적한다. 실제 루브릭 점수는 항목별 최종 수용과 심사 결과를 연결하는 단계에서 기록한다.
