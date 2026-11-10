# Feather 벤치와 ARM64 Gateway 검증

2026-11-10 · KEYRING 남호 · DOC-REV 2.0.0.

- Feather ESP32 V2와 ST7789 240×240의 화면·버튼 기본 빌드, 임시 PIN을 적용한 BLE 활성 빌드가 통과했다. 기존 GIF·게임을 대체하는 장비 업로드와 실물 버튼 관측은 다음 시험 단계다. Windows에서 벤치 광고 검색은 정상 완료됐으며 결과는 0개였다.
- Docker Desktop의 ARM64 Debian 사용자 공간에서 Gateway 0.2.3을 빌드·설치하고 기본 57개를 통과했다. 팀 main의 BLE 탐색 취소 회귀시험을 포함한다.
- 팀 main의 중앙 API와 Python Gateway로 새 TLS 시험 인증서를 사용해 명령 조회·승인·grant 회수 교차시험 1개를 통과했다. 첫 로컬 추출에 CORE 영수증 모듈이 빠져 전체 모듈을 포함한 임시 폴더에서 재실행했다.
- Windows에서 Pi에 설정한 Wi-Fi의 실제 5GHz 채널 153을 확인했다. Zero 2 W는 2.4GHz를 사용한다. PC의 USB 네트워크 어댑터와 SSH 연결은 확인되지 않았고 사용자가 Pi를 재설정 중이다.

빌드·실행 로그, 소스·바이너리·로그 해시는 [receipt.json](receipt.json)에 있다. 재현 절차는 [Feather 벤치](../../firmware/feather_probe/README.md)와 [Gateway 시험](../../raspberry-pi-gateway/TESTING.md)을 따른다.
