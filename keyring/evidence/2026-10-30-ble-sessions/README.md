# BLE 세션 경계 수정과 Gateway 패키지 시험

2026-10-30 · KEYRING / 남호 · DOC-REV 2.0.0 · Gateway0.2.1 · source48c71e1.

작업 시작 fetch에서 main/CORE91a281b·WEB80ed37f를 확인했다. 이번 수정은 [BLE 연결 수명 규칙](../../raspberry-pi-gateway/BLE_SESSIONS.md)에 따른 Gateway 내부 처리다. GATT UUID·wire schema·중앙 grant/epoch 계약과 firmware0.7.0은 변경하지 않았다.

| 실행 | 실제 결과 | 로그 |
|---|---|---|
| 수정 전5개 재접속 회귀 시험 | exit1,5 failures. 교체된 연결에 남은 조각12회 WRITE 발생 | [baseline.log](baseline.log) |
| 수정 후 소스 전체 단위 시험 | exit0,42개 OK,1.008초 | [gateway-tests-source.log](gateway-tests-source.log) |
| 네트워크 없는 wheel build | exit0,privacy_bubble_gateway-0.2.1-py3-none-any.whl,40336bytes | [wheel-build.log](wheel-build.log) |
| wheel의 별도 임시 경로 설치 | exit0,0.2.1 설치 | [wheel-install.log](wheel-install.log) |
| 설치한 wheel에서 전체 단위 시험 | exit0,42개 OK,0.960초. import 경로와 version0.2.1을 확인하고 실행 | [gateway-tests-installed.log](gateway-tests-installed.log) |

Windows11/Python3.12.14에서 수행했다. wheel SHA256은 `5f5d14e2b524c38bd57ae502a99e83fbbc0ac487c2aeb9a824898a8caca37f8a`다. 패키지는 로컬 `_local/keyring-gateway-wheel/`에 보관한다. 실제 크기·hash·dependency version·소스 파일 hash는 [receipt.json](receipt.json)에 기록했다. `.gitattributes`로 Git의 로그 byte 변환을 막는다.

저장소 루트에서 소스 시험:

```powershell
$env:PYTHONPATH = (Join-Path $PWD 'keyring/raspberry-pi-gateway/src')
python -m unittest discover -s keyring/raspberry-pi-gateway/tests -v
```

Gateway 프로젝트 디렉터리에서 패키지 빌드(개발 환경에 setuptools>=68·wheel 필요):

```powershell
python -m pip wheel --no-index --no-deps --no-build-isolation --wheel-dir ../../../_local/keyring-gateway-wheel .
```

설치 시험은 `pip install --no-index --no-deps --target <새 임시 경로> <wheel>`로 설치한 뒤 PYTHONPATH를 그 경로로 지정했다. 테스트 시작 전에 bubble_gateway.__file__이 그 경로 아래이고 version이0.2.1인지 assert했다. 이전 테스트 DB나 운영 설치는 사용하지 않았다.

fake GATT·모의 HTTP/MQTT·합성 명령·테스트 전용 임시 SQLite를 사용했다. POSIX directory fsync는 기존 Windows 시험과 동일하게 모의 처리했다. 실제 scanner·BLE/BlueZ·장비·COM·flash·기존 DB·Gateway daemon·운영 서비스는 실행하지 않았다. firmware는 이번에 수정·재빌드하지 않았으며 [2026-10-29의 세 프로필 빌드 결과](../2026-10-29-local-validation/README.md)를 보존한다. Pi/CSE 통합·물리 시험·영상·release는 남아 있다.
