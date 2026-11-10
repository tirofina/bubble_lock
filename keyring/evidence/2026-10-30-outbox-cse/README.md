# 실제 CSE와 Gateway 영속 큐 복구 시험

KEYRING / 남호 · DOC-REV2.0.0 · Gateway0.2.3 · 2026-10-30.

실제 Mobius4/PostgreSQL과 Gateway Store·TransportHub·Gateway._outbox_loop를 연결했다. 기존 CSE5개에 영속 큐5개를 추가한10개가 소스·기존0.2.3 설치 wheel에서 각각 통과했다. [receipt.json](receipt.json)에 실행 로그·image ID·소스/패키지 hash를 기록한다. runtime/DB schema/firmware는 변경하지 않았다.

## 추가한 실제 시험

| 제안 ID | 실제 결과 |
|---|---|
| KR-OUTBOX-CSE-01 | 새 SQLite에 observation을 저장·닫기/열기 후 실제 CSE로 전송. 같은 observation 재수신을 차단하고 cin1개·outbox0개 확인 |
| KR-OUTBOX-CSE-02 | 합성 INDETERMINATE receipt의 receipt_delivered가0에서 실제 MQTT application response 이후1로 변경. CSE con일치·cin1개·HTTPS POST fallback0회 |
| KR-OUTBOX-CSE-03 | 시험 소유 CSE 중단 중 전송 실패·attempts1/backoff·동일 rqi/payload 유지. SQLite 다시 열어 동일 상태 확인, CSE 복구와 실제 backoff 경과 후 전송·cin1개/outbox0개 |
| KR-OUTBOX-CSE-04 | 시험용 송신 자식 프로세스가 실제 CSE 응답을 받은 직후 Store.delivered 호출 지점에서 os._exit(73). SQLite 연결을 닫지 않은 종료 뒤 같은 outbox행 복구·재전송·remote collision readback을 거쳐 cin1개/outbox0개 |
| KR-OUTBOX-CSE-05 | 원격에 같은 rqi/다른 con이 이미 있으면 sender는 성공으로 표시하지 않음. 원격 원본·충돌한 로컬 행·attempts1 보존 |

KR-OUTBOX-CSE-02의 receipt/command는 합성이고 장치 실행은 없다. KR-OUTBOX-CSE-04의 exit73은 의도한 장애 주입이며 전체 unittest 결과는exit0이다. delivery_child.py는 시험 전용 helper로 Gateway 송신 loop만 실행한다. Gateway 전체 daemon, BLE·credential/poll/dispatch/health loop는 실행하지 않는다. parent는 idle/backoff 시 loop를 종료하도록 _pause를 대체한다. Store·SQLite·TLS·HTTP/MQTT·CSE·PostgreSQL은 실제 구현이다. 전원 손실이나 실제 Pi 장애 시험은 아니다.

각 source-logs/installed-logs의 test_outbox*/delivery-facts.json은 assert가 끝난 뒤 기록한 확인 수치다. 원본 CSE·SQL·proxy·broker 로그도 같은 폴더에 보존했다. 의도한 거절/중단 시 delivery deferred 로그가 나타난다. 성공/실패 판정은 unittest 원본 로그를 따른다.

## 재현

실행 방법과 캐시 이미지 준비는 [TESTING.md](../../raspberry-pi-gateway/TESTING.md)의 별도 실제 CSE10개 절차를 따른다. 기본 단위56개와 MQTT6개는 이번에 변경/재실행하지 않았으며 [직전 실행 기록](../2026-10-30-real-cse/README.md)을 유지한다. wheel은 기존0.2.3을 재사용하고 import/version/모든Python module의 LF 정규화 일치를 새로 확인했다.

기존 개발 stack/DB를 사용하지 않았다. 매 실행 새 test PKI·tmpfs PostgreSQL·network·loopback 임시 포트를 사용하고 label/token을 확인한 자원만 중단/제거했다. 시험 종료 후 소유 container/network0개, 기존개발4개running이다. 개인키·인증서·SQLite/DB data·wheel binary는 commit하지 않는다.

## 남은 범위

R02·R10·R12의 로컬 부분 증거다. 중앙 principal/AE/ACP/grant·정산/checkpoint/복구 승인·Group/SDT/앱/웹, 실물 Pi/키링/BLE·전력/거리·영상/release와 원래 A01~A26 gate 승인은 남아 있다. 로컬 transport 복구 성공을 중앙 receipt 정산이나 실물 시연 완료로 표시하지 않는다.
