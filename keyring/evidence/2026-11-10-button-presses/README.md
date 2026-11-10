# 부팅별 확인·비상 누름 누계

KEYRING 남호 · DOC-REV 2.0.0 · r18 펌웨어 0.7.3 · Gateway 0.2.10 · 2026-11-10.

펌웨어는 순간 버튼 상태와 같은 부팅의 누름 누계를 함께 전송한다. BLE 전송 대기 중 최신 해제 프레임이 누름 프레임을 대체해도 다음 관측에 누계가 남는다. 부팅이 바뀌면 새 bootId의 누계를 별도로 읽는다.

| 시험 | 실제 결과 |
|---|---|
| r18 관측 대기열 | 실제 `Tx`와 관측 직렬화 코드를 호스트에서 실행. 같은 센서 상세의 대기 프레임이 해제로 교체돼도 확인 누계 1 유지 |
| 두 버튼과 포화 | 동시 입력은 비상, 비상 유지 중 확인은 억제, 해제는 누계 증가 없음. uint32 상한에서 유지 |
| 프레임 크기 | 최대 ID·누계와 INA219 값의 합성 프레임이 LF 포함 505바이트. 강제 최소 프레임에도 두 누계 유지 |
| Gateway와 CSE | 합성 BLE 해제 프레임을 실제 Gateway 관측 경로에 입력. SQLite 재열기 뒤 격리 Mobius4의 native cin 1건에서 `released` 및 `[1,2]` 확인 |
| 계약 호환 | BLE와 native JSON Schema가 기존 관측과 유효 누계를 수용하고 잘못된 입력 각 7개를 거절 |

호스트 4개 그룹, Gateway 기본 74개, 실제 CSE 통합 11개가 통과했다. Gateway wheel의 Python 모듈 14개가 소스와 일치했다. 위 시험의 버튼과 BLE 입력은 합성 데이터다. 실물 버튼·Pi 수용 및 앱에서의 알림 처리는 별도다.

| 장치 provisioning을 제외한 프로필 | 결과 | firmware.bin 크기 | SHA-256 |
|---|---|---:|---|
| `keyring_compile_minimal` | 통과 | 808528 | `48e2a431fef73ccf14967a11af56a5591245b6451b89c692ea67d75fe01e4b87` |
| `keyring_compile_st7789` | 통과 | 891408 | `a1ef4408292d6236b3e7876e80529c4c21469ed51ef081392dfdde9206e08311` |
| `keyring_compile_jd9853` | 통과 | 891024 | `6c628b6abc89206b9c2f8b8a09dc0825547a46a1f866acfe58aa306fe9e3cced` |

호스트 시험은 저장소 루트의 Visual Studio 개발자 PowerShell에서 실행한다. Gateway는 [기본 시험과 CSE 재현 절차](../../raspberry-pi-gateway/TESTING.md)를 사용한다.

```powershell
python keyring/firmware/tests/run_button_observation_host.py `
  --output '<새 영문 절대 경로>' --arduinojson '<ArduinoJson 6.21.5 src 경로>'
```

| 로컬 파일 | SHA-256 |
|---|---|
| `platformio.log` | `76ba8a460e2ae5f9840e191f18d6211027612ccb6bcef02bd41b4b1a5e7393b0` |
| `native.log` | `a7a7b90ab946dc3c007b5087a4ed9bbb792a281f310ac533ed1492fe58a5afc0` |
| `gateway-basic.log` | `024e3281f773109f5c093266411b301f748342612524b5753db54c8c73aefecc` |
| `gateway-cse.log` | `94da3c5520815b293283fe7e6597565bafca1399c1ceb2fbd77b631867b0f24e` |
| `schema.log` | `89174642d3f71a4d43e6901280c4214afc449a379b5488efee03ad2dd2d7a72c` |
| `privacy_bubble_gateway-0.2.10-py3-none-any.whl` | `7ab7a2e84c485ec333a1b7d009c524c66711f5d6c42eecd63401f69c921ec4bc` |
