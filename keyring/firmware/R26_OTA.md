# r26 Wi-Fi 업데이트

`keyring_r26_front_ota`는 두 OTA 슬롯을 쓰는 r26 개발용 프로필이다. 장치별 비밀번호와 Wi-Fi 목록은 저장소 밖의 헤더에서 제공한다. 현재 여분 보드의 개인 설정은 소유자 PC에 별도로 보관한다.

```cpp
#define KEYRING_PASSKEY 123456 // 보드마다 다른 BLE PIN으로 교체
#define KEYRING_OTA_HOSTNAME "keyring-spare-ota"
#define KEYRING_OTA_PASSWORD "개별 OTA 비밀번호"
#define KEYRING_OTA_NETWORKS {{"WiFi-1", "암호-1"}, {"WiFi-2", "암호-2"}}
```

두 Wi-Fi를 순서대로 최대 15초씩 시도한다. 연결되면 포트 3232에서 ArduinoOTA 인증을 사용한다. 사용자 PC와 보드가 같은 Wi-Fi에 있어야 한다. 최초 USB 설치 후 보드의 IP와 개별 헤더, OTA용으로 다시 빌드한 펌웨어를 사용한다.

```powershell
python tools/upload_r26_ota.py <보드_IP> <firmware.bin> <개인_헤더> <Arduino_ESP32_tools/espota.py>
```

기존 NVS 위치는 유지하고 OTA 상태 영역과 두 3 MiB 앱 슬롯을 추가한다. 기존 파티션 테이블을 바꾸는 최초 설치에는 파티션 테이블과 앱을 함께 써야 하므로 기존 보드는 플래시 백업과 이전 OTA 상태 확인이 필요하다. 새 슬롯에 쓴 이미지가 완성되기 전에는 기존 앱을 부팅한다. 새 앱이 처음 켜졌을 때 LCD 초기화와 Wi-Fi 연결이 120초 안에 완료되면 이미지를 확정한다. 이 검사는 물리 LCD의 화질이나 BLE 통신을 확인하지 않는다.

ArduinoOTA는 암호 인증을 사용하며 펌웨어 전송을 암호화하지 않는다. 빌드 산출물에는 Wi-Fi 암호와 OTA 암호가 들어가므로 Git에 올리거나 배포하지 않는다. 보안 부팅이나 서명 검증은 이 개발 프로필에서 제공하지 않는다.
