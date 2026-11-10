# Feather 실물 부팅과 BLE 확인

2026-11-10 · KEYRING 남호 · DOC-REV 2.0.0.

사용자 승인으로 COM12의 Feather ESP32 V2를 1.54인치 ST7789와 A0/A1용 벤치 펌웨어로 교체했다. 원래 데모의 복구 파일 4개를 로컬에 복사했다. 플래시 검증이 통과했고 재부팅 후 `FEATHER PROBE READY`가 출력됐다.

Windows에서 벤치 광고 1개를 찾고 PIN을 사용해 암호화와 인증을 요구하는 페어링을 완료했다. Gateway의 BLE 수신기로 `released` 상태를 확인했다. 180초 관측에서 `confirm`·`panic` 이벤트는 수신되지 않았다. 실제 A0/A1 입력과 화면 표시의 확인을 다음 시험으로 남긴다.

장비 결과와 해시는 [receipt.json](receipt.json), 장치 주소를 뺀 확인 줄은 [device.log](device.log)에 기록했다.
