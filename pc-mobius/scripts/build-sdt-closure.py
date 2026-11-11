"""R4 원본을 보존하고 명시한 XML Schema 정규식 교정본을 재생성합니다."""
from pathlib import Path
import hashlib
import json
import re
from lxml import etree

ROOT = Path(__file__).resolve().parents[1]
schema_root = ROOT / 'specializations'
source = schema_root / 'reference' / 'CDT-commonTypes-r4.xsd'
text = source.read_text(encoding='utf-8')
# XSD 1.0에는 PCRE의 재귀·이름 캡처 문법이 없다. point 및 최대 3단 중첩 좌표 배열을 명시한다.
ws = r'\s*'
number = r'-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+\-]?[0-9]+)?'
longitude = r'-?((1[0-7][0-9]|[1-9]?[0-9])(\.[0-9]+)?|180(\.0+)?)'
latitude = r'-?(([1-8][0-9]|[0-9])(\.[0-9]+)?|90(\.0+)?)'
point = rf'\[{ws}{longitude}{ws},{ws}{latitude}({ws},{ws}{number})?{ws}\]'
levels = [point]
for _ in range(3):
    child = levels[-1]
    levels.append(rf'\[{ws}{child}({ws},{ws}{child})*{ws}\]')
pattern = '(' + '|'.join(levels) + ')'
replacement = '<xs:simpleType name="geoJsonCoordinates"><xs:restriction base="xs:string"><xs:pattern value="' + pattern + '" /></xs:restriction></xs:simpleType>'
text, count = re.subn(r'<xs:simpleType name="geoJsonCoordinates">.*?</xs:simpleType>', lambda _: replacement, text, count=1, flags=re.S)
assert count == 1
target = schema_root / 'r4' / 'CDT-commonTypes.xsd'
target.write_text(text, encoding='utf-8', newline='\n')
profile = schema_root / 'r4' / 'binarySwitch-r4-profile.xsd'
compiled = etree.XMLSchema(etree.parse(str(profile), etree.XMLParser(no_network=True, resolve_entities=False)))
valid = b'<cod:binSh xmlns:cod="http://www.onem2m.org/xml/protocols/commondomain" resourceName="test"><resourceType>28</resourceType><resourceID>switch1</resourceID><parentID>ae1</parentID><creationTime>20261110T000000</creationTime><lastModifiedTime>20261110T000000</lastModifiedTime><stateTag>0</stateTag><containerDefinition>org.onem2m.common.moduleclass.binarySwitch</containerDefinition><contentSize>5</contentSize><state>false</state></cod:binSh>'
compiled.assertValid(etree.fromstring(valid))
for invalid in [valid.replace(b'<state>false</state>', b'<state>on</state>'),valid.replace(b'<state>false</state>', b'')]:
    assert not compiled.validate(etree.fromstring(invalid))
hash_file = lambda file: hashlib.sha256(file.read_bytes()).hexdigest()
report = {
    'profile':'r4-common-1.0','status':'PASS','scope':'전체 import closure 컴파일 및 boolean state 생성/필수/타입 검사',
    'officialCdtCommit':'a59a0152ff414a069c2bb7baafb91e84924aea0f',
    'officialCdtSource':'https://git.onem2m.org/XMLSchemas/ts-0004/-/tree/a59a0152ff414a069c2bb7baafb91e84924aea0f',
    'officialSdtCommit':'bfd17410668af2966147978b782c9b2583e146ba',
    'corrections':[{'file':'CDT-commonTypes.xsd','type':'geoJsonCoordinates','reason':'원본 XML entity 및 PCRE 전용 문법','implementation':'XSD 1.0 좌표 배열 문법; 좌표 범위·최대 중첩 3단 유지','semanticGate':'Polygon closure/minimum vertices는 위치 서비스의 GeoJSON 검증으로 처리'}],
    'files':[{'path':str(file.relative_to(ROOT)).replace('\\','/'),'sha256':hash_file(file),'bytes':file.stat().st_size} for file in [source, schema_root/'reference'/'COD-mod-binarySwitch.xsd',profile,target,schema_root/'r4'/'CDT-enumerationTypes.xsd']],
    'capabilities':{'state':'mandatory boolean RW','action':False,'instance':False,'geoJsonCoordinates':'해당 binarySwitch profile 외부'},
}
(schema_root/'lineage.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'status':report['status'],'files':len(report['files']),'checks':3},ensure_ascii=False))
