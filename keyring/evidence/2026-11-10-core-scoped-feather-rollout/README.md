# Feather 전용 scoped Mobius4 준비

KEYRING 남호 · DOC-REV 2.0.0 · 2026-11-10. 팀 main `715ef58df6c901480eb71fb3b9278e8df6547d93` · Gateway 0.2.18 소스.

| 준비 항목 | 실제 관찰 |
|---|---|
| Feather 전용 자원 | `/Mobius/privacy-bubble-test-ae/featherState`, ty 28, CREATE HTTP 201·RSC 2001 |
| 소유권 | 영속 저장소가 `gw-a / keyring-feather-lab / 1`을 반환. handover 장치는 `gw-a / kr-handover / 7` |
| MQTT | 새 소비자 로그에 `SCOPED_SUBSCRIBED receipts=1 handover=1 feather=1`. ACL·소비자·수신 모듈의 컨테이너 파일 해시가 작업본과 일치 |
| 격리 상태 | 기존 개발 프로필 4개 및 scoped CSE·DB·TLS의 컨테이너 ID 일치. SDT 적용 cursor는 0건 |

```powershell
node ./keyring/dev/mobius4/bootstrap.mjs --scoped
./keyring/dev/mobius4/start-scoped.ps1 -RefreshIngress
```

빈 SDT 초기값은 준비 값이다. Pi 연결, Feather 관측·영수증 발행, 기존 1.0.0과 nullable 1.1.0의 기능 시험, Gateway 빌드는 미실행이다. [Pi·Feather 연결 조건](../../dev/mobius4/README.md#feather-벤치-경로)

| 로컬 파일 | SHA-256 |
|---|---|
| `provision.log` | `97c931a9bc714b42c3730f7ea3c7817a953315c0f9bfbf825e26bf0010d9307a` |
| `resource-provisioning.json` | `d15a6d883de761a2edbe990c6c91da85c7143622567e1a1963123104cbe73894` |
| `refresh.log` | `771067fb1027aafb39116059c0eaf53a1eee2843d3b6e8e7192343feadb4126a` |
| `deployment.log` | `c1cfdc537f308f87bc858a095ae45c8ff035f4614a7a9db456c71167b0c47df0` |
