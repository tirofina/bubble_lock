# SDT binarySwitch 버전 호환

ZIP RBG-03 계약의 기본 전송 형식은 `cod:binSh`, `state:boolean`, `org.onem2m.common.moduleclass.binarySwitch`이다. `src/sdt-adapter.mjs`는 sourceVersion을 지정하여 기존 형식을 정본으로 변환하고 입력·출력 SHA-256을 가진 변환 영수증을 반환한다.

| profile | envelope | 값 속성 |
|---|---|---|
| `r4-common-1.0` | `cod:binSh` | `state` |
| `pb-legacy-1.0` | `pb:binarySwitch` | `state` |
| `r5-long-1.0` | `cod:binarySwitch` | `state` |
| `home-legacy-1.0` | `hd:binarySwitch` | `powerState` |

GatewayBridge 라이브러리의 기존 기본값은 `pb-legacy-1.0`으로 유지한다. 실행 CLI `npm run bridge`는 `r4-common-1.0`을 기본으로 사용하며 `MOBIUS4_SDT_PROFILE`로 대상 CSE의 registry와 일치시킨다. HTTP와 MQTT가 같은 직렬화 함수를 사용한다. v1 계약 파일은 기존 wire 호환 자료, `contracts/oneM2M-test-contract.v2.json`은 canonical wire 계약이다.

```js
encodeBinarySwitch({rn:'lightA',state:false,acpi:['/Mobius/actuatorAcp']}, {operation:'CREATE'});
normalizeBinarySwitch({'pb:binarySwitch':{state:false}}, {sourceVersion:'pb-legacy-1.0'});
```

## Registry와 XSD

```powershell
node pc-mobius/scripts/prepare-specialization.mjs --mobius-root ../mobius4 --config-dir .local/edge-a/config
python pc-mobius/scripts/build-sdt-closure.py
```

`--config-dir`는 인스턴스별 registry와 XSD를 작성할 경로다. 기본 경로는 지정한 Mobius4의 `config`이다. 기존 registry가 있으면 시각별 백업을 생성한다. `--profile pb-legacy-1.0`으로 이전 CSE의 envelope를 재생성한다. 생성 후 해당 CSE를 다시 시작하여 registry를 로드한다.

프로젝트 R4 profile과 공식 R5 SDT 참조는 ZIP에서 가져온 원본을 그대로 보존했다. 공식 R4 CDT는 [oneM2M TS-0004 저장소의 고정 commit](https://git.onem2m.org/XMLSchemas/ts-0004/-/tree/a59a0152ff414a069c2bb7baafb91e84924aea0f)에서 commonTypes와 enumerationTypes를 회수했다. 원본 `geoJsonCoordinates`의 PCRE 재귀 문법·XML entity가 XSD 컴파일을 중단시키므로, `build-sdt-closure.py`가 이 타입만 XSD 1.0의 좌표 배열 패턴으로 바꾼다. 수정 전 원본과 파생본은 각각 `specializations/reference`와 `specializations/r4`에 보존한다.

파생 closure는 binarySwitch 전체 import를 컴파일하고 실제 XML 자원의 필수 boolean state와 문자열 거부를 검사한다. 위경도 범위·배열 중첩 문법을 보존하며 Polygon의 첫/끝점 일치와 최소 정점 수 검증은 GeoJSON 애플리케이션 계층의 책임이다. binarySwitch의 선택 capability는 state RW이며 action·instance와 GeoJSON 데이터 사용 범위는 `lineage.json`에 명시했다. 이 파일은 원본 출처·고정 commit·파일별 SHA-256·수정 범위·컴파일 결과를 기록한다. 재생성에는 Python `lxml` 패키지가 필요하다.

`node --test pc-mobius/test/sdt-adapter.test.mjs`는 profile 변환, false 보존, cnd·envelope 충돌, HTTP/MQTT 직렬화, XSD 해시와 v2 계약을 검사한다. 실제 CSE의 CREATE/UPDATE/RETRIEVE/discovery 응답은 실행 receipt에 별도로 연결한다.
