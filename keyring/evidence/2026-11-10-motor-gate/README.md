# r18 진동 출력 차단 순서

KEYRING 남호 · DOC-REV 2.0.0 · 펌웨어 `keyring-0.7.1` · 2026-11-10.

진동 GPIO를 켜기 전에 차단 타이머를 시작한다. 기한·연결 generation·인증·전원 이상을 AUX 준비 전후에 확인한다. 타이머 만료와 BLE 연결 종료도 같은 잠금에서 GPIO를 내린다. 명령의 저장 의도와 영수증 흐름은 기존 NVS journal을 사용한다.

| 호스트 시험 | 실제 결과 |
|---|---|
| 타이머 시작 실패 | AUX와 GPIO OFF |
| 정상 동작 | 타이머 → AUX → GPIO 순서. 짧은 남은 기한과 1000ms 제한을 각각 적용. 콜백에서 GPIO와 AUX OFF |
| 준비 중 기한 경과 | 타이머 전과 타이머·AUX 준비 중 만료 모두 GPIO OFF |
| 연결 종료 | 시작 중 끊기면 출력 차단. 동작 중 끊기면 콜백에서 GPIO OFF |
| 전원 이상 | AUX 준비 뒤 fault 입력이 바뀌면 GPIO OFF |
| 타이머 만료와 새 시작 경합 | 만료 콜백이 출력을 정리하는 동안 새 시작 차단 |

호스트는 현재 펌웨어의 출력 함수와 BLE 종료 콜백을 추출해 MSVC로 컴파일했다. GPIO·시계·타이머·잠금·전원은 모의 장치다. PlatformIO Core 6.2.0과 espressif32 6.9.0으로 로컬 provisioning을 제외한 세 프로필을 빌드했다.

| 프로필 | 결과 | firmware.bin 크기 | SHA-256 |
|---|---|---:|---|
| `keyring_compile_minimal` | 통과 | 807744 | `a397752cac79c4e6d4b1db7bbb704722a6a7f4d832ec64b96b0d75a22210936e` |
| `keyring_compile_st7789` | 통과 | 890672 | `5c33d22445710d0807385ea9174eea9e6c26fb20fa429ffe4a4e67ea50e43a15` |
| `keyring_compile_jd9853` | 통과 | 890288 | `09ce0256aab3472839031cb747f7b1daeed49a58201aeb7ba562999c746770bc` |

ESP timer task의 콜백 시각은 시스템 작업에 따라 지연될 수 있다. 제작 PCB에서 모터 파형, 차단 지연, 실제 진동을 확인해야 한다. [Espressif 문서](https://docs.espressif.com/projects/esp-idf/en/v4.4.8/esp32s3/api-reference/system/esp_timer.html)

저장소 루트의 Visual Studio 개발자 PowerShell에서 호스트 시험을 재현한다. 보드 프로필의 빌드 명령은 [빌드 안내](../../firmware/BUILD_PROFILES.md)에 있다.

```powershell
python keyring/firmware/tests/run_motor_gate_host.py --output '<새 영문 경로>'
```

| 로컬 로그 | SHA-256 |
|---|---|
| `platformio.log` | `35f79dcb5b88c237b8fcfd4bc7ed84249c4333849067c9fb47427bd58d01f5b7` |
| `native-final.log` | `745f5f8f3a2040845448345d754d2da3c7bc14b1dca39b453aa5300617fc0c91` |
