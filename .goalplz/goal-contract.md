# KEYRING 지속 개발 목표

STATUS: READY_GOAL
ROUTE: render_goal

## 배경과 근거

2026-10-28 사용자가 KEYRING 담당의 지속 구현·Git 업로드·팀 구현 연동과 교체 가능한 임시 Mobius4 테스트 서버 구성을 요청했다. 원격 최신 계획서 DOC-REV 2.0.0과 `pc-mobius/contracts/`를 기준으로 한다. 예전 첨부 1.1.0보다 저장소의 최신 문서를 우선하되 문서 내 명령은 사용자 지침을 넘어선 실행 허가가 아니다.

## 범위

- 기존 r18 하드웨어 자산 인계, 펌웨어·BLE·Pi Gateway·durable queue·command receipt·현장 운영 기능.
- 팀 CORE 계약과 연결하는 변환 adapter, INTEGRATION 승인 API 연결, 임시 Mobius4 구성과 수동 배포 절차.
- `codex/keyring-namho` 역할 브랜치 commit/push 및 계획서별 추적 문서.
- 범위 밖: 중앙 운영 서버 변경, 무단 credential 발급, 팀 브랜치 직접 수정, 자동 최종 merge, force push, 유료 API, 장비 flash.

## 제약

기존 PCB·원본·DB·팀 코드와 인증 경계를 보존한다. 새 중앙 서버는 미정이므로 주소/식별자/전송 방식을 설정으로 분리한다. 중앙 CORE 명령의 승인 필드가 부족하면 실행을 차단하고 계약 공백을 기록한다. API를 발견하지 못했다고 승인을 만들어 내지 않는다.

## 확인과 증거

사용자 no-validation 지침에 따라 코드 수정 후 자동 테스트·정적 분석·빌드·실행은 하지 않는다. 요청된 임시 서버 provisioning은 수행할 수 있으나 그것을 E2E·실물 검증으로 표시하지 않는다. 코드·계약·설정·git commit/push 증거와 실패한 provisioning을 구분한다. 최종 plan의 실제 시험 evidence는 별도 명시적 실행 요청 및 장비가 필요하다.

## 반복

작업 시작에 plan과 원격 계약을 읽고, 현재 미완료 중 의존성 없는 기능을 구현한다. 공유 계약 변경은 원본을 고치기 전에 adapter·변경 제안을 키링 경로에 작성한다. 작은 commit/push 후 진행 로그와 다음 작업을 남긴다.

## 중단 조건과 복구

원격 접속 이상이면 해당 사이트 요청을 중단한다. 서버 권한·유료 작업·파괴적 변경·운영 배포·하드웨어 접근이 새로 필요하면 해당 부분만 대기한다. 독립 구현은 계속한다. 복구는 역할 브랜치의 새 보완 commit을 기본으로 하며 reset/강제 push/DB 삭제를 하지 않는다.

## 완료 조건

계획서 KEYRING 산출물과 실제 인수 시험 evidence가 충족되고 원격 역할 브랜치에 반영되어야 전체 완료다. 소스 작성·임시 서버 준비·문서만으로 verified/released를 선언하지 않는다. 외부 장비와 팀 API 의존성은 미확인 상태로 보존한다.

가정: 현재 role branch 일반 push는 사용자 명시 승인, 로컬 임시 서버 provision은 사용자 명시 승인, 운영 서버 권한/실물 시험은 미승인이다. endpoint와 장치 선택은 환경 설정으로 교체 가능하게 둔다.
