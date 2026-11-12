# MEC·Edge·ESTIMED 실행과 로컬 리허설

담당: PC-MOBIUS-INTEGRATION. 기준: DOC-REV 2.0.0, 브리프 4·5·6, R12–R16, G-MEC/G-CONT.
이번 실행 대상은 데스크탑 WSL이다. 배포 대상 노트북의 원격 배포와 SSH 작업은 수행하지 않는다.

## 이번 실행

저장소 루트에서 실행한다. 의존성은 준비된 환경을 사용한다.

```sh
node pc-mobius/scripts/run-external-rehearsal.mjs --output=docs/final-evidence/external
```

기존 `run-mec-verification.mjs`가 호출하는 MEC HTTP·trigger·OpenAPI 시험, `handover-http.test.mjs`, `fl-coordinator.test.mjs`, `run-fl-verification.mjs`를 재사용한다. 기존 runner의 고정 receipt를 덮어쓰지 않고 새 증거 폴더에 TAP·명령·종료 코드·SHA-256을 모은다. 신규 설정 실행기는 같은 도메인 구현을 사용하며 별도 모의 시험으로 연결을 검증한다.

`summary.json`이 전체 결과와 정리 receipt다. `mec-M01-M09.log`, `handover-faults.log`, `fl-faults.log`, `configured-runners.log`, `fl-numeric.log`가 원본 실행 로그다. `fl-report.json`, seed별 `.f32`와 manifest는 합성 데이터 결과다. 외부 호스트·실장비의 성능으로 해석하지 않는다. 루트 setup 및 verify 13단계 PASS는 상위 실행 결과를 재사용한다.

runner는 `RUN_TMP` 또는 `.local/external-rehearsal/tmp` 아래 고유 디렉터리를 만들고 TMPDIR/TMP/TEMP/XDG_CACHE_HOME/PYTHONPYCACHEPREFIX를 그 안으로 한정한다. 자식 프로세스 종료 후 해당 디렉터리만 제거한다. 시험용 암호 키·상태 JSON은 공유 증거로 복사하지 않는다.

## 외부 설정 준비

```sh
mkdir -p .local/external
cp pc-mobius/config/external/mec.example.json .local/external/mec.json
cp pc-mobius/config/external/edge.example.json .local/external/edge.json
cp pc-mobius/config/external/fl.example.json .local/external/fl.json
node pc-mobius/scripts/run-external-services.mjs --config=.local/external/mec.json --scenario=mec --check
node pc-mobius/scripts/run-external-services.mjs --config=.local/external/edge.json --scenario=edge --check
node pc-mobius/scripts/run-external-services.mjs --config=.local/external/fl.json --scenario=fl --check
```

`${VARIABLE}`는 실행 환경에서 읽는다. 누락 시 `ENV_REQUIRED`로 종료한다. `--check`는 설정·파일·OpenAPI hash/operationId를 검사하고 네트워크 요청을 보내지 않는다. 인증서 체인·계정 권한·접근성은 실제 실행에서 검증한다. 예제는 실제 값을 포함하지 않으며 그대로 실행하면 실패하는 것이 정상이다. 모든 TLS·OpenAPI·공개키 상대 경로는 설정 JSON 디렉터리 기준이다.

실제 실행 명령은 위 명령에서 `--check`를 뺀 것이다. 이 작업에서는 실행하지 않았다. 결과는 기본 `.local/external-runs/<run>/report.json`에 저장한다. `--output=.local/external-runs/<고유 run>`으로 위치를 지정할 수 있다. state·receipt에는 운영 식별자가 포함되므로 공유 문서 경로를 지정하지 않는다. 기존 서버의 `BUBBLE_DATABASE_URL`을 묵시적으로 사용하지 않으며 필요하면 설정의 `database`를 명시한다. 동시에 실행하는 시나리오는 callback 포트와 결과 디렉터리를 각각 배정한다.

## MEC Sandbox

필요 값은 플랫폼 discovery 주소, Location/RNIS 주소와 접근 token, 두 공급자의 callback 클라이언트 인증서 fingerprint, callback 공개 HTTPS 주소, 승인 UE ID, 실제 영역, 32바이트 base64 MEC 암호 키다. `PKI_DIR`에는 중앙 서버·controller 인증서와 신뢰 CA를 둔다.

공급자가 준 OpenAPI JSON을 `location-openapi.json`, `rnis-openapi.json`으로 설정 옆에 둔다. SHA-256, callback JSON Pointer, query/create/read/update/delete/list operationId를 환경변수로 연결한다. 지원하지 않는 list/update는 해당 capability와 operationId를 함께 제거한다. 전체 inventory가 확인되기 전에는 `listComplete=false`를 유지한다.

runner는 승인 consent/grant/policy를 만들고 두 서비스의 discovery·query·구독 POST/GET/PUT, 등록 공급자의 실제 mTLS callback, DELETE를 수행한다. callback은 지정한 UE·정책의 승인된 이벤트여야 한다. 최대 120초 대기 후 실패를 기록하며 생성한 구독 삭제와 grant 회수를 시도한다. 공급자가 이벤트를 발생시킬 UE 시뮬레이터도 켜 두어야 한다. `MEC_CLEANUP_PENDING`이면 같은 출력의 state·receipt에서 남은 구독 정산을 확인한다.

| 로컬 시험 | 기대 판정 |
|---|---|
| M01 | 서비스·UE·공급자·opaque route 결합 |
| M02 | 과거 세대·만료·회수 거부 |
| M03 | 동시 중복 수신의 단일 저장·outbox |
| M04 | 역전·과거·미래·시각 불명 판정 |
| M05 | 회수 commit과 callback 경합 |
| M06 | 재시작 암호문과 현재 권한 검사 |
| M07 | POST timeout·늦은 callback·구독 재조정 |
| M08 | DELETE timeout·재시작·tombstone·새 세대 |
| M09 | 상대 URL·외부 URL·과대 payload 경계 |

공급자 장애 제어 계정과 이벤트 스키마는 아직 없다. 실제 Sandbox의 M01–M09 장애 주입·UE/relay 승인 연결·callback 왕복은 외부 수용 대기다. 로컬 PASS로 이 항목을 대체하지 않는다.

## 독립 Edge A/B

각 호스트는 기존 `pc-mobius/config/edge-agent.example.json`과 `run-edge-agent.mjs`를 사용한다. 이미 등록한 release catalog의 artifact hash/imageDigest, hostId, CSE endpoint·originator·CSE ID, agent endpoint·controller mTLS를 설정한다. 두 CSE의 hostname과 두 inventory의 hostId는 각각 달라야 한다.

```sh
node pc-mobius/scripts/run-edge-agent.mjs /etc/bubble-lock/edge-agent.json
```

각 CSE에서 controller callback HTTPS 주소로 notification을 보내도록 TLS 클라이언트 인증서와 신뢰 CA를 등록한다. 해당 인증서 fingerprint와 `X-M2M-Origin`의 CSE ID를 설정에 연결한다. runner callback은 인증서·CSE ID·구독 URI를 함께 검사하고 oneM2M ACK를 반환한다.

runner는 inventory 적격성을 확인하고 ACP·binarySwitch·group·subscription을 복원한다. 합성 관측 1000개를 승인해 30회 A/B 전환하고 두 CSE의 각 관측 RI 1000개를 readback한 뒤 rollback한다. 마지막에 이 실행 UE의 lease와 grant를 해제한다. `p95Ms`는 해당 실행의 관측값이다. 외부 네트워크 partition은 자동 조작하지 않는다. partition·재시작·회수 경합은 로컬 기존 fault 시험에 증거를 둔다. 실제 독립 호스트의 장애·성능 수용은 배치 receipt와 함께 판정한다.

## ESTIMED FL

VM 세 개의 HTTPS worker endpoint·hostId·현재 processId·source imageDigest, 참여자 Ed25519 공개키, 참여자 인증서 fingerprint와 중앙 callback TLS를 설정한다. 세 초기 참여자에 더해 첫 VM의 `client-4`가 round 3에 늦게 참여하고 VM 2가 round 5부터 선정에서 빠진다. dropout 이후에도 회수·재학습 quorum을 유지하도록 예제의 네 참여자 배치를 보존한다.

worker의 READY JSON에 출력된 processId/imageDigest를 사용한다. 프로세스가 재시작하면 변경된 identity를 설정에 반영한다. 플랫폼 배포 image digest·할당 ticket은 외부 수용 증거에 별도로 연결한다. 데이터는 기존 구현 계약의 합성 mobility 데이터다.

```sh
node pc-mobius/scripts/prepare-external-fl-workers.mjs --config=.local/external/fl.json --output=.local/external/workers
node pc-mobius/scripts/run-fl-worker.mjs --config=/etc/bubble-lock/fl/vm-1.json
```

첫 명령은 VM별 기존 worker CLI 설정을 생성하고 네트워크를 호출하지 않는다. 생성한 파일을 해당 VM 설정으로 사용한다. workerSetup의 pkiRoot/keyRoot/stateRoot는 VM 내부 절대 경로다. Ed25519 개인키는 해당 참여자 worker에만 두고 coordinator에는 공개키만 둔다. coordinator client 인증서와 각 참여자의 upstream client 인증서 fingerprint를 양쪽 등록표에 맞춘다. worker의 coordinatorEndpoint는 이번 runner가 띄우는 중앙 HTTPS 서버다. worker가 READY가 된 뒤 FL 설정의 PID/digest를 갱신한다.

FL 실행기는 seed 101/202/303 각각 10 round와 동일 test split의 local-only 비교, round 5 이후 coordinator epoch 복구, round별 CSE 모델 bytes/manifest readback을 수행한다. 추가 미게시 round를 만든 뒤 동의를 회수하여 delayed publication이 SUPERSEDED가 되는지 확인하고 승인 재학습 모델을 게시한다. 초기 모델과 최종 재학습 모델을 구분한다. 실제 OS 프로세스 재시작과 mTLS worker 복구는 기존 TLS 시험이 별도 책임진다.

## 남은 외부 수용

실제 MEC/ESTIMED 계정·OpenAPI·할당 ticket·VM/CSE/agent 주소·발급 인증서와 등록 identity가 필요하다. 현재 데스크탑 WSL의 로컬 모의 실행은 완료 가능한 소프트웨어 범위다. 독립 물리 호스트 수, 실제 UE·relay, 운영 데이터, 실제 배포 image, 실측 네트워크 성능은 이번 증거에서 PASS로 표시하지 않는다.
