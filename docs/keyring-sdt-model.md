# SDT model for the keyring

This page defines how the keyring is represented with the oneM2M SDT information
model (TS-0023). It is a specification. On the team server today the home Gateway
writes each keyring observation as a `contentInstance` under
`BubbleLock/gateway-1/observations`, and the living-room switches are the only
flexContainers (SDT `binarySwitch`). The model below is the next deployment step
and uses only ModuleClasses that TS-0023 already defines.

## Source

All names on this page were read from the oneM2M TS-0023 schema repository,
[git.onem2m.org/XMLSchemas/ts-0023](https://git.onem2m.org/XMLSchemas/ts-0023),
at commit `bfd17410668af2966147978b782c9b2583e146ba`. This is the same commit
that [pc-mobius/specializations/lineage.json](../pc-mobius/specializations/lineage.json)
pins for the `binarySwitch` reference schema.

| File in that repository | What it defines |
|---|---|
| `SDT/SDT-TS0023-Devices-Common.xml` | Device `deviceServiceButton`, domain `org.onem2m.common.device` |
| `SDT/SDT-TS0023-ModuleClasses-Common.xml` | ModuleClasses `pushButton`, `battery`, `binarySwitch`, domain `org.onem2m.common.moduleclass` |
| `xsd/cod/COD-dev-deviceServiceButton.xsd` | flexContainer specialization of the device |
| `xsd/cod/COD-mod-pushButton.xsd`, `xsd/cod/COD-mod-battery.xsd` | flexContainer specializations of the ModuleClasses |

## Device and ModuleClasses

TS-0023 describes `pushButton` as follows: "This ModuleClass provides the
capability to indicate the operation of a button style switch. A typical
application can be an SOS button." That is the PANIC button of the keyring.

The device model `deviceServiceButton` contains one mandatory `pushButton` and,
as optional ModuleClasses, `battery`, `connectivity`, `operationMode`,
`textMessage`, `image`, `credentials` and `geoLocation`.

| Resource | containerDefinition | Data points used |
|---|---|---|
| `keyring-<id>` (device) | `org.onem2m.common.device.deviceServiceButton` | none of its own; parent of the ModuleClasses |
| `keyring-<id>/pushButton` | `org.onem2m.common.moduleclass.pushButton` | `pushed` (boolean, mandatory, read-only, eventable), `dataGenerationTime` (timestamp, optional) |
| `keyring-<id>/battery` | `org.onem2m.common.moduleclass.battery` | `level` (integer, percent 0 to 100, mandatory), `lowBattery` (boolean, optional), `dataGenerationTime` (optional) |

We leave `geoLocation` out on purpose. The keyring has no positioning hardware,
and location reaches the CSE only through the MEC IPE, as ciphertext with a
rounded readable value, under its own ACP (`resident-relay-access`). Keeping
location off the device model means a client that may read the button cannot
read where the resident is.

## Mapping from the observation

The firmware observation is defined in
[contracts/keyring/observation.schema.json](../contracts/keyring/observation.schema.json)
and [keyring/INTERFACE_NOTES.md](../keyring/INTERFACE_NOTES.md).

| Observation field | SDT target | Note |
|---|---|---|
| `buttonState: "panic"` | `pushButton.pushed = true` | An UPDATE that subscribers receive as a notification |
| `buttonState: "released"` | `pushButton.pushed = false` | |
| `battery` (0 to 100) | `battery.level` | Skipped when the firmware reports `null` |
| `sensorValues.batteryAlert` | `battery.lowBattery` | |
| `observedAt` (set by the Gateway) | `dataGenerationTime` | |
| `deviceId` | resource name of the device flexContainer | |
| `state` | `binarySwitch.state` | Already an SDT flexContainer in the CORE contract |
| `buttonState: "confirm"` | stays in the `contentInstance` | `deviceServiceButton` has exactly one `pushButton`, and we use it for PANIC |
| `sequence`, `bootId`, `uptimeMs`, `sensorValues.buttonPresses`, RSSI | stay in the `contentInstance` | Needed for ordering, duplicate detection and audit. `signalStrength` requires `lqi`, which a BLE scan does not provide |

The `contentInstance` stream stays as the append-only record. The flexContainers
carry the current state in a form any oneM2M client can find and read.

## Example resources

Long names as in the TS-0023 schema files:

```json
{ "cod:deviceServiceButton": { "rn": "keyring-1", "cnd": "org.onem2m.common.device.deviceServiceButton" } }
```

```json
{ "cod:pushButton": { "rn": "pushButton", "cnd": "org.onem2m.common.moduleclass.pushButton", "pushed": true, "dataGenerationTime": "20261120T081800" } }
```

```json
{ "cod:battery": { "rn": "battery", "cnd": "org.onem2m.common.moduleclass.battery", "level": 87, "lowBattery": false } }
```

On a CSE that uses TS-0023 short names on the wire, the envelope and attribute
names take the short forms from the TS-0023 short-name tables, as our
`binarySwitch` profile does with `cod:binSh`
([SDT notes](../pc-mobius/SDT.md)).

## Discovery

An application finds every SOS-style button without knowing our resource names:

```http
GET /Mobius?fu=1&ty=28&cnd=org.onem2m.common.moduleclass.pushButton
X-M2M-RVI: 4
```

This is the same query form the apps already use for the switches with
`cnd=org.onem2m.common.moduleclass.binarySwitch`.

## Access control

The device flexContainer and its ModuleClasses sit next to the observation
stream and take the ACP of that data flow. On the team server the Gateway
originator holds CREATE and RETRIEVE on its containers (`acop` 3 in
[deployment/provision-cse.mjs](../deployment/provision-cse.mjs)) and the
dashboard reading roles hold RETRIEVE, or RETRIEVE with DISCOVERY (`acop` 2 or
34). The model adds UPDATE for the Gateway on the two ModuleClass resources and
no right for any other originator.

## What deployment needs

1. Two more entries in the Mobius4 specialization registry (the step
   `pc-mobius/scripts/prepare-specialization.mjs` performs for `binarySwitch`),
   with the schema files listed above.
2. The Gateway sends an UPDATE of `pushed` and `level` next to the
   `contentInstance` it already creates, with the same request identifier rule.
3. A receipt on Mobius4 4.25.0: CREATE, UPDATE, RETRIEVE, `cnd` discovery and a
   subscription notification on `pushed`.
