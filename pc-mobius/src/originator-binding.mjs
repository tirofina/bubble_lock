// Certificate identity -> oneM2M AE originator binding (DOC-REV 2.0.0, R10).
//
// Mobius4 authorizes every request by the X-M2M-Origin header (HTTP) or the `fr` field (MQTT) and
// has no authentication layer of its own. A front that terminates mTLS must therefore decide the
// originator itself: one verified client certificate maps to exactly one AE originator, and a
// client-supplied originator that differs from that binding is rejected before the CSE sees it.
import { appendFile, mkdir, readFile, stat, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export const BINDING_TABLE_VERSION = 'privacy-bubble.originator-binding.v1';
const ORIGINATOR = /^[CS][A-Za-z0-9._-]{1,127}$/;
const IDENTITY_VALUE = /^[A-Za-z0-9][A-Za-z0-9 ._:@=+%/-]{0,254}$/;
const BINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const IDENTITY_TYPES = new Set(['uri', 'cn']);

export const REJECTIONS = Object.freeze({
  ORIGINATOR_MISMATCH: { httpStatus: 403, rsc: 4103 },
  ORIGINATOR_HEADER_DUPLICATE: { httpStatus: 403, rsc: 4103 },
  ORIGINATOR_BINDING_NOT_FOUND: { httpStatus: 403, rsc: 4103 },
  ORIGINATOR_BINDING_AMBIGUOUS: { httpStatus: 403, rsc: 4103 },
  ORIGINATOR_BINDING_CERTIFICATE_MISMATCH: { httpStatus: 403, rsc: 4103 },
  ORIGINATOR_BINDING_EXPIRED: { httpStatus: 403, rsc: 4103 },
  CLIENT_CERTIFICATE_UNVERIFIED: { httpStatus: 403, rsc: 4103 },
  BINDING_TABLE_UNAVAILABLE: { httpStatus: 503, rsc: 5000 },
  REQUEST_TARGET_INVALID: { httpStatus: 400, rsc: 4000 },
  METHOD_NOT_ALLOWED: { httpStatus: 405, rsc: 4005 },
  PAYLOAD_TOO_LARGE: { httpStatus: 413, rsc: 4000 },
  UPSTREAM_UNREACHABLE: { httpStatus: 502, rsc: 5103 },
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const originatorDigest = (originator) => sha256(`pb-originator:${originator}`).slice(0, 16);
const invalid = (message) => Object.assign(new Error(`BINDING_TABLE_INVALID: ${message}`), { code: 'BINDING_TABLE_INVALID' });

export function normalizeFingerprint(value) {
  if (typeof value !== 'string') return null;
  const hex = value.replace(/[:\s]/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  return hex.match(/.{2}/g).join(':');
}

export function identityKey(type, value) { return `${type}:${value}`; }

// The table is data written by an operator or a provisioning job. It is validated as a whole so
// that a malformed edit fails closed instead of silently dropping one binding.
export function parseBindingTable(input) {
  const document = typeof input === 'string' || Buffer.isBuffer(input) ? JSON.parse(String(input)) : input;
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw invalid('document');
  if (document.version !== BINDING_TABLE_VERSION) throw invalid('version');
  if (!Number.isInteger(document.revision) || document.revision < 0) throw invalid('revision');
  if (!Array.isArray(document.bindings)) throw invalid('bindings');
  const byIdentity = new Map(); const byOriginator = new Map(); const ids = new Set(); const bindings = [];
  for (const [index, entry] of document.bindings.entries()) {
    if (!entry || typeof entry !== 'object') throw invalid(`bindings[${index}]`);
    const { bindingId, identity, originator, role = null, certificateSha256 = null, notAfter = null, mqttUsername = null } = entry;
    if (typeof bindingId !== 'string' || !BINDING_ID.test(bindingId) || ids.has(bindingId)) throw invalid(`bindings[${index}].bindingId`);
    if (!identity || !IDENTITY_TYPES.has(identity.type) || typeof identity.value !== 'string' || !IDENTITY_VALUE.test(identity.value)) throw invalid(`bindings[${index}].identity`);
    if (typeof originator !== 'string' || !ORIGINATOR.test(originator)) throw invalid(`bindings[${index}].originator`);
    if (role !== null && (typeof role !== 'string' || !BINDING_ID.test(role))) throw invalid(`bindings[${index}].role`);
    const fingerprint = certificateSha256 === null ? null : normalizeFingerprint(certificateSha256);
    if (certificateSha256 !== null && !FINGERPRINT.test(fingerprint ?? '')) throw invalid(`bindings[${index}].certificateSha256`);
    if (notAfter !== null && (typeof notAfter !== 'string' || Number.isNaN(Date.parse(notAfter)))) throw invalid(`bindings[${index}].notAfter`);
    if (mqttUsername !== null && (typeof mqttUsername !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(mqttUsername))) throw invalid(`bindings[${index}].mqttUsername`);
    const key = identityKey(identity.type, identity.value);
    // Exactly one originator per certificate identity.
    if (byIdentity.has(key)) throw invalid(`duplicate identity ${key}`);
    const binding = Object.freeze({ bindingId, identity: Object.freeze({ type: identity.type, value: identity.value }), originator, role, certificateSha256: fingerprint, notAfter, mqttUsername });
    ids.add(bindingId); byIdentity.set(key, binding); bindings.push(binding);
    byOriginator.set(originator, [...(byOriginator.get(originator) ?? []), binding]);
  }
  const usernames = bindings.filter((binding) => binding.mqttUsername).map((binding) => binding.mqttUsername);
  if (new Set(usernames).size !== usernames.length) throw invalid('duplicate mqttUsername');
  const canonical = JSON.stringify({ version: document.version, revision: document.revision, cseId: document.cseId ?? null, bindings });
  return Object.freeze({ version: document.version, revision: document.revision, cseId: document.cseId ?? null, bindings: Object.freeze(bindings), byIdentity, byOriginator, sha256: sha256(canonical) });
}

// Node renders subjectAltName as `URI:a, DNS:b, IP Address:c`; values with separators are JSON quoted.
export function parseSubjectAltName(text) {
  if (typeof text !== 'string' || !text) return [];
  const entries = []; const pattern = /(URI|DNS|IP Address|email|DirName|othername|Registered ID):("(?:[^"\\]|\\.)*"|[^,]*)(?:, |$)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0] === '') break;
    let value = match[2];
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { continue; } }
    entries.push({ type: match[1], value });
  }
  return entries;
}

function commonNames(subject) {
  if (!subject) return [];
  if (typeof subject === 'string') return subject.split(/\n|,(?=[A-Z]+=)/).map((part) => part.trim()).filter((part) => part.startsWith('CN=')).map((part) => part.slice(3));
  const value = subject.CN;
  return value === undefined ? [] : Array.isArray(value) ? value.map(String) : [String(value)];
}

// Accepts tls.TLSSocket#getPeerCertificate() output or a crypto.X509Certificate.
export function certificateIdentities(peer) {
  if (!peer || typeof peer !== 'object') return { uris: [], cns: [], fingerprint256: null };
  const san = parseSubjectAltName(peer.subjectaltname ?? peer.subjectAltName ?? '');
  return {
    uris: san.filter((entry) => entry.type === 'URI').map((entry) => entry.value),
    cns: commonNames(peer.subject),
    fingerprint256: normalizeFingerprint(peer.fingerprint256 ?? ''),
    serialNumber: typeof peer.serialNumber === 'string' ? peer.serialNumber.toUpperCase() : null,
    issuerCN: commonNames(peer.issuer)[0] ?? null,
    validTo: peer.valid_to ?? peer.validTo ?? null,
  };
}

export function resolveBinding(table, peer, { now = Date.now() } = {}) {
  if (!table) return { ok: false, code: 'BINDING_TABLE_UNAVAILABLE' };
  const identities = certificateIdentities(peer);
  const keys = [...identities.uris.map((value) => identityKey('uri', value)), ...identities.cns.map((value) => identityKey('cn', value))];
  const matches = [...new Set(keys.map((key) => table.byIdentity.get(key)).filter(Boolean))];
  if (matches.length === 0) return { ok: false, code: 'ORIGINATOR_BINDING_NOT_FOUND', identities };
  if (matches.length > 1) return { ok: false, code: 'ORIGINATOR_BINDING_AMBIGUOUS', identities };
  const [binding] = matches;
  if (binding.certificateSha256 && binding.certificateSha256 !== identities.fingerprint256) return { ok: false, code: 'ORIGINATOR_BINDING_CERTIFICATE_MISMATCH', binding, identities };
  if (binding.notAfter && Date.parse(binding.notAfter) <= now) return { ok: false, code: 'ORIGINATOR_BINDING_EXPIRED', binding, identities };
  return { ok: true, binding, identities };
}

export function headerValues(rawHeaders, name) {
  const wanted = name.toLowerCase(); const values = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) if (rawHeaders[index].toLowerCase() === wanted) values.push(rawHeaders[index + 1]);
  return values;
}

// Absent or empty -> the bound originator is injected. Equal -> forwarded. Anything else -> rejected.
// `C`/`S` (CSE-assigned AE-ID) also differs from the binding and is rejected: the front pre-assigns.
export function decideOrigin(binding, suppliedValues = []) {
  const values = suppliedValues.filter((value) => value !== undefined);
  if (values.length > 1 || values.some((value) => value.includes(','))) return { ok: false, code: 'ORIGINATOR_HEADER_DUPLICATE', supplied: 'DUPLICATE' };
  const [supplied] = values;
  if (supplied === undefined || supplied.trim() === '') return { ok: true, originator: binding.originator, supplied: 'ABSENT', mode: 'INJECTED' };
  if (supplied.trim() === binding.originator) return { ok: true, originator: binding.originator, supplied: 'MATCHED', mode: 'MATCHED' };
  return { ok: false, code: 'ORIGINATOR_MISMATCH', supplied: 'MISMATCH', suppliedDigest: originatorDigest(supplied.trim()) };
}

export function rejectionBody(code, { auditId, requestId } = {}) {
  const mapping = REJECTIONS[code] ?? REJECTIONS.ORIGINATOR_BINDING_NOT_FOUND;
  return { 'm2m:dbg': `originator binding front rejected the request: ${code}`, 'pb:originatorBinding': { code, rsc: mapping.rsc, httpStatus: mapping.httpStatus, auditId: auditId ?? null, requestId: requestId ?? null } };
}

// Live reload without restart: every request re-checks the file identity (size/mtime/ctime/ino)
// and re-parses on change. A missing or malformed table fails closed.
export class BindingTableSource {
  constructor(path) { this.path = path; this.key = null; this.state = { table: null, error: 'NOT_LOADED' }; this.reloads = 0; }
  async current() {
    let info;
    try { info = await stat(this.path, { bigint: true }); } catch (error) { this.key = null; this.state = { table: null, error: error.code ?? 'STAT_FAILED' }; return this.state; }
    const key = `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    if (key === this.key) return this.state;
    try { this.state = { table: parseBindingTable(await readFile(this.path, 'utf8')), error: null }; }
    catch (error) { this.state = { table: null, error: error.code ?? 'PARSE_FAILED' }; }
    this.key = key; this.reloads += 1; return this.state;
  }
}

export async function writeBindingTable(path, document) {
  parseBindingTable(document);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

// Append-only JSONL with a SHA-256 chain so that a removed or edited row is detectable.
export class HashChainedAudit {
  constructor(path, { clock = () => new Date().toISOString() } = {}) { this.path = path; this.clock = clock; this.queue = Promise.resolve(); this.seq = 0; this.head = 'GENESIS'; this.ready = null; }
  async init() {
    if (!this.ready) this.ready = (async () => {
      await mkdir(dirname(this.path), { recursive: true });
      let text = ''; try { text = await readFile(this.path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const last = text.split('\n').filter(Boolean).at(-1);
      if (last) { const row = JSON.parse(last); this.seq = row.seq; this.head = row.entryHash; }
    })();
    return this.ready;
  }
  append(event) {
    const next = this.queue.then(async () => {
      await this.init();
      const body = { ...event, seq: this.seq + 1, at: this.clock(), prevHash: this.head };
      const entry = { ...body, entryHash: sha256(JSON.stringify(body)) };
      await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
      this.seq = entry.seq; this.head = entry.entryHash; return entry;
    });
    this.queue = next.catch(() => {}); return next;
  }
}

export async function verifyAuditChain(path) {
  const rows = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  let head = 'GENESIS';
  for (const [index, row] of rows.entries()) {
    const { entryHash, ...body } = row;
    if (row.prevHash !== head || row.seq !== index + 1 || sha256(JSON.stringify(body)) !== entryHash) return { ok: false, entries: rows.length, brokenAt: index + 1, head };
    head = entryHash;
  }
  return { ok: true, entries: rows.length, head, rows };
}

// nginx can map only the subject DN ($ssl_client_s_dn). SAN URI and fingerprint pinning stay in the
// Node front; the generated include serves the Pi bench nginx path for CN-identified bindings.
export function renderNginxOriginatorMap(table) {
  const lines = []; const skipped = [];
  for (const binding of table.bindings) {
    if (binding.identity.type !== 'cn') { skipped.push(binding.bindingId); continue; }
    lines.push(`    "CN=${binding.identity.value}" "${binding.originator}";`);
  }
  return { text: `# generated from originator binding table revision ${table.revision} (${table.sha256.slice(0, 16)})\n${lines.join('\n')}\n`, entries: lines.length, skipped };
}
