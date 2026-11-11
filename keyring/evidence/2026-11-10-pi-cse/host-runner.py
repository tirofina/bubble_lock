import asyncio
import hashlib
import json
import shutil
import tarfile
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

from tls_fixture import TestPki
from mobius_fixture import DisposableMobius
from helpers import config
from bubble_gateway.transport import TransportHub

root = Path.cwd().parent / '_local/keyring-pi-cse-20261110-02'
root.mkdir(exist_ok=False)
pki = TestPki()
stack = None


async def setup():
    cfg = config()
    cfg.originator, cfg.cse_id, cfg.rvi = stack.admin, stack.cse_id, '4'
    cfg.api_url = cfg.cse_url = stack.origin
    cfg.ca_file, cfg.cert_file, cfg.key_file = pki.path('trusted'), pki.path('client'), pki.path('client', 'key')
    cfg.mqtt_enabled = cfg.core_bridge_enabled = False
    cfg.request_timeout = 5.0
    hub = TransportHub(cfg)
    await hub.start()
    try:
        async with asyncio.timeout(40):
            while True:
                try:
                    rqi = 'ready-' + uuid.uuid4().hex
                    status, headers, _ = await hub._http_json('GET', stack.origin + '/Mobius', headers=hub._m2m_headers(rqi))
                    if status == 200 and hub._response_rsc(status, headers, rqi) == 2000:
                        break
                except Exception:
                    pass
                await asyncio.sleep(.5)
        parent = '/Mobius/pi-feather-' + stack.token[:12]
        rqi = 'prepare-' + uuid.uuid4().hex
        status, headers, body = await hub._http_json('POST', stack.origin + '/Mobius',
            headers=hub._m2m_headers(rqi, create=True) | {'Content-Type': 'application/json;ty=3'},
            body={'m2m:cnt': {'rn': parent.rsplit('/', 1)[1], 'mni': 100}})
        assert (status, hub._response_rsc(status, headers, rqi)) == (201, 2001)
        (root/'provisioning.json').write_text(json.dumps({'container':parent,'httpStatus':status,'rsc':2001},indent=2)+'\n')
        return parent
    finally:
        await hub.close()


try:
    server = root/'server-tls'
    server.mkdir()
    for name in ('trusted.pem', 'server.pem', 'server.key'):
        shutil.copyfile(pki.root/name, server/name)
    stack = DisposableMobius(SimpleNamespace(root=server))
    parent = asyncio.run(setup())
    client = root/'client-tls'
    client.mkdir()
    for name in ('trusted.pem', 'client.pem', 'client.key'):
        shutil.copyfile(pki.root/name, client/name)
    with tarfile.open(root/'pi-client-tls.tar.gz', 'w:gz') as tar:
        for path in client.iterdir():
            info=tar.gettarinfo(str(path), arcname=path.name); info.mode=0o600
            with path.open('rb') as data: tar.addfile(info, data)
    facts={'token':stack.token,'origin':stack.origin,'parent':parent,'images':stack.images,
           'brokerImage':stack.broker.image_id,'containers':stack.containers.copy(),
           'network':stack.network,'mqttContainer':stack.broker.container,'mqttToken':stack.broker.token,
           'serverTlsMountedFiles':sorted(p.name for p in server.iterdir()),
           'clientCertificateSha256':hashlib.sha256((client/'client.pem').read_bytes()).hexdigest()}
    (root/'stack-state.json').write_text(json.dumps(facts,indent=2)+'\n')
    print('STACK_READY',stack.origin,parent,flush=True)
    deadline=time.monotonic()+1800
    while time.monotonic()<deadline and not (root/'STOP').exists():
        time.sleep(1)
finally:
    if stack is not None:
        for name in stack.containers:
            (root/(name+'.log')).write_text(stack.logs(name),encoding='utf-8')
        if stack.broker is not None:
            (root/'broker.log').write_text(stack.broker.logs(),encoding='utf-8')
        stack.close()
        (root/'closed.json').write_text(json.dumps({'ownedStackClosed':True})+'\n')
    pki.close()
    print('STACK_CLOSED',flush=True)
