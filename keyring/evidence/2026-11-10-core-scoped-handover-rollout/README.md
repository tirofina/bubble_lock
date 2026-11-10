# Scoped CORE handover 배치

KEYRING 남호 · DOC-REV 2.0.0 · 2026-11-10. 팀 main `715ef58df6c901480eb71fb3b9278e8df6547d93`, handover 소스 `fa62263120786dddac752efb89808c998ac94d6f`.

```powershell
./keyring/dev/mobius4/start-scoped.ps1 -RefreshIngress
./keyring/dev/mobius4/handover-scoped.ps1 -Status
```

| 배치 항목 | 관찰 결과 |
|---|---|
| 교체 범위 | scoped broker·consumer 컨테이너만 교체. scoped Mobius4·PostgreSQL·TLS와 기존 개발 프로필 4개의 컨테이너 ID 일치 |
| 준비 확인 | 새 소비자가 `SCOPED_SUBSCRIBED receipts=1 handover=1`을 기록한 뒤 배치 명령이 반환 |
| 초기 소유권 | `-Status`가 영속 저장소의 `gw-a`, `kr-handover`, epoch 7과 `EMPTY` cursor를 반환 |
| 배치 파일 | 컨테이너에서 읽은 ACL·consumer·ingress·ordering 4개 파일의 SHA-256이 작업본과 일치 |

초기 소유권 등록과 조회까지만 실행했다. `Forward`·`Rollback` 명령, 관측·영수증 발행, ACL 거절, SDT 적용·readback, Gateway 빌드와 실물 시험은 미실행이다.

| 로컬 파일 | SHA-256 |
|---|---|
| `refresh.log` | `db719fb11d038198dc1f73fe4b1de780eb7b74fa9723c8cea1c00a0b05716672` |
| `deployment.log` | `9c1b33780f5b5e87f055510e643211f2f40616fce3fa64615f70f40f2ccb87dc` |
