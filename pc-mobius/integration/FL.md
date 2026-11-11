# 수치 FL·배포 worker·oneM2M 게시

`FlCoordinator`는 float32 softmax `W[8,3]`, `b[3]` 모델을 108바이트 little-endian 형식으로 저장한다. client의 SGD 결과를 sample 수로 가중 평균하고 실제 모델 바이트·불변 manifest의 SHA-256을 기록한다.

```powershell
cd pc-mobius
node --test test/fl-coordinator.test.mjs
npm run fl:verify
```

검증 runner는 seed 101/202/303 각각 10 round를 실행한다. client 데이터는 600개 합성 행의 고정 60/20/20 시간 블록 분할이다. round3에서 네 번째 client가 참여하고 round5에서 한 VM이 이탈한다. round5 뒤 새 store/coordinator가 상태 파일을 열어 다음 round를 이어간다. 동일 test split에서 FL과 같은 참여 횟수·epoch budget의 local-only 모델을 비교한다. 결과는 `.local/fl-verification/<run>/report.json`, `.f32`, manifest, 상태 파일에 저장된다.

원본 행은 participant 로컬 생성기와 학습 함수에서 처리한다. coordinator는 synthetic metadata, sample ID digest·학습 receipt, 서명된 모델 update를 검증한다. update는 principal/originator→participant/task/dataset binding, Ed25519 서명, 모델 digest·shape·finite, 현재 consent, base model/epoch를 통과한다. 동일 update 재시도는 기존 receipt로 정산하며 participant별 한 update로 quorum을 계산한다.

집계 준비 이후 consent revision이 바뀌면 `REBUILD_REQUIRED`로 전환한다. model commit 뒤 동의 회수는 `SERVING_PAUSED`와 새 serving generation을 기록한다. 지연 publication은 `SUPERSEDED`로 정산하며 모델 조회도 현재 lineage consent를 검사한다. 관리자 retrain 승인 뒤 초기 승인 checkpoint에서 새 참여자 집합으로 학습한다. 공유 PostgreSQL에서는 행 잠금·version CAS·유일 commit·model generation·publication outbox를 같은 transaction으로 저장한다. 배포·복구·실제 두 프로세스 경합 시험은 [PostgreSQL 운영 문서](POSTGRES.md)에 연결되어 있다.

## 배포 worker

`LOCAL_SIMULATION`은 로컬 합성 수치 학습 환경이다. `ESTIMED`는 할당된 VM의 HTTPS endpoint·hostId·실제 processId·imageDigest를 등록하는 배포 모드다. [worker 설정 예시](../config/fl-worker.example.json)를 `.local/`에 복사하고 다음 값을 구성한다.

- `tls`: worker 서버 인증서·개인키·coordinator 인증서의 신뢰 CA 경로
- `coordinatorEndpoint`, `upstreamTls`: 중앙 API HTTPS endpoint와 등록된 participant 인증서. participant별 `upstreamTls`로 개별 신원을 연결한다.
- `coordinators`: SHA-256 인증서 fingerprint와 허용 task/participant 목록
- `participants`: 등록된 Ed25519 개인키 파일과 공개 dataset metadata
- `runtimeMode`, `hostId`, `host`, `publicHost`, `statePath`: 배포 모드·할당 host·bind 주소·공개 주소·영속 상태 경로

설정의 파일 경로는 설정 파일 디렉터리를 기준으로 해석한다. worker는 실행 파일과 학습 소스의 SHA-256 및 실제 PID를 readiness JSON에 출력한다. 배포 이미지는 이 소스 digest와 배포 시스템 image digest를 함께 receipt에 기록한다.

```powershell
npm run fl:worker -- --config=../.local/fl/worker.json
```

`GET /v1/fl/health`와 `POST /v1/fl/train`은 TLS1.3과 등록 coordinator 인증서를 요구한다. worker는 학습 전후 participant 인증서로 중앙 `/v1/fl/participant-state`를 조회한다. task·round·epoch·base model hash/version·feature schema·dataset·현재 consent revision을 중앙 정본과 비교한다. 서명 update는 task/round/participant/epoch 및 intent hash로 영속 저장되며 worker 재시작 뒤 같은 요청에 같은 결과를 반환한다.

`EstimedVmAdapter`는 건강 상태의 host/process/image/runtimeMode를 고정 등록값과 비교하고 모델·round 계약을 HTTPS로 전송한다. `createMtlsFetch`에 배포 CA·coordinator client 인증서를 주입한다. 로컬 검증은 별도 worker 프로세스 두 번의 실행, 실제 중앙 mTLS API 조회, 14개 통신·신원·복구·학습·동의 시나리오를 수행한다.

```powershell
cd ..
python -m unittest discover -s tests/integration -p test_fl_worker.py -v
```

결과는 `.local/fl-worker-verification/<run>/report.json`이다. `npm run verify`의 실제 TLS 교차시험에도 포함된다. ESTIMED 계정·할당 ticket·외부 VM 배포 receipt는 G-CONT 증거로 연결한다.

## oneM2M 모델 게시

`FlOneM2mPublisher`는 실제 oneM2M R4 HTTP 요청으로 전용 AE, participant/dataset metadata, task/status·round/update metadata, model result, currentModel을 생성한다. 모델 CIN에는 108바이트 base64 artifact와 manifest가 함께 들어간다. 전용 ACP는 coordinator originator에 권한을 부여한다. 사용자의 모델 조회는 중앙 `/v1/fl/artifacts`의 현재 consent/lineage 검사를 거친다. CSE `currentModel`은 게시 당시의 generation 기록이다.

런타임은 `createIntegrationRuntime({ core: { fl: { mode: 'ESTIMED', publication: { endpoint, originator, cseBase: '/Mobius', aeName: 'privacy-bubble-fl' } } } })` 또는 API JSON 설정의 `core.fl.publication`을 사용한다. 외부 CSE에는 HTTPS를 설정하며 client 인증서는 주입한 `fetchImpl`로 연결한다. oneM2M 요청 식별자, model/manifest hash와 실제 바이트 readback을 검증한다. 동일 CIN 재시도는 내용을 비교하며 이전 serving generation의 게시 요청은 현재 generation 경계에서 정산한다.

```powershell
cd pc-mobius
npm run fl:cse -- --config=../.local/cse/fl.json
```

설정 파일에는 `endpoint`, `originator`, `cseBase`를 담는다. CSE 배열 설정은 첫 항목을 사용한다. runner는 독립 AE에 게시하고 재조회·task/round/update metadata·재시도·변조·generation·동의 회수 7개 시험을 실행한다. 실제 Mobius4 v4.24.5 + PostgreSQL/PostGIS 실행 결과는 `.local/fl-cse-verification/<run>/report.json`에 저장된다.

API VM 등록은 `fl:admin`, 참여자·동의·update·participant-state는 `fl:write`, 모델 조회는 `fl:read` scope를 사용한다. `POST /v1/fl/participants`, `/consents`, `/heartbeat`, `/rounds`, `/updates`, `/finalize`, `/reselect`와 관리자 `/vms`, `/recover`, `/publish`, `/retrain` 경로를 제공한다. F01–F11 및 A13–A15는 [수치 FL 계약](../contracts/fl-numeric.v1.json)에 연결되어 있다.
