import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { once } from 'node:events';

/**
 * Local stand-in for an ETSI MEC sandbox (AdvantEDGE style paths).
 * Every record it produces carries simulation: true. It serves
 * /<sandbox>/<mep>/mec_service_mgmt/v1, /mec_app_support/v2, /location/v2|v3 and /rni/v2.
 */
const seconds = (ms) => ({ seconds: Math.floor(ms / 1000), nanoSeconds: (ms % 1000) * 1e6 });
const json = (response, status, value, headers = {}) => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(value === undefined || status === 204 ? undefined : JSON.stringify(value));
};
async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const LOCATION_COLLECTIONS = {
  v2: { userTracking: 'userTracking', periodic: 'periodic', zone: 'zonalTraffic' },
  v3: { userTracking: 'users', periodic: 'users', zone: 'zones' },
};

export async function startMecSandboxSimulator({ sandboxName = 'sbx-local', mep = 'mep1', locationVersion = 'v3', tls = null, now = () => Date.now(), extraServices = true, host = '127.0.0.1' } = {}) {
  const prefix = `/${[sandboxName, mep].filter(Boolean).join('/')}`;
  const subscriptions = new Map();
  const requests = []; const notifications = []; const readyApps = [];
  const ues = new Map();
  const lastDelivered = new Map();
  let counter = 0;
  const server = tls ? createHttpsServer({ key: tls.key, cert: tls.cert }) : createHttpServer();
  server.listen(0, host); await once(server, 'listening');
  const origin = `${tls ? 'https' : 'http'}://${host}:${server.address().port}`;
  const platformRoot = `${origin}${prefix}`;
  const services = [
    { serInstanceId: 'sim-loc-0001', serName: 'meep-loc-serv', serCategory: { href: 'catalogueHref', id: 'locationId', name: 'Location', version: locationVersion }, version: locationVersion === 'v3' ? '3.1.1' : '2.1.1', state: 'ACTIVE', transportInfo: { id: 'sim-transport-loc', name: 'REST', type: 'REST_HTTP', protocol: 'HTTP', version: '2.0', endpoint: { uris: [`${platformRoot}/location/${locationVersion}/`] } }, serializer: 'JSON', scopeOfLocality: 'MEC_SYSTEM', consumedLocalOnly: false, isLocal: true },
    { serInstanceId: 'sim-rnis-0001', serName: 'meep-rnis', serCategory: { href: 'catalogueHref', id: 'rnisId', name: 'RNI', version: 'v2' }, version: '2.2.1', state: 'ACTIVE', transportInfo: { id: 'sim-transport-rnis', name: 'REST', type: 'REST_HTTP', protocol: 'HTTP', version: '2.0', endpoint: { uris: [`${platformRoot}/rni/v2/`] } }, serializer: 'JSON', scopeOfLocality: 'MEC_SYSTEM', consumedLocalOnly: false, isLocal: true },
  ];
  if (extraServices) services.push(
    { serInstanceId: 'sim-wais-0001', serName: 'meep-wais', serCategory: { href: 'catalogueHref', id: 'waiId', name: 'WAI', version: 'v2' }, version: '2.2.1', state: 'ACTIVE', transportInfo: { id: 'sim-transport-wais', name: 'REST', type: 'REST_HTTP', protocol: 'HTTP', version: '2.0', endpoint: { uris: [`${platformRoot}/wai/v2/`] } }, serializer: 'JSON', scopeOfLocality: 'MEC_SYSTEM', consumedLocalOnly: false, isLocal: true },
    { serInstanceId: 'sim-app-0001', serName: 'meep-app-enablement', serCategory: { href: 'catalogueHref', id: 'appSupportId', name: 'App Enablement', version: 'v2' }, version: '2.2.1', state: 'ACTIVE', transportInfo: { id: 'sim-transport-app', name: 'REST', type: 'REST_HTTP', protocol: 'HTTP', version: '2.0', endpoint: { uris: [`${platformRoot}/mec_app_support/v2/`] } }, serializer: 'JSON', scopeOfLocality: 'MEC_SYSTEM', consumedLocalOnly: false, isLocal: true },
  );

  const expired = (record) => record.expiryMs && record.expiryMs <= now();
  async function deliver(record, body) {
    const entry = { at: new Date(now()).toISOString(), subscriptionId: record.id, service: record.service, type: record.type, callback: record.callbackUrl.replace(/[A-Za-z0-9_-]{43}$/, '[token]'), simulation: true };
    try {
      const response = await fetch(record.callbackUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      entry.status = response.status; await response.arrayBuffer();
    } catch (error) { entry.status = 0; entry.error = error.name; }
    notifications.push(entry);
    lastDelivered.set(record.service, { record, body });
    return entry;
  }

  function locationBody(record, ue, at) {
    const location = { latitude: [ue.lat], longitude: [ue.lon], shape: 2, accuracy: ue.accuracyM ?? 10 };
    const href = `${origin}${record.resourcePath}`;
    if (record.version === 'v3') {
      const base = { timeStamp: seconds(at), address: ue.address, accessPointId: ue.accessPointId, zoneId: ue.zoneId, currentLocation: location, _links: { subscription: { href } } };
      if (record.type === 'zone') return { zoneLocationEventNotification: { notificationType: 'ZoneLocationEventNotification', ...base, userLocationEvent: 'ENTERING_AREA_EVENT' } };
      if (record.type === 'periodic') return { userLocationPeriodicNotification: { notificationType: 'UserLocationPeriodicNotification', ...base, isFinalNotification: false, result: 'SUCCESS' } };
      return { userLocationEventNotification: { notificationType: 'UserLocationEventNotification', ...base, userLocationEvent: 'ENTERING_AREA_EVENT' } };
    }
    if (record.type === 'periodic') return { subscriptionNotification: { callbackData: record.callbackData, timeStamp: seconds(at), terminalLocation: [{ address: ue.address, currentLocation: { latitude: ue.lat, longitude: ue.lon, accuracy: ue.accuracyM ?? 10, timestamp: seconds(at) }, locationRetrievalStatus: 'Retrieved' }], link: [{ rel: 'PeriodicNotificationSubscription', href }] } };
    return { zonalPresenceNotification: { callbackData: record.callbackData, zoneId: ue.zoneId, address: ue.address, interestRealm: 'sim', userEventType: 'ENTERING', currentAccessPointId: ue.accessPointId, timestamp: seconds(at), link: [{ rel: 'UserTrackingSubscription', href }] } };
  }

  async function moveUe(address, { lat, lon, accuracyM = 10, zoneId = 'zone01', accessPointId = 'ap01', at = now() } = {}) {
    const ue = { ...(ues.get(address) ?? {}), address, lat, lon, accuracyM, zoneId, accessPointId, updatedAt: at };
    ues.set(address, ue);
    const sent = [];
    for (const record of subscriptions.values()) {
      if (record.service !== 'Location' || record.address !== address || expired(record)) continue;
      if (record.type === 'zone' && record.zoneId && record.zoneId !== zoneId) continue;
      sent.push(await deliver(record, locationBody(record, ue, at)));
    }
    return sent;
  }

  async function cellChange(address, { srcCellId, trgCellId, hoStatus = 'COMPLETED', at = now() } = {}) {
    const ue = { ...(ues.get(address) ?? { address }), cellId: trgCellId };
    ues.set(address, ue);
    const sent = [];
    for (const record of subscriptions.values()) {
      if (record.service !== 'RNIS' || record.address !== address || expired(record)) continue;
      const plmn = { mcc: '001', mnc: '01' };
      sent.push(await deliver(record, { notificationType: 'CellChangeNotification', associateId: [{ type: 'UE_IPv4_ADDRESS', value: address }], hoStatus, srcEcgi: { plmn, cellId: srcCellId }, trgEcgi: [{ plmn, cellId: trgCellId }], timeStamp: seconds(at), _links: { subscription: { href: `${origin}${record.resourcePath}` } } }));
    }
    return sent;
  }

  function parseLocationSubscription(version, collection, body) {
    const root = body?.userLocationEventSubscription ?? body?.userLocationPeriodicSubscription ?? body?.zoneLocationEventSubscription ?? body?.userTrackingSubscription ?? body?.periodicNotificationSubscription ?? body?.zonalTrafficSubscription;
    if (!root) return null;
    const callbackUrl = typeof root.callbackReference === 'string' ? root.callbackReference : root.callbackReference?.notifyURL;
    const address = Array.isArray(root.address) ? root.address[0] : root.address ?? root.addressList?.[0];
    const type = body.userLocationPeriodicSubscription || body.periodicNotificationSubscription ? 'periodic' : body.zoneLocationEventSubscription || body.zonalTrafficSubscription ? 'zone' : 'userTracking';
    if (!callbackUrl || (type !== 'zone' && !address)) return null;
    return { type, callbackUrl, address, zoneId: root.zoneId ?? null, callbackData: root.callbackReference?.callbackData ?? root.clientCorrelator ?? null, expiryMs: root.expiryDeadline ? root.expiryDeadline.seconds * 1000 : null, version, collection };
  }

  server.on('request', async (request, response) => {
    const url = new URL(request.url, origin);
    const entry = { method: request.method, path: url.pathname, simulation: true }; requests.push(entry);
    try {
      if (!url.pathname.startsWith(`${prefix}/`)) return json(response, 404, { title: 'unknown sandbox' });
      const path = url.pathname.slice(prefix.length);
      if (path === '/mec_service_mgmt/v1/services' && request.method === 'GET') {
        const name = url.searchParams.get('ser_name');
        entry.status = 200; return json(response, 200, services.filter((item) => !name || item.serName === name));
      }
      const single = path.match(/^\/mec_service_mgmt\/v1\/services\/([^/]+)$/);
      if (single && request.method === 'GET') { const item = services.find((service) => service.serInstanceId === single[1]); entry.status = item ? 200 : 404; return json(response, entry.status, item ?? { title: 'not found' }); }
      const ready = path.match(/^\/mec_app_support\/v2\/applications\/([^/]+)\/confirm_ready$/);
      if (ready && request.method === 'POST') { const body = await readJson(request); readyApps.push({ appInstanceId: ready[1], indication: body?.indication }); entry.status = 204; return json(response, 204); }
      const query = path.match(/^\/location\/(v2|v3)\/queries\/users$/);
      if (query && request.method === 'GET') {
        const address = url.searchParams.get('address');
        const ue = ues.get(address);
        entry.status = 200;
        return json(response, 200, { userList: { user: ue?.lat !== undefined ? [{ address, accessPointId: ue.accessPointId, zoneId: ue.zoneId, timestamp: seconds(ue.updatedAt ?? now()), locationInfo: { latitude: [ue.lat], longitude: [ue.lon], shape: 2, accuracy: ue.accuracyM ?? 10 } }] : [] } });
      }
      if (path === '/rni/v2/queries/rab_info' && request.method === 'GET') {
        const address = url.searchParams.get('ue_ipv4_address'); const ue = ues.get(address);
        entry.status = 200; return json(response, 200, { timeStamp: seconds(now()), cellUserInfo: ue?.cellId ? [{ ecgi: { plmn: { mcc: '001', mnc: '01' }, cellId: ue.cellId }, ueInfo: [{ associateId: [{ type: 'UE_IPv4_ADDRESS', value: address }] }] }] : [] });
      }
      const location = path.match(/^\/location\/(v2|v3)\/subscriptions\/([A-Za-z]+)(?:\/([^/]+))?$/);
      const rnis = path.match(/^\/rni\/v2\/subscriptions(?:\/([^/]+))?$/);
      if (location || rnis) {
        const version = location?.[1] ?? 'v2';
        const collection = location ? location[2] : 'subscriptions';
        const id = location ? location[3] : rnis[1];
        if (location && !Object.values(LOCATION_COLLECTIONS[version]).includes(collection)) { entry.status = 404; return json(response, 404, { title: 'unknown collection' }); }
        if (location && version !== locationVersion) { entry.status = 404; return json(response, 404, { title: 'version not served' }); }
        const collectionPath = `${prefix}${location ? `/location/${version}/subscriptions/${collection}` : '/rni/v2/subscriptions'}`;
        if (!id && request.method === 'POST') {
          const body = await readJson(request);
          let record;
          if (location) record = parseLocationSubscription(version, collection, body);
          else if (body?.subscriptionType === 'CellChangeSubscription' && body.callbackReference) record = { type: 'cellChange', callbackUrl: body.callbackReference, address: body.filterCriteriaAssocHo?.associateId?.[0]?.value, expiryMs: body.expiryDeadline ? body.expiryDeadline.seconds * 1000 : null };
          if (!record?.callbackUrl) { entry.status = 400; return json(response, 400, { title: 'subscription body' }); }
          const subscriptionId = `sim-${location ? 'loc' : 'rnis'}-${String(++counter).padStart(4, '0')}`;
          const resourcePath = `${collectionPath}/${subscriptionId}`;
          Object.assign(record, { id: subscriptionId, service: location ? 'Location' : 'RNIS', resourcePath, collectionPath, body, createdAt: now(), updates: 0 });
          subscriptions.set(resourcePath, record);
          const echoed = structuredClone(body);
          const root = Object.values(echoed)[0];
          if (location && root && typeof root === 'object') { root.resourceURL = `${origin}${resourcePath}`; root._links = { self: { href: `${origin}${resourcePath}` } }; }
          else echoed._links = { self: { href: `${origin}${resourcePath}` } };
          entry.status = 201; entry.subscriptionId = subscriptionId;
          return json(response, 201, echoed, { location: `${origin}${resourcePath}` });
        }
        if (!id && request.method === 'GET') {
          const items = [...subscriptions.values()].filter((record) => record.collectionPath === collectionPath && !expired(record));
          entry.status = 200;
          return json(response, 200, location ? { notificationSubscriptionList: { subscription: items.map((record) => ({ href: `${origin}${record.resourcePath}`, subscriptionType: record.type })), resourceURL: { href: `${origin}${collectionPath}` } } } : { _links: { self: { href: `${origin}${collectionPath}` } }, subscription: items.map((record) => ({ href: `${origin}${record.resourcePath}`, subscriptionType: 'CellChangeSubscription' })) });
        }
        const record = subscriptions.get(`${collectionPath}/${id}`);
        if (!record || expired(record)) { if (record) subscriptions.delete(record.resourcePath); entry.status = 404; return json(response, 404, { title: 'subscription not found' }); }
        if (request.method === 'GET') { entry.status = 200; return json(response, 200, { ...record.body, _links: { self: { href: `${origin}${record.resourcePath}` } } }); }
        if (request.method === 'PUT') {
          const body = await readJson(request);
          const next = location ? parseLocationSubscription(version, collection, body) : { callbackUrl: body?.callbackReference, address: body?.filterCriteriaAssocHo?.associateId?.[0]?.value, expiryMs: body?.expiryDeadline ? body.expiryDeadline.seconds * 1000 : null };
          if (!next?.callbackUrl) { entry.status = 400; return json(response, 400, { title: 'subscription body' }); }
          Object.assign(record, { callbackUrl: next.callbackUrl, address: next.address ?? record.address, expiryMs: next.expiryMs, body, updates: record.updates + 1 });
          entry.status = 200; entry.subscriptionId = record.id; return json(response, 200, body);
        }
        if (request.method === 'DELETE') { subscriptions.delete(record.resourcePath); entry.status = 204; entry.subscriptionId = record.id; return json(response, 204); }
      }
      entry.status = 404; return json(response, 404, { title: 'not found' });
    } catch (error) { entry.status = 500; json(response, 500, { title: error.message }); }
  });

  return {
    origin, platformRoot, sandboxName, mep, locationVersion, simulation: true,
    subscriptions, requests, notifications, readyApps, services,
    activeSubscriptions: () => [...subscriptions.values()].filter((record) => !expired(record)).map(({ id, service, type, address, expiryMs, updates }) => ({ id, service, type, address, expiresAt: expiryMs ? new Date(expiryMs).toISOString() : null, updates })),
    moveUe, cellChange,
    /** Re-send the last notification body of a service, optionally to a stale callback (late delivery). */
    async redeliver(service, { callbackUrl = null, patch = null } = {}) {
      const last = lastDelivered.get(service);
      if (!last) return null;
      const body = patch ? patch(structuredClone(last.body)) : last.body;
      return deliver({ ...last.record, callbackUrl: callbackUrl ?? last.record.callbackUrl }, body);
    },
    lastCallback: (service) => lastDelivered.get(service)?.record.callbackUrl ?? null,
    async close() { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); },
  };
}
