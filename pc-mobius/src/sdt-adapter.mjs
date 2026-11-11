import { createHash } from 'node:crypto';

export const BINARY_SWITCH_CND='org.onem2m.common.moduleclass.binarySwitch';
export const CANONICAL_SDT_PROFILE='r4-common-1.0';
export const SDT_PROFILES=Object.freeze({
  'r4-common-1.0':Object.freeze({envelope:'cod:binSh',state:'state',cnd:BINARY_SWITCH_CND}),
  'pb-legacy-1.0':Object.freeze({envelope:'pb:binarySwitch',state:'state',cnd:BINARY_SWITCH_CND}),
  'r5-long-1.0':Object.freeze({envelope:'cod:binarySwitch',state:'state',cnd:BINARY_SWITCH_CND}),
  'home-legacy-1.0':Object.freeze({envelope:'hd:binarySwitch',state:'powerState',cnd:'org.onem2m.home.moduleclass.binaryswitch'}),
});
const object=(value)=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const commonKeys=new Set(['rn','cnd','acpi','lbl','et','ri','pi','ty','ct','lt','st','cr','cs','mni','mbs','mia','cni','cbs','cnf','at','aa','ast','daci','loc','nl','or','disr']);
function profileOf(profile){if(!Object.hasOwn(SDT_PROFILES,profile))throw Error('명시적인 SDT sourceVersion을 지정하세요.');return SDT_PROFILES[profile];}
function validate(attributes,operation){
  if(!['CREATE','UPDATE','READBACK'].includes(operation)||!object(attributes)||typeof attributes.state!=='boolean')throw Error('SDT state boolean과 operation을 확인하세요.');
  if(Object.keys(attributes).some((key)=>key!=='state'&&!commonKeys.has(key)))throw Error('SDT profile 속성을 확인하세요.');
  if(attributes.cnd!==undefined&&attributes.cnd!==BINARY_SWITCH_CND)throw Error('SDT containerDefinition을 확인하세요.');
  if(operation==='CREATE'&&(typeof attributes.rn!=='string'||!attributes.rn||/[\/\\?#]/.test(attributes.rn)))throw Error('SDT 생성 resourceName을 확인하세요.');
  if(attributes.acpi!==undefined&&(!Array.isArray(attributes.acpi)||!attributes.acpi.length||attributes.acpi.some((value)=>typeof value!=='string'||!value)))throw Error('SDT ACP 경로 배열을 확인하세요.');
  return structuredClone(attributes);
}

export function encodeBinarySwitch(attributes,{profile=CANONICAL_SDT_PROFILE,operation='UPDATE'}={}){
  const target=profileOf(profile);
  const clean=validate(attributes,operation);
  if(operation==='CREATE')clean.cnd=BINARY_SWITCH_CND;
  const {state,...rest}=clean;
  if(rest.cnd!==undefined)rest.cnd=target.cnd;
  return {[target.envelope]:{...rest,[target.state]:state}};
}

export function normalizeBinarySwitch(input,{sourceVersion,operation='UPDATE'}={}){
  const source=profileOf(sourceVersion);
  if(!object(input)||Object.keys(input).length!==1||!object(input[source.envelope]))throw Error('SDT envelope와 sourceVersion을 확인하세요.');
  const { [source.state]:state,...rest }=input[source.envelope];
  if(source.state!=='state'&&Object.hasOwn(rest,'state'))throw Error('SDT state 별칭은 하나로 지정하세요.');
  if(rest.cnd!==undefined){if(rest.cnd!==source.cnd)throw Error('SDT source containerDefinition을 확인하세요.');rest.cnd=BINARY_SWITCH_CND;}
  const envelope=encodeBinarySwitch({...rest,state},{operation});
  const digest=(value)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {envelope,receipt:{type:'SDT_SERIALIZATION',sourceVersion,targetVersion:CANONICAL_SDT_PROFILE,sourceEnvelope:source.envelope,targetEnvelope:'cod:binSh',operation,sourceHash:digest(input),targetHash:digest(envelope)}};
}
