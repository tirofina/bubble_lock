// MQTT side of the certificate -> originator binding (DOC-REV 2.0.0, R10).
//
// Mobius4's MQTT binding authorizes by the primitive's `fr` field and uses the topic's originator
// segment only to address the response. Two layers close that gap:
//   1. Mosquitto (TLS 1.3, require_certificate, use_identity_as_username) gives each certificate CN
//      an ACL generated from the binding table: it may publish only /oneM2M/req/<its originator>/...
//      and read only /oneM2M/resp/<its originator>/... . The external listener carries a
//      mount_point, so client topics never reach the CSE's own topic tree directly.
//   2. The guard below relays mounted requests to the CSE only when the payload `fr` equals the
//      topic originator and that originator is bound in the current table (live reload, so a removed
//      binding is denied without broker or CSE restart). Rejections answer with rsc 4103.
import { originatorDigest } from './originator-binding.mjs';

export function topicId(id) {
  const text = String(id);
  const body = text.startsWith('//') ? `:${text.slice(2)}` : text.replace(/^\/+/, '');
  return body.replace(/\//g, ':');
}

export function parseOneM2mTopic(topic) {
  const match = /^\/oneM2M\/(req|resp|reg_req|reg_resp)\/([^/+#]+)\/([^/+#]+)\/(json|cbor|xml)$/.exec(topic);
  return match ? { kind: match[1], originator: match[2], receiver: match[3], serialization: match[4] } : null;
}

// One `user` block per CN-bound binding. Mosquitto 2.0 checks the ACL against the mounted topic
// (mount_point + client topic), so every entry carries the listener mount_point prefix. Read rights
// are enforced at delivery time: a subscription to another originator's response topic is granted
// but receives nothing.
export function renderMosquittoAcl(table, { receivers, serialization = 'json', mountPoint = 'ext/' }) {
  if (!Array.isArray(receivers) || receivers.length === 0) throw new Error('receiver CSE topic ids are required');
  const blocks = []; const skipped = [];
  for (const binding of table.bindings) {
    const username = binding.mqttUsername ?? (binding.identity.type === 'cn' ? binding.identity.value : null);
    if (!username) { skipped.push(binding.bindingId); continue; }
    const originator = topicId(binding.originator);
    const lines = [`# binding ${binding.bindingId}${binding.role ? ` role ${binding.role}` : ''}`, `user ${username}`];
    for (const receiver of receivers.map(topicId)) {
      lines.push(`topic write ${mountPoint}/oneM2M/req/${originator}/${receiver}/${serialization}`);
      lines.push(`topic read ${mountPoint}/oneM2M/resp/${originator}/${receiver}/${serialization}`);
    }
    blocks.push(lines.join('\n'));
  }
  return { text: `# generated from originator binding table revision ${table.revision} (${table.sha256.slice(0, 16)})\n# anonymous and unlisted users receive no topic rights\n\n${blocks.join('\n\n')}\n`, users: blocks.length, skipped };
}

export function renderMosquittoConf({ internalPort, externalPort, caPath, certPath, keyPath, aclPath, mountPoint = 'ext/' }) {
  const path = (value) => String(value).replaceAll('\\', '/');
  return [
    'per_listener_settings true',
    'persistence false',
    'log_dest stdout',
    'log_type error',
    'log_type warning',
    'log_type notice',
    '',
    '# CSE-internal listener: loopback only, used by Mobius4 and the originator guard.',
    `listener ${internalPort} 127.0.0.1`,
    'allow_anonymous true',
    '',
    '# Client listener: TLS 1.3 + client certificate; CN becomes the username for the generated ACL.',
    `listener ${externalPort} 127.0.0.1`,
    `mount_point ${mountPoint}`,
    'allow_anonymous false',
    'require_certificate true',
    'use_identity_as_username true',
    'tls_version tlsv1.3',
    `cafile ${path(caPath)}`,
    `certfile ${path(certPath)}`,
    `keyfile ${path(keyPath)}`,
    `acl_file ${path(aclPath)}`,
    '',
  ].join('\n');
}

export function authorizeMqttRequest({ table, topic, primitive }) {
  const parsed = parseOneM2mTopic(topic);
  if (!parsed || !['req', 'reg_req'].includes(parsed.kind)) return { ok: false, code: 'MQTT_TOPIC_INVALID', parsed };
  if (!table) return { ok: false, code: 'BINDING_TABLE_UNAVAILABLE', parsed };
  // The broker ACL already ties the topic originator segment to the publishing certificate CN.
  // Several CNs may share one originator (certificate rotation), so any active binding suffices.
  const bindings = table.bindings.filter((binding) => topicId(binding.originator) === parsed.originator && (binding.mqttUsername || binding.identity.type === 'cn'));
  if (bindings.length === 0) return { ok: false, code: 'ORIGINATOR_BINDING_NOT_FOUND', parsed };
  const binding = bindings.find((entry) => !entry.notAfter || Date.parse(entry.notAfter) > Date.now());
  if (!binding) return { ok: false, code: 'ORIGINATOR_BINDING_EXPIRED', parsed, binding: bindings[0] };
  if (!primitive || typeof primitive !== 'object' || Array.isArray(primitive)) return { ok: false, code: 'MQTT_PRIMITIVE_INVALID', parsed, binding };
  if (primitive.fr !== undefined && primitive.fr !== '' && primitive.fr !== binding.originator) return { ok: false, code: 'ORIGINATOR_MISMATCH', parsed, binding, suppliedDigest: originatorDigest(String(primitive.fr)) };
  return { ok: true, parsed, binding, primitive: { ...primitive, fr: binding.originator }, mode: primitive.fr ? 'MATCHED' : 'INJECTED' };
}

export async function startMqttOriginatorGuard({ client, receivers, mountPoint = 'ext/', tableSource, audit, maxPayloadBytes = 256 * 1024 }) {
  const ids = receivers.map(topicId);
  const stats = { forwarded: 0, rejected: 0, responses: 0 };
  const respond = (parsed, body) => client.publishAsync(`${mountPoint}/oneM2M/${parsed.kind === 'reg_req' ? 'reg_resp' : 'resp'}/${parsed.originator}/${parsed.receiver}/json`, JSON.stringify(body), { qos: 1 });
  client.on('message', async (topic, payload) => {
    try {
      if (topic.startsWith(mountPoint)) {
        const inner = topic.slice(mountPoint.length);
        const state = await tableSource.current();
        let primitive = null;
        try { primitive = payload.length <= maxPayloadBytes ? JSON.parse(payload.toString('utf8')) : null; } catch { primitive = null; }
        const decision = authorizeMqttRequest({ table: state.table, topic: inner, primitive });
        const base = { event: 'MQTT_REQUEST', topicKind: decision.parsed?.kind ?? null, receiver: decision.parsed?.receiver ?? null, requestId: typeof primitive?.rqi === 'string' ? primitive.rqi.slice(0, 128) : null, op: Number.isInteger(primitive?.op) ? primitive.op : null, bindingId: decision.binding?.bindingId ?? null, role: decision.binding?.role ?? null, tableRevision: state.table?.revision ?? null };
        if (!decision.ok) {
          stats.rejected += 1;
          const entry = await audit.append({ ...base, decision: 'REJECTED', code: decision.code, rsc: 4103, ...(decision.suppliedDigest ? { suppliedOriginatorDigest: decision.suppliedDigest } : {}) });
          if (decision.parsed) await respond(decision.parsed, { rqi: primitive?.rqi, rvi: primitive?.rvi ?? '4', rsc: 4103, pc: { 'm2m:dbg': `originator binding guard rejected the request: ${decision.code}`, 'pb:originatorBinding': { code: decision.code, auditId: entry.entryHash.slice(0, 16) } } });
          return;
        }
        stats.forwarded += 1;
        await audit.append({ ...base, decision: 'FORWARDED', mode: decision.mode, originatorDigest: originatorDigest(decision.binding.originator) });
        await client.publishAsync(inner, JSON.stringify(decision.primitive), { qos: 1 });
        return;
      }
      const parsed = parseOneM2mTopic(topic);
      if (parsed && ['resp', 'reg_resp'].includes(parsed.kind) && ids.includes(parsed.receiver)) {
        stats.responses += 1;
        await client.publishAsync(`${mountPoint}${topic}`, payload, { qos: 1 });
      }
    } catch (error) {
      await audit.append({ event: 'MQTT_GUARD_ERROR', decision: 'REJECTED', code: String(error?.code ?? 'ERROR') }).catch(() => {});
    }
  });
  const subscriptions = ids.flatMap((receiver) => [
    `${mountPoint}/oneM2M/req/+/${receiver}/json`, `${mountPoint}/oneM2M/reg_req/+/${receiver}/json`,
    `/oneM2M/resp/+/${receiver}/json`, `/oneM2M/reg_resp/+/${receiver}/json`,
  ]);
  const granted = await client.subscribeAsync(subscriptions, { qos: 1 });
  if (granted.some((grant) => grant.qos > 2)) throw new Error('guard subscription refused');
  return { stats, subscriptions, close: () => client.endAsync() };
}
