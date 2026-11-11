# 외부 실증 TODO

2026-11-10 사용자 지시에 따라 실장비·외부 서비스 연결을 후속 TODO topic으로 관리한다. 현재 작업의 완료 범위는 코드 구현, 로컬 실제 프로세스·TLS·DB·CSE 통합 시험, 펌웨어 컴파일, 브라우저 검증이다.

| Topic | 준비할 자료 | 실행과 수용 증거 |
|---|---|---|
| Raspberry Pi·키링 실물 | Pi 접속·장치 등록 인증서·보드 revision·BLE 키 | 버튼→Pi→중앙→승인→ACK/readback, 재연결, 범위, 30회 지연, packet trace |
| 전원·음성·입출력 | 조립 보드·배터리·전자부하·전류/전압계·온도계·헤드폰 | 500mA, 저전압 cutoff, 충전/열, 음량/click/pop, 취소 시 출력 차단, 실물 사진·측정 원본 |
| Cloud·Edge A/B | 실제 호스트 2대·IN/MN-CSE·PostgreSQL·배치 인증서·고정 release | 적격성·process/image identity, 30회 handover/1000관측, 복구·rollback·loss/physical duplicate |
| MEC Sandbox | Location/RNIS endpoint·Swagger·계정·TLS callback·UE/relay 승인 연결 | discovery·구독 CRUD·실제 callback·zone/시간·회수·timeout/재시작 M01–M09 |
| ESTIMED VM | VM 할당·배포 권한·image digest·인증된 worker endpoint | 실제 VM 3참여자/10round·late join/dropout/restart·3seed·artifact publication |
| 실제 OIDC | issuer·audience·client 등록·callback 주소·guardian/visitor/operator subject | 실제 계정 로그인·갱신·로그아웃, 역할별 접근, 위치 공유 승인·회수 |
| 공개 자료·최종 제출 | Article·5분 미만 실물 영상·저장소 release·팀원 | 공개 URL·게시일·실측 자료·forum 기여·팀원별 interview rehearsal |

각 완료 기록에는 실행자·검토자·UTC 시각·hostId·firmware/source commit·image digest·expected/actual·log SHA-256을 연결한다. 비밀키와 운영 계정 설정은 로컬 비밀 설정에 보관하고 공개 receipt에는 식별용 hash와 결과를 기록한다. 실제 Rubric 점수는 위 수용 증거와 심사 결과를 연결하는 단계에서 기록한다.
