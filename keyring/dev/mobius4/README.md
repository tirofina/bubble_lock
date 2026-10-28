# KEYRING 임시 Mobius4 환경

DOC-REV 2.0.0 · 팀 CORE 기준 commit `91a281b` · upstream은 [IoTKETI/mobius4](https://github.com/IoTKETI/mobius4) commit `e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8`에 고정했다. 실제 CSE 소스는 저장소에 복제하지 않고 외부 `MOBIUS4_ROOT` 경로로 연결한다.

2026-10-28: 사용자의 Docker 재실행 이후 로컬 CA/client certificate와 서버 이미지를 생성하고 컨테이너 4개를 기동했다. 최초 AE 생성은 varchar(30) 식별자 제한으로 실패했고 임시 관리자 ID를 25자로 수정했다. 이 상태는 서버 provisioning이며 Gateway·실물/E2E 검증 evidence가 아니다.

Mobius4는 초기 관리자 ID를 DB에 고정하므로 기존 dev DB를 migration하거나 삭제하지 않고 새 `pgdata_v2`/`identity_v2` volume으로 생성했다. 최초 `pgdata`/`identity` volume과 이전 local env는 보존되어 있다. 이후 관리자 ID 변경이나 volume 삭제를 일반 재시작 절차로 사용하지 않는다.

## 구성

Compose project `privacy-bubble-keyring-dev`는 별도 PostGIS DB·Mosquitto·Mobius4·TLS proxy를 사용한다. DB와 plaintext HTTP/MQTT는 Compose 내부 전용이다. 호스트에는 `https://localhost:8759`와 mTLS MQTT `localhost:8883`만 127.0.0.1에 bind한다. 실제 Pi에서 접근하려면 별도의 팀 네트워크·DNS·인증서 SAN·방화벽·bind 정책을 먼저 정해야 한다. 현재 상태를 Pi 통합 완료로 표시하지 않는다.

TLS 1.3과 임시 CA/client certificate를 생성한다. dev client의 CN은 `keyring-dev-gateway`다. 해당 인증서만 proxy를 사용하며 proxy의 관리자 originator 매핑은 이 격리된 개발 CSE만을 위한 것이다. 운영 환경에서는 등록된 AE와 ACP에 바인딩해야 한다. CA 개인키와 client 개인키는 서버·브로커에 mount하지 않는다.

## 최초 생성

Docker Desktop Linux engine이 정상 동작한 뒤 PowerShell 7에서 수행한다. 다음 명령은 실제 dependency image 다운로드·로컬 인증서 생성·서버 image build/start를 수행하는 provisioning이며, 하드웨어 시험을 실행하지 않는다.

```powershell
cd "C:\Users\NH\Documents\ChatGPT\mobius 해커톤\github_upload\bubble_lock"
./keyring/dev/mobius4/prepare.ps1 -Mobius4Root "C:\Users\NH\Documents\ChatGPT\mobius 해커톤\github_upload\_local\mobius4" -Start
```

준비 후 재시작은 `./keyring/dev/mobius4/start.ps1`다. 로컬 `.local/compose.env`, `.local/mqtt.acl`, `.local/tls/`는 Git과 Docker build context에서 제외된다. 기존 설정/키가 있으면 prepare는 덮어쓰지 않는다. 중간 실패 시 기존 상태를 보존하고 필요한 부분만 명시적으로 복구해야 한다. 일반 종료는 다음 명령을 사용하며 volume 삭제 옵션은 추가하지 않는다.

```powershell
docker compose --env-file ./keyring/dev/mobius4/.local/compose.env -f ./keyring/dev/mobius4/compose.yaml down
```

## Gateway 설정

빈 AE·관측/receipt/health container·초기 binarySwitch 자원 생성은 저장소 루트에서 `node ./keyring/dev/mobius4/bootstrap.mjs`로 수행한다. 요청은 직렬 7초 간격이며 기존 자원은 덮어쓰지 않는다. 초기 binarySwitch의 false는 dev-bootstrap/unobserved 표시가 있는 초기값이며 실물 관측이 아니다. 실제 설치 receipt는 `.local/resource-provisioning.json`에 남는다. 장치 명령·가짜 센서 이벤트는 생성하지 않는다.

- `M2M_CSE_URL=https://localhost:8759`, `M2M_CSE_ID=Mobius4`, `M2M_RVI=4`.
- `TLS_CA_FILE`, `TLS_CERT_FILE`, `TLS_KEY_FILE`에는 생성된 ca.pem/client.pem/client.key의 절대 경로를 지정한다. Gateway Linux 환경에서의 경로를 사용하며 Windows 경로를 Pi에 복사하지 않는다.
- `M2M_ORIGINATOR`는 local compose.env의 CSE_ADMIN과 동일한 값을 로컬 설정에만 사용한다. 이 값은 임시 관리자 credential이므로 출력·공개하지 않는다.
- `MQTT_HOST=localhost`, `MQTT_PORT=8883`, `CORE_BRIDGE_ENABLED=true`, `GATEWAY_ID=pi-keyring-local`은 현재 dev ACL 조합이다. 다른 ID는 ACL과 함께 교체한다.
- `BLE_GATT_PROFILE=core-v1`이며 identity extension과 BLE payload 변환은 [CORE 연동 메모](../../CORE_INTEGRATION.md)에 설명했다.

`/api/`는 항상 503/allowed=false다. INTEGRATION 서버가 없는 상태에서 임의 승인이나 가짜 명령을 제공하지 않는다. 실제 `PC_API_URL`과 credential/authorize API를 연결하기 전에는 Gateway 명령 실행이 차단된다.

관측/receipt/health container와 binarySwitch 자원은 CORE owner가 준비해야 한다. 포함한 specialization registry는 `pb:binarySwitch`를 위한 로컬 설정이며 팀의 공통 파일을 변경하지 않는다. CORE 제공 하니스의 `create-state`는 현재 ty=4로 기록돼 있어 flexContainer ty=28과 불일치한다. 이 차이는 [인수 메모](../../CORE_INTEGRATION.md)에 기록했고 팀 원본은 보존했다.

나중에 실제 Mobius 서버로 바꿀 때는 `M2M_CSE_URL`/RVI/Originator/container/CA·credential과 `PC_API_URL`을 교체한다. dev CA·관리자 매핑·local DB를 운영 환경에 이관하지 않는다.
