# 외부 실행 준비·로컬 리허설 결과

2026-11-12 데스크탑 WSL, Node v24.14.0. 실행 범위는 로컬 모의 공급자·CSE와 합성 FL 데이터다. 실제 외부 서비스를 호출하지 않았다.

```sh
RUN_TMP="$PWD/.local/external-rehearsal/tmp" node pc-mobius/scripts/run-external-rehearsal.mjs --output=docs/final-evidence/external
```

| 실행 | 기대 | 실제 |
|---|---|---|
| 신규 설정·실행기 | 설정 검사, 무접속 검사, MEC/Edge/FL 연결, TLS callback, worker 설정 생성 | 8 PASS / 0 FAIL |
| MEC | M01–M09, Location/RNIS CRUD·trigger·OpenAPI | 27 PASS / 0 FAIL |
| handover | 30회·1000관측, drain·회수·partition·재시작·rollback | 9 PASS / 0 FAIL |
| FL 장애 | 서명·동의·quorum·동시성·복구·artifact·재학습 | 12 PASS / 0 FAIL |
| 기존 수치 runner | 3seed × 10round, 모델/manifest 내보내기 | exit 0, seed별 108바이트 모델 |

합계 56개 시험 PASS, 5개 실행 단계 exit 0. 원본 명령·종료 코드·SHA-256은 `summary.json`에 있다.

신규 설정 실행기 모의 handover는 30회 전환, 관측 1000개, loss 0, duplicate CIN 0, p95 781ms, rollback ROLLED_BACK이었다. 이는 데스크탑 WSL의 모의 HTTP 결과다. 신규 FL 흐름은 기존 수치 worker의 서명 update를 사용하고 모의 CSE에서 모델 33건을 readback했다. 30개 기본 round 외에 seed별 delayed publication SUPERSEDED와 승인 재학습 게시를 확인했다.

기존 수치 runner의 세 seed 모두 합성 test split macro-F1 1.0이다. 같은 참여 횟수의 local-only 평균 macro-F1은 seed 101/202/303에서 각각 0.865542/0.867886/0.866955다. `fl-report.json`과 `.f32`·manifest 파일을 함께 사용한다.

`runner-red.log`는 CLI 구현 전 실패 기록이다. `mutation-red.log`는 독립 Edge 호스트 조건 반전으로 해당 검사 시험이 실패한 기록이다. 변이를 복원한 최종 GREEN은 `configured-runners.log`다. 중간 6개 시험 PASS 기록은 `runner-green.log`에 보존했다.

`source-manifest.json`은 이번 신규 코드·설정·시험의 SHA-256이다. `summary.json`의 cleanup은 실행별 RUN_TMP/cache 제거 receipt다. 초기 RED/GREEN 실행용 빈 cache·tmp 부모도 제거했다. 키·개인 상태·임시 PKI는 공유 증거에 포함하지 않았다. LSP는 미구성 상태라 사용하지 않았으며 새 모듈은 Node 시험으로 실행했다.

외부 계정·endpoint·OpenAPI·발급 인증서·UE/relay 승인·독립 호스트·ESTIMED 할당 증거가 남아 있다. 실제 M01–M09 fault control, 독립 호스트 partition, 실제 VM 프로세스 재시작은 외부 수용 대기다. 설정과 실행 순서는 `../../external-rehearsal.md`에 있다.
