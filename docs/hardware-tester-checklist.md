# 실장비 최종 시험

실행자는 각 칸에 UTC 시각·장치 ID·소스 커밋·결과 파일을 기록한다. 이번 소프트웨어 통합의 로컬 모의 결과와 아래 실물 결과를 구분한다. 현장 작업 전 전체 항목은 **테스트 대기**다.

## 최신 배포본 전달

- [ ] 통합 담당자가 전달한 `feature/final-integration` 배포본과 커밋을 받는다. push 전이므로 원격 main을 최신 통합본으로 간주하지 않는다.
- [ ] PC·Pi에서 `git rev-parse HEAD`를 기록하고 같은 전달 커밋인지 대조한다.
- [ ] Pi의 기존 서비스를 중지하고 SQLite·환경 파일·인증서를 보관한다. 기존 장치 저널을 초기화하지 않는다.
- [ ] [Pi 설치](../keyring/raspberry-pi-gateway/README.md)의 서비스 계정·BlueZ·가상환경 설치 절차로 전달본을 설치한다.
- [ ] 중앙에서 발급한 CA·client 인증서·개인키를 `/etc/privacy-bubble/tls/`에 설치한다. 비밀 원문은 결과 로그·영상에 넣지 않는다.
- [ ] `gateway.env`의 실제 BLE 주소, deviceId, Gateway ID, CSE URL·container, 중앙 URL, epoch, 펌웨어 허용 revision을 중앙 등록표와 맞춘다.
- [ ] 서비스 계정으로 `bubble-gateway --env-file /etc/privacy-bubble/gateway.env --check-config`를 실행해 성공 출력을 보관한다. 이어 `--check-command-route`로 실제 등록 경로를 확인한다.
- [ ] [펌웨어 프로필](../keyring/firmware/BUILD_PROFILES.md)과 [실물 구동](../keyring/pcb/BRING_UP.md)을 읽고 보드 revision·핀·패널을 대조한다. `keyring_r18_bringup`은 명령·저널이 꺼져 있어 최종 명령 시험에 사용하지 않는다.
- [ ] 개인 provisioning을 준비한 펌웨어 디렉터리에서 `pio run -e keyring_r18`로 빌드하고, 실제 연결 포트를 확인한 뒤 `pio run -e keyring_r18 -t upload --upload-port <실제포트>`로 올린다.
- [ ] 펌웨어 파일 SHA-256과 부팅 시 firmwareRevision을 기록한다. 공개 compile 프로필의 `invalid0` passkey 바이너리는 실물에 배포하지 않는다.
- [ ] `sudo systemctl restart privacy-bubble-gateway.service` 후 `systemctl status`와 `journalctl -u privacy-bubble-gateway.service`로 실제 연결을 확인한다.

## 버튼부터 웹까지

- [ ] 보호자·방문자·운영자 실제 시험 계정으로 각각 로그인한다. 계정 ID만 기록하고 암호·토큰은 가린다.
- [ ] 키링 버튼을 한 번 누르고 BLE sequence·button counter를 기록한다.
- [ ] Pi SQLite outbox 저장, 중앙 수신, 같은 장치의 OPEN 사건·보호자 알림을 같은 상관 ID로 대조한다.
- [ ] 보호자가 동의·grant를 만들고 명령 요청을 승인한다. commandId·claimId·payload hash·grant revision·epoch·deadline을 기록한다.
- [ ] 장치 상태 변화, ACK, 별도 readback, 중앙 최종 영수증, 웹 타임라인을 대조한다. CSE 쓰기 성공만으로 장치 성공을 표시하지 않는다.
- [ ] 동일 commandId 재전달과 Pi 재시작 뒤 물리 실행 횟수가 늘지 않는지 기록한다.
- [ ] 승인 회수·기한 만료 뒤 새 실행이 거부되는지 확인한다. 전송 중 회수는 최종 ACK/readback 정산 결과를 별도로 남긴다.
- [ ] 사건별 위치 lease를 발급하고 방문자에게 허용한 키링만 보이는지, 회수·만료 뒤 핀이 없어지는지 녹화한다.

## 30회 지연

- [ ] 시계 동기화·clock offset·네트워크·거리·배터리·펌웨어 조건을 먼저 기록한다.
- [ ] 독립 버튼 사건 30회를 수행한다. 각 행에 버튼/수신/승인/전송/장치 적용/readback/웹 표시 UTC, commandId, 성공·실패·pending을 남긴다.
- [ ] 자동 승인과 사람이 누른 승인 구간을 분리한다. 실패를 제외하지 말고 표본 수·최댓값·p50·p95·timeout 수를 계산한다.
- [ ] 사건 종단 p95 5초 목표와 비교하고 측정 시작·끝 구간을 명시한다.

## 보드·전원·음향

- [ ] 생산 PCB revision·배터리 사양·계측기 모델·측정 연결 사진을 남긴다.
- [ ] 500mA 조건의 셀 전류·전압과 권장 종료 3.0V에서 차단 정책을 측정한다. 충전·동시 부하·발열·저전압·재부팅을 기록한다.
- [ ] MAX9850의 MCLK/LRCLK/BCLK/SDIN 파형을 저장한다. 16kHz·16bit·256fs 설정과 실제 주파수를 대조한다.
- [ ] 헤드폰 음량·click/pop·idle 전류, 취소·timeout·연결 해제 후 출력 차단 시간을 측정한다. 모의 I2C 시험을 물리 측정으로 대신하지 않는다.

## 현장 RSSI와 그룹

- [ ] 수신기 실측 좌표·높이·방향·차폐·거리·인원 조건과 키링별 RSSI 원본을 수집한다.
- [ ] 1m 기준 RSSI와 path-loss 계수를 표본에서 정하고, 별도 거리 표본으로 오차를 계산한다. GPS/MEC 위치 오차와 BLE 반경 오차를 구분한다.
- [ ] 실물 두 대 이상에 그룹 명령을 승인하고 각 canonical commandId·CSE `/fopt` 결과·물리 동작·ACK·readback을 연결한다.
- [ ] 한 대 단절·권한 거부·ACK 소실·Pi/중앙 재시작을 각각 시험한다. 성공 장치 유지, 실패 멤버만 재시도, 물리 중복 0을 확인한다.

## 녹화와 인계

- [ ] 5분 미만 영상에서 보드·버튼·Pi·보호자 승인·장치·웹을 같은 사건으로 따라간다. 화면에 실물/모의/목표를 표시한다.
- [ ] 원본 영상·자막·전체 로그를 보관하고 제출본의 재생 시간을 확인한다.
- [ ] 시험별 expected/actual·실행자·검토자·UTC·hostId·source/firmware SHA·로그 SHA-256을 [최종 수용표](final-acceptance.md)에 연결한다.
- [ ] 완료하지 못한 항목은 테스트 대기로 유지하고 필요한 장비·정보·다음 실행자를 적는다.
