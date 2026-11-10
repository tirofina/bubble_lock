# Feather 벤치의 SDT 읽기 경로 준비

KEYRING 남호 · DOC-REV 2.0.0 · 2026-11-10. 팀 main `715ef58df6c901480eb71fb3b9278e8df6547d93`.

격리 TLS 프록시에서 Gateway A 인증서로 `GET /Mobius/privacy-bubble-test-ae/featherState`를 허용했다. 첫 시작은 긴 exact map 키의 Nginx `map_hash_bucket_size` 오류로 실패했다. 경로 전체에 일치하는 정규식으로 교체한 뒤 scoped TLS 프록시만 다시 띄웠다.

Gateway A 인증서로 HTTPS 조회를 실행해 TLS 1.3, HTTP 200, oneM2M RSC 2000과 일치하는 RQI를 관찰했다. 응답은 `pb:binarySwitch`의 `featherState`와 초기값 false였다. 컨테이너의 Nginx 설정 소스 해시가 작업본과 일치했다. 이 조회에는 실제 관측 또는 MQTT 적용 영수증이 사용되지 않았다.

Gateway 0.2.19의 scoped relay와 회귀시험은 소스 단계다. Pi에서 실행하거나 Gateway wheel을 빌드하지 않았다. [실행 절차](../../firmware/feather_probe/README.md#feather-scoped-적용-영수증)

| 로컬 파일 | SHA-256 |
|---|---|
| `deployment.log` | `353c53cdfae60ab4ec87469ed7dbda2aaa724c8918372bcb43f364603331e3e8` |
| `initial-read.log` | `c7c57673f50c10d20497ef6cbc4f54c5996882d49bad435ed9ae4cbbdc3a23e2` |
| `refresh.log` | `be859cb8814f2b96ae8d6007121da0c0f43e8f121d51887040526e28e8bdeba8` |
