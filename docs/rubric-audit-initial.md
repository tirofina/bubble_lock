# ZIP·루브릭 구현 감사

감사 시각: 2026-11-10T08:26:19.098551+00:00 · 기준 commit: `191b603d540b244d138d7b5b51278f35ddee4738`

전체 범위는 R01–R17, A01–A26, W01–W25, gate 11개, LIVE stage 24개, dispatch/MEC/FL 장애 fixture 29개, 완료 자료 7종이다. 문서 목록 요구사항 237개와 우선 실행계약 세부 조항 153개도 출처·구현 근거에 연결했다. 상세 원문·SHA-256·개별 수용 조건은 [rubric-audit.json](rubric-audit.json)에 기록했다.

이번 감사 기준에서는 소프트웨어 계약·Gateway·로컬 CSE/TLS·dashboard·firmware build 근거를 확보했다. 전체 Expert 수용은 MEC 실제 서비스, FL 실제 학습, MCP wire/승인 복구, 두 Edge 상태 복원, 실물 시험 및 공개 활동 receipt를 연결하는 단계다. ZIP의 Green 점수는 설계 준비도 평가이며 실제 시험 점수는 `null`이다.

**스냅샷 범위:** UI/지도/사용자 API/OIDC 확장 작업과 병행한 감사다. 구현 완료 후 변경 파일 hash·최신 verify·브라우저 결과를 갱신한다.

## 기준 자료 및 ZIP 검사

| 자료 | 크기 | 항목 수 | SHA-256 |
|---|---:|---:|---|
| `../deliverables.zip` | 103,902,074 B | 1098 | `0372268b4ca928b2f363992efa93f60ea90a32085ce76c5fe1db57b8b58640db` |
| `../ts3.zip` | 8,644,638 B | 2 | `23c31b06e13fdf9fe378bd478210b1e950bc85cdcc4dba9fafc061e382099a4c` |

외부 ZIP 및 중첩 ZIP의 경로 검사를 통과했다. `deliverables.zip`에는 설계·계약·Mobius·CAD·논문/발표 자료와 중첩 ZIP 9개가 있다. `.tsx/.jsx/.dart/.swift/.kt` 제품 화면 소스는 0개다. `ts3.zip`은 TS-0003 Security Solutions V3.17.1 DOC 2종이다. ZIP 내부 명령과 바이너리는 읽기 전용 감사 대상이다.

저장소와 부모 폴더의 `PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md`는 같은 SHA-256이다. 실행 기준은 `active_release.json`의 우선순위에 따라 round03 계약→calendar→원래 design이다. ZIP `acceptance_plan.json`의 A01–A26은 `NOT_RUN`으로 보존되어 있다.

## 계약 정합화

ZIP round03 우선 실행계약은 `cod:binSh`와 공식/derived XSD lineage를 요구한다. 현행 DOC-REV2 플랜·CORE fixture·XSD는 `pb:binarySwitch`를 사용한다. 기존 클라이언트와 호환되는 명시적 version adapter, canonical registry revision, 두 wire 형식의 실제 CSE receipt를 추가한다. 이 차이는 A01/R11과 JSON `sourceContractDifferences`에 연결했다.

## 구현 근거와 추가 범위

| 영역 | 실제 코드·시험 관찰 |
|---|---|
| CORE · oneM2M 계약·CSE·SDT | 계약·XSD·실행 runner와 과거 격리 CSE 저장/조회 시험 근거 확보. 공급자 2×클라이언트 2 교체와 공식 XSD lineage, 최신 CSE wire receipt를 G-SDT에 연결한다. |
| GROUP · Group·fan-out·명령 | member별 전송·ACK·재시도 코드와 fake bridge 시험 확보. 실제 CSE /fopt 집계와 member macp, 두 조명의 물리 ACK/readback 시험이 최종 수용 범위다. |
| TRANSPORT · BLE·MQTT·HTTPS·queue | BLE session·TLS·durable queue·재전송 코드, 로컬 broker/CSE 실증 근거 확보. Raspberry Pi/BlueZ와 실물 키링 경로의 pairing·범위·배터리·packet trace를 추가 수집한다. |
| POLICY · 인증·권한·dispatch | mTLS principal·grant 수명·scope·승인·queue/claim 검사가 구현되어 있다. OIDC 사용자 경로·ACP CRUDN/DISCOVER 전체 행렬, PostgreSQL 트랜잭션·D01~D09 물리 실행 계측은 추가 검증 범위다. |
| STORE · 정책 정본·DB | 현재 integration runtime은 JSON snapshot 영속화다. SQL migration은 schema 근거이며 운영 정책 정본 PostgreSQL 연결·행 잠금·outbox 원자성 구현을 요구한다. 격리 CSE의 PostgreSQL 저장 시험은 별도 범위다. |
| MEC · MEC·callback·위치 정책 | 현재 adapter 기본 query는 로컬 응답이며 ingress는 eventId 중복 저장을 처리한다. Mp1 discovery·Location/RNIS 실제 CRUD, opaque token/current grant·시각·generation 검증, uncertain/tombstone/reconcile 구현과 M01~M09 검증을 확장한다. |
| HANDOVER · Edge 배치·상태 복원 | Edge 등록·load 선택·epoch·rollback 상태 코드 확보. 실제 두 호스트 deployment, CSE/AE-ID 재매핑·구독/Group/ACP 복원, active dispatch drain barrier·30회/1000관측 측정이 추가 구현/실증 범위다. |
| FL · FL 학습·다중 round | 현재 round/VM/update 메타데이터와 artifactHash 집계 코드 확보. 실제 모델 tensor FedAvg·고정 데이터 분할/3seed 평가·중복 participant quorum·10round/latejoin·consent CAS·publication fence를 추가 구현한다. ESTIMED VM 실행 receipt를 수집한다. |
| MCP · MCP·Agent 승인·복구 | 3개 JS handler registry와 cursor/owner persistence 확보. MCP wire server·tool JSON Schema·승인 전 대기·timeout·현재 grant 재검사·side effect 후 crash/retry idempotency를 확장하고 실제 3서버 trace를 기록한다. |
| APP · Guardian·Visitor 제품 흐름 | 감사 기준에는 운영 dashboard와 정책 API가 연결되어 있다. Guardian/Visitor 로그인·가구/기기 등록·consent/승인/회수·incident/알림·개인 범위 API는 이번 구현 작업에서 확장 중이며 후속 통합 시험으로 갱신한다. |
| WEB · 운영 UI·실시간 지도 | resource/event/receipt/evidence UI와 위치 feed, 키링 pin·RSSI 반경·시각/출처·브라우저 실시간 갱신 근거 확보. 사용자/운영 진입·권한별 제품 흐름·MEC/handover/FL 실제 상태 연결은 이번 변경 및 각 서비스 gate로 검증한다. |
| HARDWARE · PCB·firmware·실물 | PCB r18 자료·firmware·Gateway·3개 build profile 근거 확보. MAX9850 PCM 재생 및 실물 전원/충전/저전압/열/범위/ACK 시험, assembly revision 사진과 측정 로그를 추가한다. |
| EVIDENCE · 시험·release·replay | 단위/로컬 통합·빌드·replay receipt와 hash manifest 확보. A01~A26별 실제 expected/actual·담당/검토자·gate·host/runtime digest를 연결하고 새 환경 replay 및 최종 release SHA를 고정한다. |
| PUBLIC · Article·영상·공개 활동 | Article 초안·화면/문서 근거 확보. 공개 Article·5분 미만 실물 영상·forum 질문/응답·팀원별 interview rehearsal은 활동별 URL·일시·참여자·artifact hash로 수집한다. |

## Rubric 17개

| ID | 항목 | 수용 시험 | 근거 영역 | 판정 |
|---|---|---|---|---|
| R01 | Innovative use of oneM2M | A03, A04 | GROUP, POLICY, TRANSPORT | 부분 구현·최종 수용 증거 연결 |
| R02 | Use of appropriate communication protocols | A05 | CORE, TRANSPORT | 부분 구현·최종 수용 증거 연결 |
| R03 | Innovative scenarios | A06, A20 | APP, HARDWARE, TRANSPORT, WEB | 부분 구현·최종 수용 증거 연결 |
| R04 | Quality of Article | A21 | PUBLIC | 부분 구현·최종 수용 증거 연결 |
| R05 | Quality of Video | A22 | HARDWARE, PUBLIC | 부분 구현·최종 수용 증거 연결 |
| R06 | Quality of Github | A23 | EVIDENCE, PUBLIC | 부분 구현·최종 수용 증거 연결 |
| R07 | Promotion of oneM2M | A24 | CORE, PUBLIC | 부분 구현·최종 수용 증거 연결 |
| R08 | Judge points | A25 | PUBLIC | 부분 구현·최종 수용 증거 연결 |
| R09 | Interview points | A26 | APP, HANDOVER, PUBLIC | 부분 구현·최종 수용 증거 연결 |
| R10 | Security and Privacy | A07, A08, A09 | HANDOVER, MCP, MEC, POLICY, STORE, TRANSPORT | 부분 구현·최종 수용 증거 연결 |
| R11 | Data Interoperability and Discoverability | A01, A02 | APP, CORE | 부분 구현·최종 수용 증거 연결 |
| R12 | CSE Handover & Service Continuity | A11, A12 | HANDOVER, POLICY, STORE, TRANSPORT | 부분 구현·최종 수용 증거 연결 |
| R13 | oneM2M–MEC Application / VM Deployment | A10, A12 | HANDOVER, POLICY, STORE | 부분 구현·최종 수용 증거 연결 |
| R14 | Federated Learning (TR-0084) | A13, A14, A15 | FL, STORE | 부분 구현·최종 수용 증거 연결 |
| R15 | Geolocation Services | A16 | MEC, WEB | 부분 구현·최종 수용 증거 연결 |
| R16 | MEC Services | A17, A18 | MEC, STORE | 부분 구현·최종 수용 증거 연결 |
| R17 | AI Agents & MCP Integration | A19 | MCP, POLICY, STORE | 부분 구현·최종 수용 증거 연결 |

## 수용 시험 A01–A26

| ID | 시험 | 구현·시험 추가 범위 | 실장비·계정·공개 증거 |
|---|---|---|---|
| A01 | SDT·타입 | 최신 runtime에 정상/타입 오류 SDT CRUD·discovery 실행; 공식/derived XSD dependency closure·registry hash lineage | 최신 Mobius CSE endpoint·runtime digest |
| A02 | 발견·교체 | 공급자 A/B binarySwitch와 독립 client 2개 교체 fixture/실행; 하드코딩 경로를 discovery 기반 주소 해석으로 검증 | 공급자 2종·client 2종의 wire trace/영상 |
| A03 | 복합 서비스 | 실제 CSE group/fopt→member별 dispatch/ACK 연결; member macp·실패 집계 trace | 실물 두 조명 또는 두 actuators·ACK/readback |
| A04 | Group 실패 | member 권한/연결 장애·재시작/duplicate receipt 교차 시험; 물리 실행 수와 서버 claim 수 별도 계측 | 실물 부분 실패/중복 실행 관찰 |
| A05 | 프로토콜 | 현행 main 기준 MQTT/HTTPS 재연결·ACL trace 재실행; BLE→Pi→CSE 동일 event identity 종단 추적 | Raspberry Pi·키링·broker/CSE packet/TLS logs |
| A06 | 사건 종단 | PANIC→policy→MEC→guardian→ACK 종단 runner; 30회 p95≤5초·연결 복구/last-seen 계측 | 키링 버튼·Pi·사용자 알림 실제 30회 |
| A07 | 권한 행렬 | 5개 역할 CRUDN/DISCOVER ACP 행렬·originator spoof/direct bypass 검증; OIDC 사용자 인증·서비스 identity 경계 교차 시험 | 운영 PKI/OIDC·CSE ACP 정책 환경 |
| A08 | 만료·회수 | queue·MEC callback·MCP retry·handover의 current grant/TTL 재검사; revoke/claim 경합·시계·decision receipt 연결 | 현장 실행 시각과 gate reviewer 검토 |
| A09 | 재생·격리 | advertisement counter replay·reverse·LOST/Freeze 격리와 정상 기기 지속 시험 | 실물 compromised/healthy 키링 분리 관측 |
| A10 | 호스트 배치 | 실제 Edge A/B inventory·eligibility/location/health deployment adapter; process·DB·CSE 상태를 배치 manifest와 대조 | Edge 호스트 2대·DB·배포 자격증명 |
| A11 | 자동 전환 | 실제 state transfer·drain/epoch fence·accepted sequence runner; 30회 handover·1000관측·p95≤5초·loss/physical duplicate 계측 | Edge A/B·키링·Pi 실환경 |
| A12 | 보안·상태 복원 | AE/resource ID mapping·subscription/group/security context 복원; source fail/rollback·old epoch/split-brain 차단의 경합 검증 | 두 CSE·DB 상태 snapshot과 실제 전환 trace |
| A13 | FL·VM | 실제 학습 tensor aggregation·round progress·oneM2M FL resource 연결; 3초기 client/10round coordinator 실행 | ESTIMED VM account·host/process identity |
| A14 | FL 동적 복구 | unique participant quorum≥2·round3 latejoin·staleupdate 경계; coordinator restart·epoch CAS·once aggregation·다음 round 재개 | 실제 VM 동적 participant/restart receipt |
| A15 | FL 학습 평가 | 360행 고정split·3seed·local-only/FedAvg 모델 학습/평가; macro-F1/error/bytes/time·dataset locality/consent 기록 | 고정 데이터·ESTIMED 측정 환경 |
| A16 | 위치 판단 | BLE relay와 Sandbox UE의 subject/time/uncertainty 분리; stale/zone 이벤트와 current grant 기반 policy transition 검증 | Sandbox UE Location/RNIS·gateway 관측 연결 |
| A17 | MEC 양방향 | Mp1 discovery·Location/RNIS POST/GET/PUT/DELETE transport 구현; operationId·schema/version·subscription ID·callback outcome 연결 | MEC sandbox endpoint·credentials·reachable TLS callback |
| A18 | MEC 장애·멱등 | token/generation/provider/UE/current grant·dedup24h·stale30s/future2s 검사; CREATE/CANCEL_UNCERTAIN·tombstone·backoff/reconcile·M01~M09 | MEC timeout/5xx/restart/latecallback fault injection |
| A19 | Agent·MCP | MCP transport 3서버·JSON Schema·승인 전 대기·idempotency timeout; side effect/cursor crash 경합·scope·prompt injection fixture | 실제 MCP server trace·승인자 receipt |
| A20 | HW 전원 | firmware 기능별 flash/build 연결; MAX9850 PCM 재생 경로·전원 계측 fixture 추가 | 조립 보드·전원계/전자부하/온도계·500mA/3V cutoff·BLE ACK 영상 |
| A21 | Article | Article 초안에 실물 제조/배포·protocol/resource·측정 결과 반영 | 공개 Article URL·외부 재현자 검토/댓글 |
| A22 | Video | 4:40 storyboard 기반 caption/voice/실물·모의·측정 표시 | 최종 5분 미만 영상·원본·출연/촬영 |
| A23 | GitHub | standalone clean install/build/deploy/replay·release SHA 고정; 라이선스/secret cleanup·Article backlink 점검 | 외부 새 환경 재현·실제 public release URL |
| A24 | 홍보 | oneM2M 도입 효과를 코드/설정/지연 비교로 Article·영상·repo 정합화 | 공개 자료 URL·실측 비교표 |
| A25 | 공개 토론 | 재현용 기술 질문·응답·commit 근거 초안 정리 | 공개 forum 실제 질문/응답/후속 기여 URL·date |
| A26 | 면접 | 팀원별 random 5문항·device swap/revoke/failover rehearsal checklist | 구성원별 직접 설명·시연·rehearsal 기록 |

## 작업 패키지 W01–W25

| ID | 작업 | 담당 | 근거 | 최종 확인 |
|---|---|---|---|---|
| W01 | 외부 접근과 버전 고정 | A | CORE, HARDWARE, MEC, FL, HANDOVER | ESTIMED VM/배포 권한·MEC 엔드포인트·콜백/TLS·Mobius runtime probe. 관련 문의 초안 준비. |
| W02 | 키링·BLE·릴레이 | B | TRANSPORT, HARDWARE | 물리 버튼·카운터·광고·GATT ACK·재생 방지·릴레이 저장 큐. 전원 시험과 병행. |
| W03 | SDT와 발견 | A E | CORE | 가전 표준 모델·확장 스키마·발견·두 클라이언트·장치 교체. |
| W04 | Group와 결과 | A | GROUP | 동일 동작 그룹·구성원 ACP·부분 실패·명령 멱등과 실제 ACK. |
| W05 | 신원·전송 보호 | A C | POLICY, TRANSPORT | HTTPS/MQTTS, 인증 주체와 Originator 고정 매핑, CSE 직접 우회 차단. |
| W06 | 보호자·방문자 앱 | C E | APP | 추상 상태·사건·승인·만료·가전 허용 범위·진행 상태. |
| W07 | Lease와 Capability | C A | POLICY, APP | 정책 저장소·매 연산 검사·큐 실행 재검사·회수·LOST/Freeze. |
| W08 | MEC 양방향 IPE | A D | MEC | Mp1 발견·Location/RNIS 구독 생성/변경/해제·callback·reconcile. |
| W09 | 세 환경 배포 | D | HANDOVER, STORE | Cloud IN-CSE, 실제 Edge A/B MN-CSE·Postgres, 제어기·TLS·health·모니터링. |
| W10 | 자동 배치·재연결 | D E | HANDOVER | 호스트 적격성·지역·가용성 판단·실제 프로세스/자원 이전·실패 rollback. |
| W11 | 연속성·fencing | A D E | HANDOVER, POLICY, STORE | 서로 다른 AE/CSE ID 재매핑·구독·그룹·정책·epoch·버퍼/중복 복원. |
| W12 | FL 데이터·기준 모델 | D E | FL | 합성/시험 동작 데이터 생성·분할 고정·로컬 기준 모델·feature 버전. |
| W13 | oneM2M FL 조정 | D B | FL | ESTIMED VM의 조정기, 참여자·task·round·artifact metadata 자원과 가중 집계. |
| W14 | 동적 FL와 복구 | D B | FL | 10라운드·지연 참여·이탈·stale update·중단 재개·모델 비교. |
| W15 | 세 MCP 서버 | C | MCP | oneM2M·MEC intent·Audit 도구 스키마/권한·timeout·입출력 검증. |
| W16 | 지속 상태 Agent | C | MCP, STORE | 계획·승인·집행·검증 상태기계·증분 재개·중복 집행 억제·prompt injection 시험. |
| W17 | 하드웨어 bring-up | B | HARDWARE | 배터리 허용 전류·전압 차단 정책·BL 인터페이스·부하·충전·발열 검증. 실장 지연 시 DevKit 병행 표시. |
| W18 | 증거 수집 기반 | E | EVIDENCE | 상관 ID·UTC/clock offset·메트릭·test runner·재현 seed·영상 fixture. |
| W19 | 전체 기능·장애 검증 | ALL | EVIDENCE | A01–A20 기술 시험 실행. A21–A26은 W21–W25의 최종 산출물·활동·면접 기록으로 별도 완료 판정. |
| W20 | 결함 수정·기능 동결 | ALL | EVIDENCE | 실패 증거 보존·수정·필요한 재시험·권한/회수/이전/학습 전 경로 재검토. |
| W21 | Hackster와 설계 문서 | E | PUBLIC | 빌드·도식·리소스·프로토콜·측정·실패 사례·oneM2M 이점. 최종 실측 반영은 W20 후. |
| W22 | 영상 | E | PUBLIC, HARDWARE | 4분40초 본편·자막/음성·실제/모의 표시·원본 녹화와 상세 증거 부록. |
| W23 | 공개 저장소·재현 | A E | EVIDENCE, PUBLIC | 소스·lockfile·설정 예시·배포/테스트·라이선스·보안정보 제외. 최종 tag는 W20 후. |
| W24 | 공개 기술 토론 | E | PUBLIC | 실제 재현 문제·질문·응답·해결 기여를 공개 포럼에 남길 팀 작업. 발송은 이 작업에서 수행하지 않음. |
| W25 | 면접·제출 | ALL | PUBLIC | 구성원별 모의 Q&A·증거 빠른 검색·11/19 release·11/20 업로드 확인. |

## Gate 및 실행 단계

| Gate | 계획 일자 | 실제 receipt에 필요한 자료 |
|---|---|---|
| G0 | 2026-10-22 | account owner+permission ticket; ESTIMED VM hostId+process identity; runtime image digest+commit; endpoint URL+TLS identity+callback ingress; board revision+assembly access |
| G-SDT | 2026-10-27 | official/derived schema checksum+lineage; schema compile log+dependency closure; registry build log+runtime digest; CRUD/discovery receipts for 2 suppliers×2 clients |
| G-SEC | 2026-11-02 | principal→originator matrix; ACP pv/pvs permission report; D01~D09 dispatch state traces; grant/epoch/physical ACK correlated clocks |
| G-MEC | 2026-11-04 | deployment Swagger hash+API info version; operationId+request/response status; Location/RNIS subscription IDs+callback trace; restart reconciliation/orphan cleanup report |
| G-CONT | 2026-11-10 | inventory+deployment manifest+health; ownership epoch+drain barrier trace; ESTIMED VM FL10rounds+late join/restart; MCP approval/checkpoint/readback receipts |
| G-RELEASE | 2026-11-19 | frozen release SHA+lockfiles; A01~A26 linked evidence statuses; new environment replay report; article/video/repository actual URLs; HTML/JSON/PPT manifest revision check |
| G-CORE | 2026-10-29 | 해당 milestone의 taskCompletionReceipt 묶음; actual runtime/evidence hash와 수용 판정 |
| G-DEPLOY | 2026-10-27 | 해당 milestone의 taskCompletionReceipt 묶음; actual runtime/evidence hash와 수용 판정 |
| G-PUBLIC | 2026-11-12 | 해당 milestone의 taskCompletionReceipt 묶음; actual runtime/evidence hash와 수용 판정 |
| G-SUBMIT | 2026-11-20 | 해당 milestone의 taskCompletionReceipt 묶음; actual runtime/evidence hash와 수용 판정 |
| G-FREEZE | 2026-11-17 | 해당 milestone의 taskCompletionReceipt 묶음; actual runtime/evidence hash와 수용 판정 |

각 gate는 실제 실행자·검토자·hostId·imageDigest·sourceCommit·시작/종료 시각·testId·expected/actual·logSha256·artifactRef를 연결한다. W02-LIVE–W25-LIVE의 24개 task receipt와 milestone receipt는 JSON에서 각각 보존한다. 현재 감사 판정은 실제 gate 검토 receipt 연결 단계다.

## 장애 fixture 29개

| ID | 입력·시나리오 | 수용 결과 |
|---|---|---|
| D01 | t0 RESERVED(e7,r4);t1 revoke commit r5;t2 claim | SETTLED_CANCELLED/GRANT_REVISION, dispatchCount0, physicalCount0 |
| D02 | t0 RESERVED expiresAt100;t1 DBclock101;t2 claim | SETTLED_CANCELLED/EXPIRED, dispatchCount0 |
| D03 | t0 RESERVED source e7;t1 QUIESCE/drain/CUTOVER target e8;t2 source claim | SETTLED_CANCELLED/OLD_EPOCH, target current owner receipt only |
| D04 | source/target simultaneous claim for same commandId/member | 직렬화된 current owner 1건 수락, unique claim receipt 1건, device lane 단일 점유 |
| D05 | claim commit→process restart before send | same claimId 조회, 권한/epoch 유효 시 single outbox 재개; 회수/전환 확인 시 정산 취소 |
| D06 | claim commit→transport write begun→revoke commit→ACK/readback | UI SETTLING→APPLIED_VERIFIED 또는 SETTLED_CANCELLED, 시각4종과 in-flight count 기록 |
| D07 | claim commit→ACK 소실→CUTOVER 요청 | source QUIESCING, 같은 commandId readback 정산 후 active count0일 때 epoch+1 |
| D08 | 원본 ACK 도착과 target 재개가 동시 발생 | receipt unique(commandId,member), 동일 journal 결과 회수, measured physicalCount와 서버claimCount 별도 대조 |
| D09 | old epoch DISPATCH_UNCERTAIN→target newer desiredGeneration→source delayed ACK | old lane 정산/transport fence 뒤 새 generation을 입장시키고 최신 state readback 일치. same commandId receipt 단일성 및 물리 횟수 별도 기록 |
| M01 | Location token + RNIS body / 다른 UE / provider identity 변경 | BINDING_REVIEW audit·상세 ingest0 |
| M02 | old generation·만료 route·회수 route의 callback | TOMBSTONE/EXPIRED/REVOKED audit·상세 ingest0 |
| M03 | 동시 동일 eventId 2건과 eventId 없는 동일 payload 재전달 | canonical state commit1·outbox1·dedup receipt2 |
| M04 | 역순 observedAt·stale31s·future3s·source time 부재 | TIME_REVIEW/UNKNOWN audit·위치자동정책은검증된시각조건 |
| M05 | t0 callback 준비→t1 revoke commit→t2 ingest transaction | REVOKED receipt·상세 row/outbox0 |
| M06 | t0 ingest commit→t1 revoke commit→t2 decrypt read | 현재 grant판정 receipt·기존ciphertext삭제수명·복호화공개범위갱신 |
| M07 | POST timeout→late callback→reconcile→한 구독 확인 | CREATE_UNCERTAIN→known ID정산·중복정책집행0 |
| M08 | CANCEL commit→DELETE timeout→IPE restart→late callback→새 generation | old tombstone·최소audit·providercleanupreceipt·새route독립 |
| M09 | 상대 subscription href·승인범위 밖 link·과대payload | 정규화기반binding/schema receipt·고정endpoint범위 |
| F01 | 다른 participantId·oneM2M originator·dataset/task artifact | IDENTITY_SCOPE receipt·accepted update0 |
| F02 | sampleCount361·shape오류·NaN·stale base hash·중복 update | 검증reason별receipt·유효집계입력만acceptedSet에포함 |
| F03 | 선정후 update전 consent회수 | WITHDRAWN membership·update수락0 |
| F04 | update저장후 aggregation전 consent회수 | 현재consent로acceptedSet재계산·유효2개미만이면재선정 |
| F05 | model commit직후 consent회수 | 기집계manifest이력·후속참여갱신·모델review/pause/retrain receipt |
| F06 | artifact쓰기전/후·DBcommit전/후·publication전/후 restart | COMMITTED모델hash/acceptedSet보존·publication멱등·nextRound일치 |
| F07 | coordinator2개동시commit·기집계update재전달 | currentepoch1개commit·동일roundreceipt·model pointer단일승격 |
| F08 | latejoin/이탈·partialdownload·orphanstaging | 적격선정/재개/digest·48hGC receipt |
| F09 | 동일seed/split/acceptedSet재실행 | modelhash 또는1e-6수치차·동일평가조건확인 |
| F10 | prepared artifact뒤consent변경→집계commit시도 | updateSetHash/revision CAS→REBUILD_REQUIRED→새acceptedSet재계산→새manifest commit |
| F11 | modelDBcommit→consent회수/SERVING_PAUSED→지연publication | servingGeneration/currentstate검사→SUPERSEDED outbox·승인된새model만승격 |

기존 단위 시험의 D/M/F 명칭 참조와 실제 해당 경합·시계·물리 실행 측정은 개별 fixture receipt로 판정한다. D 계열은 PostgreSQL claim/dispatch·실물 정산, M 계열은 MEC binding/time/lifecycle, F 계열은 실제 tensor·consent CAS·serving fence까지 연결한다.

## 완료 자료 7종

| ID | 자료 | 현재 근거 및 최종 연결 |
|---|---|---|
| C01 | 인터페이스 계약(JSON Schema/OpenAPI/oneM2M resource) | 계약 JSON·XSD 확보. 사용자 OpenAPI·MCP tool schema·배포 MEC Swagger lineage 보강 |
| C02 | 구현 코드와 configuration | 제품 코드 확보. MEC/FL/MCP/handover/정책 DB 추가 범위를 각 항목에 명시 |
| C03 | 단위·통합·장애 시험 | 소프트웨어 검증 PASS 기록. A01~A26·D01~D09·M01~M09·F01~F11 전체 수용 실행 |
| C04 | 기대 결과와 실제 결과 | 로그·demo 결과 확보. 각 수용 조건의 actual/expected와 물리 측정 수치 연결 |
| C05 | 담당자·검토자·gate ID | 설계 역할과 gate owner 확보. 실제 performer/reviewer 서명·검토 receipt 수집 |
| C06 | 로그·receipt·artifact hash | software·firmware·과거 격리 broker/CSE hash 확보. 최종 환경별 hash 연결 |
| C07 | release manifest와 문서 연결 | manifest·문서 확보. 현재 commit freeze·A01~A26·공개 URL·재현 결과 연결 |

## 지정 실행 명령 및 검증 기록

기존 통합 verify: `2026-11-10T08:15:44.760Z`, `PASS`. 기록된 로그 11개 중 SHA-256 일치 11개. 이 결과의 범위는 소프트웨어 단위·로컬 mTLS·dry-run·모의 통합·replay·웹 빌드다.

| 디렉터리 | 명령 | 확인 범위 | 기록 상태 |
|---|---|---|---|
| `pc-mobius` | `npm run integration:validate` | 계약 구조·mapping 검증 | 기록된 PASS |
| `pc-mobius` | `npm test` | Node 단위/로컬 통합 검증 | 기록된 PASS |
| `pc-mobius` | `npm run integration` | 로컬 모의 adapter 통합 시나리오 | 기록된 PASS |
| `pc-mobius` | `npm run integration:evidence` | manifest·artifact SHA-256 생성 | 별도 manifest/실행 receipt 대조 |
| `pc-mobius` | `npm run integration:replay -- --input=receipts/integration-demo.json` | 저장된 demo receipt 재현 검증 | 기록된 PASS |
| `.` | `npm run verify` | workspace 통합 검증 | 기록된 PASS |
| `pc-mobius` | `node scripts/run-contract.mjs --dry-run` | CSE wire 요청 계획 생성 | 기록된 PASS |
| `pc-mobius` | `node scripts/run-contract.mjs` | 실행 중 CSE 실제 wire receipt 수집 | 별도 manifest/실행 receipt 대조 |
| `web-dashboard` | `npm run build` | TypeScript·Vite production build | 기록된 PASS |
| `web-dashboard` | `npm run typecheck:contract` | 웹 계약 타입 검사 | 기록된 PASS |

과거 `keyring/evidence/2026-10-30-real-cse`, `mqtt-wire`, `outbox-cse`는 실제 격리 broker/CSE/PostgreSQL 저장·중복·재시작 시험 근거다. 이 범위와 현재 정책 API의 JSON 정본, Pi/키링 실물 경로를 각각 추적했다. 기존 receipt에 명시된 파일·로그 179개 모두 SHA-256이 일치한다. 검사 결과는 JSON `archivedLocalEvidence`에 기록했다.

## 구현 우선순위

- APP, WEB: 사용자/운영 화면·사용자 API·가구/기기 등록·OIDC·consent/명령/알림 통합 — 이번 작업 진행 중
- MEC: 실제 service CRUD·callback trust/current grant/time/generation·reconcile 구현 — 추가 구현
- FL: 실제 FedAvg tensor·dynamic 10round·quorum·consent/publication fence·평가 — 추가 구현
- MCP: 3개 MCP wire server·승인 gate·schema·checkpoint/side effect 복구 — 추가 구현
- HANDOVER, STORE: PostgreSQL 정책 정본·두 CSE state restore·dispatch drain/fencing — 추가 구현
- GROUP, CORE, HARDWARE: 공급자/클라이언트 교체·실제 fopt·물리 ACK·전원/범위 계측 — 구현 연결·실장비 검증
- PUBLIC, EVIDENCE: 공개 URL·영상·forum·interview·새 환경 replay와 최종 release evidence — 공개 활동·팀 검토 단계

외부 실행 준비 항목: ESTIMED VM 계정, MEC endpoint·callback 연결, Edge 호스트 2개와 DB, 실물 키링/Pi/계측 장비, 팀 검토자와 공개 게시/촬영/면접 활동. 각 외부 증거 항목과 로컬 구현 항목은 A01–A26 표에서 개별 연결했다.
