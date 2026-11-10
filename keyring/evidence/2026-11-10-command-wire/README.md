# r18 BLE 명령 원본 검증

KEYRING 남호 · DOC-REV 2.0.0 · 펌웨어 `keyring-0.7.2` · 2026-11-10.

ArduinoJson 6.21.5로 최상위 `remainingMs`와 중첩 `state`의 중복을 파싱하면 최종 객체의 필드 수가 정상과 같았다. 정상 객체 뒤에 붙인 다른 값과 문자열도 첫 객체 파싱 후 남았다. r18은 파싱된 필드와 원본 프레임을 함께 확인하고 NVS·GPIO 처리 전에 해당 입력을 거절한다. [JSON 객체 규칙](https://datatracker.ietf.org/doc/html/rfc8259#section-4)

| 호스트 시험 | 결과 |
|---|---|
| 정상 프레임 | Gateway 형식, 키 순서 변경, 공백, ASCII 이스케이프, 4096바이트 파서 입력 통과 |
| 중복 키 | 최상위와 중첩 키, 이스케이프를 사용한 동등 키 거절 |
| 원본 프레임 경계 | 추가 객체·문자열, 이스케이프된 NUL 거절 |
| 필드 형식과 제한 | 따옴표 없는 키, 홑따옴표 문자열, 잘못된 state·revision·epoch·기한 거절 |
| 기존 Feather 회귀 | 명령·재부팅 중복·기한·NVS 실패·포화 시험 4개 그룹 통과 |

MSVC 호스트 시험과 PlatformIO Core 6.2.0의 로컬 빌드를 실행했다. 세 펌웨어 빌드는 실제 장치별 provisioning을 제외했다. 실물 BLE 송수신·flash와 제작 PCB 출력 시험은 별도다.

| 프로필 | 결과 | firmware.bin 크기 | SHA-256 |
|---|---|---:|---|
| `keyring_compile_minimal` | 통과 | 808208 | `a4dc4ffa5cdba61aea3d9155c1131ef11f204e963bda77b4dee25fed4e819f8b` |
| `keyring_compile_st7789` | 통과 | 891104 | `3b532760bc93f41c39232f6d345f5ff7588f46199b63c23b1315c18926c1281f` |
| `keyring_compile_jd9853` | 통과 | 890720 | `e7f1800ac1e94fdd560955e29034f04fcb3c1556efc202ffd01c5cad5cc802c6` |

저장소 루트의 Visual Studio 개발자 PowerShell에서 r18 호스트 시험을 재현한다. Feather 시험은 [기존 C++17 명령](../2026-11-10-feather-command/README.md)을 사용한다.

```powershell
$fw = Join-Path $PWD 'keyring/firmware'
$json = '<ArduinoJson 6.21.5 src 절대 경로>'
$out = '<출력 폴더 절대 경로>'
cl /nologo /utf-8 /std:c++14 /EHsc /I"$fw/include" /I"$json" /Fo"$out/command_wire.obj" /Fe"$out/command_wire.exe" "$fw/tests/command_wire_host.cpp"
if ($LASTEXITCODE -eq 0) { & "$out/command_wire.exe" }
```

| 로컬 로그 | SHA-256 |
|---|---|
| `platformio.log` | `073fdc0db3112a2bbfec9c4e9332fac755144f25b75a4926e582d8847d73abd8` |
| `native-final.log` | `5eb65abe0d1e11459736ddf2da151adc34986630ca6108548678ce60db1f40af` |
