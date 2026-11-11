import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { encodeBinarySwitch, normalizeBinarySwitch, BINARY_SWITCH_CND } from '../src/sdt-adapter.mjs';
import { GatewayBridge } from '../src/gateway-bridge.mjs';

test('SDT 명시적인 세 가지 legacy profile은 boolean과 ACP를 canonical로 보존한다',()=>{
  for(const profile of ['pb-legacy-1.0','r5-long-1.0','home-legacy-1.0']){
    for(const state of [true,false]){
      const attributes={rn:'light',cnd:BINARY_SWITCH_CND,state,acpi:['/Mobius/acpActuator']};
      const legacy=encodeBinarySwitch(attributes,{profile,operation:'CREATE'});
      const result=normalizeBinarySwitch(legacy,{sourceVersion:profile,operation:'CREATE'});
      assert.deepEqual(result.envelope,{'cod:binSh':attributes});
      assert.equal(result.receipt.sourceVersion,profile);
      assert.match(result.receipt.sourceHash,/^[a-f0-9]{64}$/);
    }
  }
});

test('SDT 버전·envelope·cnd·state 타입 충돌을 검출한다',()=>{
  for(const state of ['false',0,null,undefined])assert.throws(()=>encodeBinarySwitch({state}));
  assert.throws(()=>normalizeBinarySwitch({'pb:binarySwitch':{state:true}}));
  assert.throws(()=>normalizeBinarySwitch({'pb:binarySwitch':{state:true}},{sourceVersion:'r4-common-1.0'}));
  assert.throws(()=>normalizeBinarySwitch({'cod:binSh':{state:true,cnd:'unknown'}},{sourceVersion:'r4-common-1.0'}));
  assert.throws(()=>normalizeBinarySwitch({'hd:binarySwitch':{state:true,powerState:false}},{sourceVersion:'home-legacy-1.0'}));
  assert.throws(()=>encodeBinarySwitch({state:true},{profile:'toString'}));
  assert.throws(()=>encodeBinarySwitch({state:true,unknown:'value'}));
  assert.throws(()=>encodeBinarySwitch({state:true},{operation:'CREATE'}));
});

test('HTTP와 MQTT Gateway 모두 canonical SDT profile을 직렬화한다',async()=>{
  const telemetry={deviceId:'keyring-A',sequence:1,timestamp:'2026-11-10T00:00:00Z',state:false,batteryPct:90,rssiDbm:-67,schemaVersion:'1.0.0'};
  const requests=[];const published=[];
  const mqttClient={publish:async(topic,payload)=>published.push(JSON.parse(payload)),on(){}};
  const http=new GatewayBridge({mqttClient,sdtProfile:'r4-common-1.0',baseUrl:'http://127.0.0.1',originator:'CBridge',fetchImpl:async(url,init)=>{requests.push(JSON.parse(init.body));return{status:200,text:async()=>'{}'};}});
  assert.equal((await http.handleTelemetry(telemetry)).sdtProfile,'r4-common-1.0');
  assert.deepEqual(requests,[{'cod:binSh':{state:false}}]);
  const mqtt=new GatewayBridge({mqttClient,sdtProfile:'r4-common-1.0',oneM2MTransport:'mqtt',originator:'CBridge'});
  await mqtt.handleTelemetry(telemetry);
  assert.deepEqual(published[0].pc,{'cod:binSh':{state:false}});
});

test('RBG-03 canonical 계약과 XSD 원본·파생 import closure SHA-256을 대조한다',async()=>{
  const lineage=JSON.parse(await readFile(new URL('../specializations/lineage.json',import.meta.url),'utf8'));
  for(const entry of lineage.files){
    const bytes=await readFile(new URL(`../${entry.path}`,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256,entry.path);
  }
  assert.equal(lineage.status,'PASS');
  const contract=JSON.parse(await readFile(new URL('../contracts/oneM2M-test-contract.v2.json',import.meta.url),'utf8'));
  for(const step of contract.steps.filter((item)=>item.body?.['cod:binSh']))assert.deepEqual(normalizeBinarySwitch(step.body,{sourceVersion:contract.wireProfile,operation:step.operation}).envelope,step.body);
});
