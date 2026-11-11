# 후속 TODO

2026-11-11 사용자 지시에 따라 현재 개발·로컬 검증 결과를 확정하고 나머지 항목을 후속 과제로 관리한다. [개발 완료 기록](development-completion.md), [현재 감사](rubric-audit.md), [외부 실증 상세](external-validation-todo.md)를 함께 사용한다.

| 우선순위 | Topic | 다음 작업 | 완료 증거 |
|---|---|---|---|
| P1 | 전체 실물 연결 | 최신 통합 소스를 Pi·키링에 배포하고 버튼→중앙→보호자 승인→장치→readback→웹을 연결 | source/firmware commit·인증서 식별 hash·BLE/HTTP trace·장치/화면 영상 |
| P1 | 보드·전원·음향 | 생산 PCB의 전원·충전·저전압·온도·MCLK/I2S·헤드폰·취소 경계를 측정 | 회로 revision·계측 원본·오실로스코프 캡처·실물 사진 |
| P1 | 실제 OIDC | 운영 issuer/client/subject·callback·역할 등록, 실제 계정별 로그인·갱신·종료 시험 | 계정별 접근·승인·회수·세션 receipt |
| P1 | MEC Sandbox | 실제 Location/RNIS OpenAPI pin·TLS callback·UE/relay 등록 후 M01–M09 수행 | 구독 CRUD·현재 권한·이벤트·시간·복구 receipt |
| P1 | 독립 Edge A/B | 실제 호스트별 agent·CSE·고정 image 배치, 30회 handover·1000관측·rollback·partition 실행 | host/process/image identity·p95·loss/duplicate·복구 로그 |
| P1 | ESTIMED | 할당 VM 3개 이상에 worker 배포, 3seed×10round·late join/dropout/restart·회수·재학습 수행 | 할당 ticket·VM identity·학습·모델 bytes·manifest·동일 split 비교 |
| P1 | CSE 패치 운영 반영 | `apply-mobius-security.mjs`로 지정 Mobius4 소스에 구독 권한 패치 적용, 고정 release로 배포 | 원본/패치 hash·828건 ACP 행렬·위치 5건 회귀 receipt |
| P2 | 그룹 제품 경로 | 포털의 개별 canonical 명령 승인과 durable GroupDispatcher·실제 CSE `/fopt`를 운영 요구에 맞춰 연결 | 다중 실제 장치 부분 성공·재시도·ACK/readback·장애 복구 |
| P2 | 운영 설정 인계 | 배포 hostname·CA·키 회전·비밀 저장·DB backup/restore·관측/경보 설정 | 등록표·runbook·복구 훈련·책임자 |
| P2 | 지도 운영 | 지도 공급자 계정/키·배포 도메인·표시 정책, 현장 RSSI 기준값과 path-loss 보정 | 실제 수신기 좌표·거리 표본·오차/갱신 결과 |
| P2 | 요구사항별 최종 수용 | ZIP R01–R17/A01–A26/W01–W25·gate·LIVE·장애 fixture·237개 plan 항목·153개 계약 조항을 최종 배포/실물 증거와 대조 | 항목별 expected/actual·실행자/검토자·시각·로그 hash |
| P2 | 공개 제출 | Article·5분 미만 실물 영상·release·forum 기여·팀원별 설명 자료 작성 | 공개 URL·게시일·검토 기록·리허설 |

기존 Feather→Pi의 인증된 BLE 관측은 역사적 증거로 보존한다. 최신 중앙 정책·지도·생산 보드까지의 전체 실물 수용은 첫 번째 topic에서 이어간다. 실제 루브릭 점수는 항목별 최종 수용과 심사 결과를 연결하는 단계에서 기록한다.

각 topic을 착수할 때 담당자·예정일·설정 파일 경로를 추가하고, 완료 시 source/image/firmware 식별값과 증거 SHA-256을 연결한다.
