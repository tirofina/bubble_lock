# 실제 Mobius4 저장·MQTT 주소 변환 증거

KEYRING / 남호 · DOC-REV2.0.0 · Gateway0.2.3 · 2026-10-30.

캐시된 실제 Mobius4·PostgreSQL/PostGIS·Mosquitto·nginx로 매 실행 별도 test stack을 만들었다. 소스와 새 wheel 설치본에서 기본56개, MQTT6개, 실제 CSE5개가 각각 통과했다. 명령·환경·원본 로그·SHA256은 [receipt.json](receipt.json)에 기록한다. firmware0.7.0은 변경하지 않았고 기존3개 프로필 빌드 증거를 유지한다.

## 발견한 오류와 수정

기존 Gateway는 HTTP container 경로의 선행 `/`를 MQTT primitive의 `to`에도 복사했다. 실제 CSE는 이를 SP-relative identifier로 해석해 MQTT 요청을 거절했다. baseline은5개 중4개 통과·1개 error다. baseline 로그가 거절 rsc의 숫자를 출력하지 않아 값을 기재하지 않는다. `baseline-cse-tests.log`와 `baseline-cse-logs/`를 보존한다.

[oneM2M TS-0009 §6.2.2.1](https://specifications.onem2m.org/ts/ts-0009/latest/6.2/)의 HTTP 주소 인코딩을 역변환해 MQTT `To`를 구성한다.

| 설정한 HTTP 경로 | MQTT To |
|---|---|
| /Mobius/cnt | Mobius/cnt |
| /~/Mobius4/Mobius/cnt | /Mobius4/Mobius/cnt |
| /_/localhost/Mobius4/Mobius/cnt | //localhost/Mobius4/Mobius/cnt |

HTTP URL·rqi·rn·con·outbox·DB schema·중앙 승인 계약은 그대로다. 모의 시험에도 To 기대값을 추가해 같은 오류를 검출한다.

## 실제 CSE 시험

| 제안 시험 ID | 확인한 결과 |
|---|---|
| KR-CSE-01 | HTTPS POST 후 GET한 cin.con 일치·CNT cni=1 |
| KR-CSE-02 | MQTT3가지 주소 범위 각각 application response 성공·GET 일치·cni=3·같은 rqi의 HTTPS POST fallback0회 |
| KR-CSE-03 | 동일 rqi/동일 내용 재전송 후 cin1개 |
| KR-CSE-04 | 동일 rqi/다른 내용 rsc4105 거절·원본 보존·cin1개 |
| KR-CSE-05 | 시험 소유 CSE 프로세스 재시작 후 기존 cin 조회·cni=1 |

재시작 시험 동안 PostgreSQL은 유지한다. DB 재시작·호스트 전원 손실 내구성 시험은 수행하지 않았다. test PKI와 새 tmpfs DB·임시 포트·ownership label/token만 사용한다. 기존4개 개발 container·기존 DB·운영 서비스는 변경하지 않았다. 마지막 소유 container/network 잔여0개다.

초기 setup 실패도 삭제하지 않았다. 첫 실행은 Docker UTF-8 출력의 CP949 디코딩 오류로0개 실행·1error이며, 남은 시험 소유 CSE/network를 label 확인 후 정리했다. 둘째 실행은 test CA 파일명 불일치로0개 실행·1error였다. 이후 helper 디코딩·test proxy CA 경로를 수정했다. 성공 수치는 최종 source/installed 로그만 집계한다.

## 실행

저장소 root에서 개발 Python과 의존성, Git OpenSSL, Docker daemon, 아래4개 캐시 이미지를 준비한다. 자동 image pull은 없다. 실제 CSE suite는 기본 tests/ 및 MQTT integration_tests/와 분리한다.

```powershell
$env:KEYRING_TEST_OPENSSL = 'C:/Program Files/Git/usr/bin/openssl.exe'
$env:PYTHONPATH = (Join-Path $PWD 'keyring/raspberry-pi-gateway/src') + [IO.Path]::PathSeparator + (Join-Path $PWD 'keyring/raspberry-pi-gateway/tests') + [IO.Path]::PathSeparator + (Join-Path $PWD 'keyring/raspberry-pi-gateway/integration_tests')
python -m unittest discover -s keyring/raspberry-pi-gateway/cse_integration_tests -v
```

이미지 태그는 privacy-bubble-keyring-mobius4:local, postgis/postgis:17-3.5, eclipse-mosquitto:2, nginx:1.28-alpine이다. 이번 실행의 정확한 image ID와 Mobius upstream e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8은 receipt에 고정했다. 설치본은 네트워크 없이 wheel을 새 경로에 설치한 뒤 import 경로·version·Python 모듈의 LF 정규화 일치를 확인했다.

## 범위

R02·R03·R10·R11의 로컬 부분 증거이며 중앙 gate 승인은 없다. CSE 시험용 principal은 개발 proxy의 합성 admin mapping이다. 운영 principal→AE/Originator·ACP/grant, 중앙 INTEGRATION API, Group/SDT 명령, Pi/BlueZ·키링·앱/웹·전력/거리·영상·release는 남아 있다. 임시 인증서·개인키·DB·wheel binary는 commit하지 않았다.
