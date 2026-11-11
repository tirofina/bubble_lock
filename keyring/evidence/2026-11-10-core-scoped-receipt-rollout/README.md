# Scoped CORE 적용 영수증 배치

KEYRING 남호 · DOC-REV 2.0.0 · 2026-11-10. 팀 main `715ef58df6c901480eb71fb3b9278e8df6547d93`, Gateway 0.2.14 적용 영수증 소스 `935847a4a1fd8260530e804bb5018b31a590ee8c`.

```powershell
./keyring/dev/mobius4/start-scoped.ps1 -RefreshIngress
```

| 배치 항목 | 관찰 결과 |
|---|---|
| 기존 소비자 종료 | 정상 종료 코드 0. 교체 전 scoped broker 로그에는 중앙 소비자 연결만 관찰됨 |
| 교체 범위 | scoped broker·consumer 컨테이너만 교체. scoped Mobius4·PostgreSQL·TLS 및 원래 개발 프로필 4개의 컨테이너 ID 일치 |
| 배치 파일 | 컨테이너에서 읽은 broker ACL, consumer, ingress, ordering 네 파일의 SHA-256이 작업본과 일치 |
| 영속 기록 | 교체 전후 cursor SHA-256 일치. cursor 항목 0개, `PENDING` 0개 |
| 구독 준비 | 새 중앙 소비자 로그에 `SCOPED_SUBSCRIBED receipts=1` 기록 |

관측·영수증 발행 없이 격리 프로필을 배치했다. ACL 거절, Mobius4 UPDATE, 적용 영수증의 응답·재전송, Gateway 빌드와 실물 시험은 미실행이다. [이전 서버 준비 기록](../2026-11-10-core-scoped-stack/README.md)

| 로컬 파일 | SHA-256 |
|---|---|
| `refresh.log` | `cdbff19511829acdca430bc31c2ac48075cab5c1da660ae1ab53923623486e04` |
| `deployment.log` | `6260f64ab377163531e19e5145e716c8b586697c5dd6b5656a54884730e392f9` |
