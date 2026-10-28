# r18-hand-solder 인계용 원본 snapshot

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · source included / unverified.

기존 작업공간 `hardware/privacy_bubble_r18_hand_solder/`의 설계와 의존 파일을 복사했다. 원본은 보존했고 회로·배치·패드·네트·BOM 값을 수정하지 않았다. 이 폴더는 새 제조 release나 현재 펌웨어의 실물 검증 결과가 아니다.

KiCad 10에서 [privacy_bubble.kicad_pro](privacy_bubble.kicad_pro)를 연다. 이번 작업에서는 KiCad를 실행하거나 프로젝트를 열지 않았다. PCB generator_version은10.0이고 과거 README는10.0.3 사용을 기록한다. 다른 버전으로 저장하는 변경은 별도로 관리한다.

| 파일·폴더 | 내용 |
|---|---|
| privacy_bubble.kicad_sch / .kicad_pcb / .kicad_pro / .kicad_dru | 회로도·PCB·프로젝트·기존 custom rule |
| Release.kicad_sym / sym-lib-table | 로컬 심볼과 `${KIPRJMOD}` 경로 |
| HandSolder.pretty / Sourced_4L.pretty / fp-lib-table | 손납땜 변경 및 기존 풋프린트 |
| 3dmodels / sourced_cad/MAX98357A.3dshapes | 원본 로컬 모델 |
| working_data | 기존 reference별·구매용 BOM CSV. 재추출·갱신하지 않음 |
| reference_exports/BOM_PCB_1board.csv | 원래 deliverables의1장 기준 통합표. 발주 파일이 아님 |
| external_parts | 두 LCD·케이스·GPIO·커넥터 표 |
| hand_solder_changes.csv / .json / four_layer_stackup.json | 기존 변경 이력·stackup metadata |
| UPSTREAM_README.md | 원본 README와 과거 검사·hash·수량 기록 |
| source-inventory.json | 복사한222개 파일의 출처·byte 수·SHA256·파일 시각 |

일부 모델은 `${KICAD10_3DMODEL_DIR}`의 설치 라이브러리를 참조하므로 일반 KiCad 라이브러리도 필요하다. 기존 시각화용 대체 모델을 실물 기구 검증 결과로 사용하지 않는다. MAX9850의 정확한 TQFN 모델은 원래 BOM에서도 미확보로 기록한다.

inventory hash는 복사한 byte의 식별 정보다. 분석·build·전기적 검증 결과가 아니다. `.gitattributes`로 이 폴더의 newline 변환을 막았다. 목록에는 원본 복사 파일만 기록하며 이 README 등 새 안내 문서는 제외한다.

원본 README·stackup·BOM 안의 verified/DRC/ERC/simulation/구매 정보는 기존 저자의 과거 기록이다. 이번에 재현·검증·갱신하지 않았으며 firmware keyring-0.5.0의 release 증거로 승격하지 않는다. analysis/Checks·거버·드릴·ZIP·editor 상태·중복 미사용 library는 가져오지 않았고 원래 작업공간에 보존했다.

BOM은 기존 export이며 현재 가격·재고·공급사 번호를 확인한 표가 아니다. GPIO prose 일부가 오래됐으므로 [핀 정정·펌웨어 연결](../HARDWARE_FIRMWARE_MAP.md)을 먼저 따른다. 부품 재선정·제조 발주를 하지 않았다.

원본 property·model 명칭·source URL을 유지했다. KiCad 유래 library data의 원저자는 KiCad community다. HandSolder 변경은 기존 변경 이력에 남아 있다. [KiCad 공식 license](https://www.kicad.org/libraries/license/)와 [CC BY-SA4.0](https://creativecommons.org/licenses/by-sa/4.0/) 및 KiCad 설계 예외를 참고한다. KiCad 유래 library collection 부분의 attribution/license를 유지하며 supplier 모델이나 프로젝트 전체에 일괄 새 라이선스를 부여하지 않는다. MAX98357A/EasyEDA/supplier 표기 모델은 받은 project asset과 해당 출처 조건을 유지한다.

실제 조립 revision·배터리/화면/모터·스피커·전력/RF/열/조립 검사·flash·통합 시연은 별도 미완료다.
