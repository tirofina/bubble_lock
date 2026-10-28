# MAX9850 부팅·절전 대기 상태

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · firmware keyring-0.7.0 · implemented / unverified.

헤드폰 DAC의 재생 드라이버는 아직 구현하지 않았다. 이 변경은 현재 사용하지 않는 MAX9850을 mute/shutdown으로 구성하고 읽는 경로다. 부팅·절전의 요청 상태와 공유 I2S 경계를 보완했으며 실제 칩/헤드폰·음량·click/pop·소비전류·종료 동작을 시험하지 않았다. 검증·빌드·flash·실물 실행은 미실행이다.

## 전원과 제어 범위

r18 native PCB에서 U16 DVDD/AVDD/PVDD는 main +3V3다. 스피커 AUX_EN4나 AMP_GATE16이 이 DAC를 끄지 않는다. MCU만 재시작해도 외부 칩 전원이 유지될 수 있으므로 POR 기본값만 가정하지 않는다. ADD가 GND여서 고정7bit 주소0x10을 사용한다. MCLK GPIO13은 재생용으로 설정하지 않는다.

근거는 [MAX9850 제조사 Rev4](https://www.analog.com/media/en/technical-documentation/data-sheets/max9850.pdf)의 Volume/General-Purpose/Enable register와 Powering On/Off 설명 및 native U16 네트다. 제조사 레지스터 설명을 현재 보드의 물리 동작 증거로 대체하지 않는다.

## 작성한 종료 경로

Wire가 시작된 뒤, BLE/passkey 유효 여부와 관계없이 main loop의 I2C 경로로 다음 요청을 한다.

1. General-Purpose0x03을0으로 두어 zero-cross 대기를 끈다. r18의 DAC GPIO는 NC이며 다른 GP 설정도 기본0으로 둔다.
2. Volume0x02에0xBF를 쓴다. MUTE=1/SLEW=0/VOL=0x3F로 full attenuation을 요청한다.
3. 기존 Enable0x05를 읽고 하위 output/DAC enable bit를 지운 값을 쓴다. 읽기에 실패하면0을 시도하며 새 enable bit를 임의로 켜지 않는다.
4. 코드의60µs 간격 후 Enable0x05=0으로 global shutdown을 요청한다. 앞의 I2C가 실패해도 이 시도를 생략하지 않는다.
5. 세 control register를 따로 읽어 General=0/Volume=0xBF/Enable=0인지 확인한다.

configured_off는 이 control register write/readback이 일치했다는 뜻이다. 실제 음향 무음·minimum-volume transient flag·analog settling·click/pop·전류를 측정했다는 뜻이 아니다. 이 간격은 구현 설정이며 측정된 종료 지연이나 실물 무음 보증이 아니다.

기본5초마다 읽기 확인을 한다. 정상 상태에서는 계속 mute를 다시 쓰지 않아 스피커 cue를 불필요하게 끊지 않는다. 읽기 오류·다른 값이면 공유 I2S 허용 flag를 먼저 거두고 다시 종료 시퀀스를 시도한다. 실패 시 무한 polling 대신 다음5초 검사에서 재시도하며 bus scan/reset은 하지 않는다. 개별 Wire 호출에는 기존20ms timeout이 적용되므로 main-loop 지연이 있을 수 있다. GPIO 모터·mute timer를 I2C에 연결하지 않는다.

## 스피커·절전과 연결

MAX9850과 MAX98357A는 data/BCLK/LRCLK를 공유한다. 새 DAC control이 확인되기 전에는 선택형 AudioAlert의 I2S driver를 설치하지 않는다. 이미 설치된 경우에도 audio Permit callback이 atomic 상태를 읽어 새 재생과 계속 재생을 막는다. main도 audio.stop을 요청한다. 회복 뒤 중복 command나 진행 중이던 cue를 다시 실행하지 않으며, 새 승인 명령만 기존 journal/deadline 경로를 따른다. I2S driver 설치 자체의 오류는 자동 재설치를 반복하지 않는다.

절전 진입 전에는 종료 시퀀스를 다시 요청한다. DAC 상태가 불명확하면 절전을 진행하지 않는다. 이 guard는 grant·GPIO readback·중앙 성공 receipt의 의미를 바꾸지 않으며 headphone playback을 지원한다고 표시하지 않는다.

로컬 provisioning의 `KEYRING_MANAGE_HEADPHONE_STANDBY`는 기본1이다.0은 **DAC가 없는 별도 board 구성을 명시적으로 선택할 때**의 bypass이며 I2C와 공유-I2S guard를 적용하지 않는다.0이라고 실제 DAC가 꺼졌다는 뜻은 아니다.

health detail의 sensorValues.headphone은 unmanaged/unknown/configured_off/i2c_error/register_mismatch 중 하나다. off 확인을 못했을 때 sensorValues.audio는 blocked_headphone으로 표시한다. packet 크기와 detail coalescing 정책은 [POWER_MONITOR](POWER_MONITOR.md)를 따른다.

## 미실행 인수 항목

| ID | 남은 확인 | 결과 |
|---|---|---|
| KR-HP-IDLE-01 | 실제 U16 주소·main rail·MUTE/attenuation/output/global-off 순서 | 미실행 |
| KR-HP-IDLE-02 | MCU만 reset·이전 DAC 활성 상태·I2C NACK/읽기 불일치 | 미실행 |
| KR-HP-IDLE-03 | 확인 전 I2S 설치 차단·재생 중 guard·회복 시 cue 재실행 금지 | 미실행 |
| KR-HP-IDLE-04 | 절전·실제 click/pop·출력 전압·음향·standby 전류 | 미실행 |

MAX9850 재생을 추가하려면 MCLK/clocking·volume·출력 선택과 장치 독립 차단을 별도 설계하고 실물 인수해야 한다. 이번에 이 부분을 완료로 표시하지 않았다.
