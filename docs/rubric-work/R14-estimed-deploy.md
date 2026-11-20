# R14 원격 VM 배포 절차 (ESTIMED VM, MEC 샌드박스 VM)

coordinator와 worker는 설정 파일 하나(CSE URL, 자격 증명 경로, worker ID)로 원격 호스트에서 실행됨. 이 문서는 실행 절차이며, 원격 VM 실행 기록은 다음 실행에서 만들 항목임. 현재 receipt는 로컬 호스트 실행(`LOCAL_HOST_REAL_CSE_MULTIPROCESS`)임.

## 배치 선택

| 선택 | coordinator | worker | CSE | runtimeMode 표기 |
|---|---|---|---|---|
| A | VM | 연구실 PC 프로세스 | 연구실 PC Mobius4 | `SANDBOX_VM_REAL_CSE` 또는 `ESTIMED_VM_REAL_CSE` |
| B | 연구실 PC | VM 1대 이상 | 연구실 PC Mobius4 | 같은 규칙 |
| C | VM | VM | VM Mobius4 | 같은 규칙 |

- 팀원이 준비 중인 Ubuntu 22.04 VM(192.168.0.103)은 MEC 샌드박스 VM이므로 `SANDBOX_VM_REAL_CSE`로 표기함.
- `ESTIMED_VM_REAL_CSE` 표기에는 ESTIMED 계정, 할당 ticket, VM 식별 정보(호스트 이름 hash, 이미지 또는 커널 정보)가 함께 필요함.

## 1. 신원 발급 (운영자 PC)

```
node pc-mobius/scripts/fl-onem2m-provision.mjs --out=.local/fl-deploy --cse-url=https://<CSE_HOST>:<PORT> \
  --task=privacy-motion --workers=w1,w2,w3 --fl-ae=fl-privacy-motion --run-tag=<짧은태그>
```

- LAN에서 HTTP로만 열린 CSE에 붙이는 경우 `--allow-plain-http`를 더하고 receipt의 transport에 http로 기록함. TLS 종단(reverse proxy) 사용이 권장 경로임.
- 결과 파일: `operator.private.json`(운영자 PC 보관), `coordinator.credentials.json`, `coordinator.config.json`, `<id>.credentials.json`, `<id>.config.json`.
- 각 파일은 mode 0600으로 만들어짐. 자격 증명은 `.local/` 또는 VM의 `/etc/bubble-fl/`에만 둠.

## 2. VM 준비 (Ubuntu 22.04)

```
sudo apt-get update && sudo apt-get install -y git curl chrony
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v                      # v22 이상 확인
timedatectl status           # System clock synchronized: yes 확인 (heartbeat TTL 판정에 필요)
sudo useradd --system --home /opt/bubble_lock --shell /usr/sbin/nologin bubblefl
sudo git clone <저장소 URL> /opt/bubble_lock
sudo git -C /opt/bubble_lock checkout <release commit SHA>
sudo install -d -m 0750 -o root -g bubblefl /etc/bubble-fl
sudo install -d -m 0750 -o bubblefl -g bubblefl /var/lib/bubble-fl
```

- coordinator, worker, readback 스크립트는 Node 내장 모듈만 사용하므로 Node 22 런타임과 저장소 checkout만으로 실행됨.
- 자격 증명 복사: `scp .local/fl-deploy/coordinator.* <vm>:/tmp/` 후 `sudo install -m 0640 -o root -g bubblefl /tmp/coordinator.* /etc/bubble-fl/`, 복사 후 `/tmp` 사본 삭제.

## 3. 설정

`/etc/bubble-fl/coordinator.config.json` 핵심 필드:

```
{
  "cseUrl": "https://<CSE_HOST>:<PORT>",
  "cseBase": "/Mobius",
  "credentialsPath": "./coordinator.credentials.json",
  "flAeName": "fl-privacy-motion",
  "allowPlainHttp": false,
  "pollMs": 250,
  "task": { "taskId": "privacy-motion", "targetRounds": 12, "maxParticipants": 3, "minUpdates": 2, "roundDeadlineMs": 15000, "heartbeatTtlMs": 10000 },
  "notify": { "listenHost": "0.0.0.0", "listenPort": 9711, "publicUrl": "http://<VM_IP>:9711/fl-coordinator" }
}
```

- CSE가 VM의 notify 포트로 접근할 수 있을 때만 `notify`를 둠. 접근 경로가 막힌 망에서는 `"notify": null`로 두고 polling만 사용함.
- notify 포트는 CSE 호스트에만 엶: `sudo ufw allow from <CSE_IP> to any port 9711 proto tcp`.
- 원격 망 지연을 고려하여 `roundDeadlineMs`는 15000, `heartbeatTtlMs`는 10000부터 시작함.
- 사설 CA의 HTTPS CSE에는 `NODE_EXTRA_CA_CERTS=/etc/bubble-fl/ca.pem`을 설정함.

`/etc/bubble-fl/w1.config.json` 핵심 필드:

```
{
  "cseUrl": "https://<CSE_HOST>:<PORT>",
  "credentialsPath": "./w1.credentials.json",
  "workerId": "w1",
  "taskId": "privacy-motion",
  "flAeName": null,
  "heartbeatMs": 2000,
  "dataset": { "source": "jsonl", "path": "/var/lib/bubble-fl/w1/w1.local.jsonl", "datasetId": "w1-local" }
}
```

- `flAeName: null`이면 label discovery(`fl-plane:task:<taskId>`)로 FL AE를 찾고 coordinator 서명으로 작업 정의를 확인함.
- jsonl 한 줄 형식은 `{"x":[8개 실수],"y":0|1|2}`이며 100행 이상이 필요함. 이 파일은 VM 안에만 둠.
- 합성 shard로 시험할 때는 `"dataset": {"source":"synthetic-shard","seed":<비공개 정수>,"profile":"commute","datasetId":"w1-local"}`를 씀.

### 서버 CSE mTLS 설정 키 (2026-11-20 실행에서 사용한 값)

| 키 | coordinator (PC) | worker (VM) |
|---|---|---|
| `cseUrl`, `cseBase` | `https://<SERVER_DOMAIN>:8443/onem2m`, `/Mobius` | 같음 |
| `caFile` | `.local-fl-certs/fl-coord/trust-bundle.pem` | `~/bubblelock-nocert/repo/.local/deployment/fl/fl-wN/trust-bundle.pem` |
| `clientCertFile`, `clientKeyFile` | `fl-coord.pem`, `fl-coord.key` | `fl-wN.pem`, `fl-wN.key` (VM 안에서 그대로 읽음) |
| `servername`, `connectHost` | `<SERVER_DOMAIN>`, `192.168.0.103` | `<SERVER_DOMAIN>`, `127.0.0.1` |
| `flAeName` | `fl-privacy-motion` | `fl-privacy-motion` (worker는 FL AE 이름을 직접 사용함) |
| 기타 | `pollMs` 500, `inboxPollMs` 2000, `timeoutMs` 8000, `notify` null, task `targetRounds` 6, `roundDeadlineMs` 15000, `heartbeatTtlMs` 10000 | `pollMs` 1000, `heartbeatMs` 2000, `trainDelayMs` 3000, `exitOnTaskComplete` false, `standbyPollMs` 30000 |

- 신원 발급: `fl-onem2m-provision.mjs --coordinator-ae-id=Cpb-fl-coord --worker-ae-id-prefix=Cpb-fl-`로 enrollment의 AE-ID를 nginx가 고정하는 originator와 맞춤.
- worker 기동: `systemd-run --unit=bubble-fl-worker-wN --uid=mec -p Restart=on-failure`로 transient 단위를 띄움. `systemctl stop`을 받은 worker는 학습 중인 라운드를 update 쓰기 전에 종료함.
- 실행: `node pc-mobius/scripts/run-fl-onem2m-server-cse.mjs --deploy=<배포 디렉터리>`.

## 4. systemd 단위

`/etc/systemd/system/bubble-fl-coordinator.service`:

```
[Unit]
Description=Privacy Bubble FL coordinator (oneM2M coordination plane)
After=network-online.target time-sync.target
Wants=network-online.target

[Service]
Type=simple
User=bubblefl
Group=bubblefl
WorkingDirectory=/opt/bubble_lock
ExecStart=/usr/bin/node pc-mobius/scripts/run-fl-onem2m-coordinator.mjs --config=/etc/bubble-fl/coordinator.config.json
Restart=on-failure
RestartSec=3
Environment=NODE_EXTRA_CA_CERTS=/etc/bubble-fl/ca.pem
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadOnlyPaths=/opt/bubble_lock /etc/bubble-fl

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/bubble-fl-worker@.service`:

```
[Unit]
Description=Privacy Bubble FL worker %i (oneM2M coordination plane)
After=network-online.target time-sync.target
Wants=network-online.target

[Service]
Type=simple
User=bubblefl
Group=bubblefl
WorkingDirectory=/opt/bubble_lock
ExecStart=/usr/bin/node pc-mobius/scripts/run-fl-onem2m-worker.mjs --config=/etc/bubble-fl/%i.config.json
Restart=on-failure
RestartSec=5
StandardInput=null
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadOnlyPaths=/opt/bubble_lock /etc/bubble-fl /var/lib/bubble-fl/%i

[Install]
WantedBy=multi-user.target
```

```
sudo systemctl daemon-reload
sudo systemctl enable --now bubble-fl-coordinator
sudo systemctl enable --now bubble-fl-worker@w1
```

- `Restart=on-failure`의 coordinator 재기동은 CSE 상태에서 epoch를 올려 복원하는 경로와 같음.
- systemd 없이 확인할 때는 같은 `ExecStart` 명령을 셸에서 실행함.

## 5. 동의 철회

```
sudo -u bubblefl /usr/bin/node /opt/bubble_lock/pc-mobius/scripts/run-fl-onem2m-worker.mjs --config=/etc/bubble-fl/w1.config.json --revoke
sudo systemctl disable --now bubble-fl-worker@w1
```

- 재동의 이후 다시 철회할 때는 worker 설정에 현재 `consentRevision`을 적음.

## 6. 실행 확인과 receipt

```
journalctl -u bubble-fl-coordinator -o cat | grep -E '"event":"(BOOTSTRAPPED|RESUMED|ROUND_OPENED|ROUND_COMPLETED|TASK_COMPLETED)"'
journalctl -u bubble-fl-worker@w1 -o cat | grep -E '"event":"(REGISTERED|ADMISSION_OBSERVED|UPDATE_WRITTEN)"'
node pc-mobius/scripts/fl-onem2m-readback.mjs --config=/etc/bubble-fl/coordinator.config.json \
  --out=docs/verification-evidence/<YYYY-MM-DD>/fl-onem2m-sandbox-vm.json \
  --runtime-mode=SANDBOX_VM_REAL_CSE --host-label=mec-sandbox-vm-ubuntu-22.04 --hosts=2
```

- readback receipt는 CSE에서 읽은 서명, FedAvg 재계산 일치, lineage, 데이터 위치 검사를 담음.
- 실행 위치 표기는 운영자가 넘긴 `--runtime-mode`, `--host-label`, `--hosts` 값으로 기록되므로, 함께 남길 항목: VM 호스트 이름 sha256, `uname -srm`, `node -v`, 저장소 commit SHA, `systemctl status` 요약, journald 발췌.
- coordinator 재시작 검증: 라운드가 열린 상태에서 `sudo systemctl kill -s SIGKILL bubble-fl-coordinator`, 자동 재기동 뒤 receipt의 `epochs`에 epoch 2가 기록됨.
- worker 탈락 검증: 선정 라운드 중 `sudo systemctl kill -s SIGKILL bubble-fl-worker@w2`, 해당 라운드 result의 `missing`과 다음 라운드 `HEARTBEAT_STALE` 제외가 기록됨.

## 7. 정리

```
sudo systemctl disable --now bubble-fl-coordinator 'bubble-fl-worker@*'
sudo shred -u /etc/bubble-fl/*.credentials.json
```

- CSE의 FL AE 삭제는 coordinator 자격 증명으로 `DELETE /Mobius/<flAe>`와 `DELETE /Mobius/acp-<flAe>` 순서로 수행함.
