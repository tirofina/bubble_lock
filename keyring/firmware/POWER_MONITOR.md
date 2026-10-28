# INA219 공급 전원 계측

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · firmware keyring-0.6.0 · implemented / unverified.

r18 U15 INA219B의 단발 계측·저전력 대기·오류 처리를 작성했다. 이번에는 제조사 자료와 원본 네트·BOM을 읽고 소스를 편집했으며 코드/장비를 실행하지 않았다. 검증·빌드·전류/전압/전력 측정·calibration·배터리 수명 시험은 미실행이다. 이 문서의 설정·계산식은 측정 결과가 아니다.

## 측정하는 전원

[native PCB](../pcb/r18/privacy_bubble.kicad_pcb)의 R61은 pad1 VREG3V3 /pad2 +3V3이며 U15 DCN pad1 VIN+는 VREG3V3, pad2 VIN-와 pad4 VS는 +3V3다. A0/A1은 GND여서 주소0x40, MCU I2C는 SDA14/SCL21을 사용한다. R61의 nominal0.1Ω은 기존 BOM에서 가져왔다.

이 경로는 **레귤레이터 뒤 3.3V 부하 측**이다. INA219 자체 공급도 shunt 뒤에 연결된다. 배터리 입력/충전 전류·레귤레이터 손실·보드 전체 입력 전력을 직접 측정하는 경로가 아니다. 같은 BOM의 R61 prose는 INA219 supply가 shunt 앞이라고 적지만 U15/C35 설명과 native PCB는 뒤다. 원본 파일은 바꾸지 않고 여기서 차이를 기록했다. R61 Datasheet URL의 품번도 MPN 칸과 다르게 남아 있어 링크를 근거로 실물 저항을 확인했다고 표시하지 않는다.

## 레지스터와 소스 근거

근거는 [TI INA219 SBOS448G Rev.G](https://www.ti.com/lit/ds/symlink/ina219.pdf)의8.3/8.5/8.6 및 로컬 보관본이다. 주소 설정·16bit MSB 우선 전송,10µV shunt step,4mV bus step, signed current와 calibration 관계를 적용했다.

| 값 | 작성한 처리 |
|---|---|
| config0x099B | 16V bus,±80mV shunt, 양쪽12bit, triggered shunt+bus |
| config0x0998 | 같은 range/resolution의 power-down |
| calibration0x4000 | 매 shot에 재설정하고 결과 수신 때 readback |
| bus register0x02 | CNVR 완료 확인·OVF 거절·shift3 후4mV/count |
| shunt/current0x01/0x04 | signed16bit 읽기, 고정 calibration의 일관성 확인 |
| current scaling | `Current_LSB=0.04096/(16384*Rshunt)`; nominal0.1Ω에서25µA/register count |

기존 BOM의0x0985는 shunt-only continuous 설정이다. bus 전압까지 현재 sample pair로 전달하기 위해 그대로 재사용하지 않았다. loadPower는 hardware power register의 unsigned 결과 대신 signed bus/current pair에서 계산한다. bus와 shunt 변환은 시간상 완전히 동시에 이뤄지지 않으며, 이 구현은 순간 peak·평균·누적 energy·배터리 수명을 산출하지 않는다.

register의25µA/count는 실제 정밀도 주장이 아니다. nominal shunt에서10µV ADC step은100µA에 대응하며 저항 오차·offset/gain/noise·배선/실장과 실물 calibration은 미확인이다. µA/µW 정수 표기는 단위/직렬화 방식이며 그 정확도나 분해능의 보증이 아니다.

## 설정과 상태

로컬 provisioning.h의 옵션이다.

| 옵션 | 기본·범위 |
|---|---|
| KEYRING_ENABLE_POWER_MONITOR | 기본1. 값이0이면 driver가 INA219를 건드리지 않음 |
| KEYRING_POWER_SAMPLE_MS | 기본2000ms,100~60000ms |
| KEYRING_POWER_SHUNT_MILLIOHMS | 기본100mΩ,10~1000mΩ 구성 범위. r18에는 nominal100 사용 |

main loop만 Wire를 사용하며 BLE callback·GPIO timer·LCD/SD worker에서 INA219 I/O를 하지 않는다. trigger 후 delay/while로 기다리지 않고 후속 loop에서 완료를 확인한다. 완료 대기100ms 초과는 conversion_timeout이다. I2C 오류·설정 변경 등은 한 번의 best-effort power-down 후5초 backoff로 해당 주소만 재구성한다. I2C bus scan/reset은 없다. 개별 Wire 호출은 기존20ms timeout을 사용하므로 지연될 수 있으며 모터·mute의 별도 타이머를 대체하지 않는다.

OVF·선택 PGA 경계·bus range 경계·current/shunt 불일치·calibration/config 변경·I2C/종료 오류를 정상0으로 바꾸지 않는다. 해당 값은 모두 null이다. 완료한 이전 sample은 다음 변환 중에도 readUptimeMs와 함께 보관하지만 나이가 `2*sample interval+100ms`를 넘으면 stale/null이다. readUptimeMs는 MCU가 결과를 읽고 standby를 확인한 시각이며 ADC의 정확한 변환 시각이나 UTC가 아니다.

enabled monitor가 변환 중이거나 설정을 확인할 수 없으면 절전을 진행하지 않는다. 진입 직전에 power-down write/readback을 요구한다. 명시적으로 driver를 끄면 칩의 기본/기존 상태까지 종료하지 않으므로 disabled만으로 INA219 소비전류가 없다고 가정하지 않는다. 계측값은 새로운 grant·전류 보호 threshold·자동 실행 승인을 만들지 않는다.

## BLE 관측과 화면

512byte READ 한도를 유지하며 sensorValues.detail을 sensors → energy → health 순서로 순환한다. 공통 top-level identity/sequence/uptime/battery/button/state와 sensorValues fault/journal은 모든 프레임에 남긴다.

- sensors: 기존 SOC 관련 voltage·상태, 가속도·motion event.
- energy: [ina219-reading schema](../../contracts/keyring/ina219-reading.schema.json)의 ina219 객체.
- health: journal 사용량, wake/power, audio/display/SD 상태.

ina219는 status/busVoltageMv/currentUa/loadPowerUw/shuntVoltageUv/readUptimeMs를 가진다. ok만 수치이며 다른 상태는 모든 수치·시각이 null이다. current/power는 signed이고 power는 `round(busVoltageMv*currentUa/1000)`의µW다. 반올림은 절댓값 half-up 후 부호를 복원한다. 부호를 배터리 충전 상태로 해석하지 않는다.

기본2초 관측이면 detail은 보통6초마다 반복하지만 버튼/motion 이벤트·전송/backpressure로 달라질 수 있다. 센서 실제 읽기 주기는 notification 발행과 분리했으므로 반복 버튼이 센서 polling 시각을 미루지 않는다. 각 detail별 최신 pending frame을 최대3개 보관하고 publication order로 꺼내 전체 sequence 역전을 막는다. 한 detail만 계속 덮어써지는 것을 줄이며 active frame의20byte LF fragmentation은 유지한다. 어떤 detail 필드의 누락도0/센서 없음/이전 값의 무기한 유효를 뜻하지 않는다. consumer는 bootId/sequence/detail/readUptimeMs를 함께 사용한다.

overflow 때 sensors의 선택 상세나 health의 낮은 우선순위 상태를 줄이고 truncated를 표시한다. 그래도 넘거나 JSON memory가 부족하면 새 최소 frame으로 재구성해 payload_too_large를 표시한다. 실제 battery/button/state/fault/journal을 유지하며 임의의 정상 센서값은 채우지 않는다.

Gateway는 INA219 객체가 있을 때 shape/null·정수 단위·시각 순서·ADC step·signed power 계산을 runtime에서 판정한다. 원본 sensorValues는 native observation cin으로 전달한다. 기존 CORE v1 MQTT telemetry projection은 이 sensor 확장을 싣지 않으므로 CORE 쪽 추가 계약 전에는 그 topic에서 계측값을 기대하지 않는다. 두 LCD profile에는 유효한 공급 전류만 mA로 표시하고, 오래되거나 모르면 --를 표시한다.

## 미실행 인수 항목

| ID | 남은 확인 | 결과 |
|---|---|---|
| KR-POWER-01 | 실물 R61·U15 연결/주소·극성·reference 계측기 calibration | 미실행 |
| KR-POWER-02 | trigger/CNVR/standby·reset/calibration 소실·I2C 실패/backoff | 미실행 |
| KR-POWER-03 | signed current·OVF/PGA/bus 경계·stale/null·단위/반올림 | 미실행 |
| KR-POWER-04 | 측정 주기·ADC/저항 오차·실제 전류/전압/부하 전력·sleep 소비 | 미실행 |
| KR-OBS-DETAIL-01 | 세 detail·긴 ID/최대 정수/overflow에서512byte·sequence·coalescing | 미실행 |
| KR-OBS-DETAIL-02 | 반복 버튼 중 sensor polling·LCD stale·Gateway/native cin 전달 | 미실행 |
