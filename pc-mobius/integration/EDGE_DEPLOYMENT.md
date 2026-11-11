# Edge application 배치

W09/W10의 호스트 적격성·프로세스 배치·복구를 `EdgeSupervisor`와 `EdgeDeploymentClient`로 실행한다. 각 호스트의 agent는 TLS 1.3 클라이언트 인증서 지문과 application 허용 목록을 확인한다. 실행 파일·인자·환경·작업 폴더·health 주소는 호스트 관리자가 등록한 catalog에서 결정한다.

## 실행

1. `config/edge-agent.example.json`을 호스트의 `.local` 또는 `/etc/bubble-lock`에 복사한다. 절대 경로와 인증서 지문을 채운다.
2. 고정한 release의 실행 파일과 의존 소스·lockfile을 `applications[].artifacts`에 등록한다. 각 항목은 이식 가능한 `name`, 로컬 절대 `path`, `sha256`으로 구성한다. agent가 시작 직전에 파일 해시를 대조한다. `imageDigest`는 이름순으로 정렬한 `{name,sha256}` 배열의 canonical SHA-256이다.
3. application 설정에는 개별 `statePath`·`receiptPath` 또는 공유 PostgreSQL namespace를 지정한다. 중앙 policy 정본은 같은 DB와 MEC 암호화 키로 연결한다.
4. `node pc-mobius/scripts/run-edge-agent.mjs /etc/bubble-lock/edge-agent.json`으로 실행한다. host별 supervisor와 statePath는 한 프로세스가 소유한다.

중앙 API의 `core.handover.edges[]`에는 기존 CSE 설정과 다음 deployment 설정을 함께 둔다.

```json
{
  "edgeId": "edge-A",
  "region": "seoul",
  "endpoint": "https://edge-a.example:7579",
  "cseBase": "/Mobius",
  "cseId": "/edge-a",
  "originator": "<provisioned CSE originator>",
  "deployment": {
    "endpoint": "https://edge-a.example:9443",
    "hostId": "edge-A",
    "appId": "integration-api",
    "version": "1.0.0",
    "imageDigest": "<registered catalog imageDigest>",
    "tls": {"ca": "/etc/bubble-lock/ca.pem", "cert": "/etc/bubble-lock/controller.pem", "key": "/etc/bubble-lock/controller.key"}
  }
}
```

`run-integration-api.mjs`가 deployment TLS 자료를 읽어 mTLS transport를 주입한다. UE manifest의 `region`, `zone`, `capabilities`를 host inventory와 대조한다. 대상 Edge를 생략하면 `selectEligibleEdge`가 현재 inventory를 갱신하고 적격한 호스트를 선택한다.

## 상태와 전환

`GET /v1/edge/inventory`는 hostId·region·zone·capacity·application digest와 실행 프로세스 상태를 제공한다. `POST /v1/edge/deploy`는 고정 catalog의 `appId/version/imageDigest`, `ueId/epoch/operationId`를 받는다. health에는 agent가 발급한 instanceId·실제 PID·imageDigest·hostId가 함께 있어야 READY가 된다.

handover는 PREPARE에서 target process readiness와 현재 grant를 확인하고 CSE 자원 복원을 시작한다. cutover·readback·구독 확인을 마친 후 `POST /v1/edge/release`로 source UE lease를 해제한다. 같은 application을 사용하는 다른 UE lease는 계속 유지하며 마지막 lease 해제 시 검증된 source PID를 종료한다. epoch가 지난 release는 현재 실행을 보호한다.

agent 재시작은 저장한 instanceId와 health를 대조하여 기존 프로세스를 채택한다. 실행 중 프로세스의 신원 확인이 필요한 상태는 `RECOVERY_REQUIRED`로 기록하고 관리자가 해당 instance의 상태를 확인한다. 새 프로세스의 시작 실패는 실행한 child를 정리하고 `EDGE_DEPLOYMENT_ROLLED_BACK` receipt를 남긴다.

## 검증

`python -m unittest discover -s tests/integration -p test_edge_deployment.py -v`는 임시 PKI, 두 TLS agent, 실제 Node 통합 API 프로세스로 15개 항목을 실행한다. host·zone·capability, 인증서, 실제 PID health, 동일 요청, supervisor 복구, 두 번째 배치, epoch release, artifact 변조, 시작 실패 rollback을 검증한다. `test/handover-http.test.mjs`는 배치→current grant→CSE 복원→source release의 순서와 회수 경합을 검증한다.

검증 범위는 한 물리 호스트의 두 agent와 실제 프로세스다. 외부 Edge A/B·Cloud IN-CSE·PostgreSQL 및 ESTIMED VM 배치는 [외부 실증 TODO](../../docs/external-validation-todo.md)의 항목으로 관리한다.
