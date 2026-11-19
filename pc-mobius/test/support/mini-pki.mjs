// Hermetic test PKI: P-256 keys and minimal DER X.509 v3 certificates built with node:crypto, so
// the unit tests need no openssl binary. Keys stay in memory and never touch the repository.
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const length = (n) => n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), length(content.length), content]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const explicit = (n, content) => tlv(0xa0 + n, content);
function integer(buffer) { let value = Buffer.from(buffer); while (value.length > 1 && value[0] === 0 && !(value[1] & 0x80)) value = value.subarray(1); if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]); return tlv(0x02, value); }
function oid(dotted) {
  const parts = dotted.split('.').map(Number); const bytes = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) { const stack = []; let value = part; do { stack.unshift(value & 0x7f); value >>= 7; } while (value); bytes.push(...stack.map((byte, index) => index < stack.length - 1 ? byte | 0x80 : byte)); }
  return tlv(0x06, Buffer.from(bytes));
}
const utf8 = (text) => tlv(0x0c, Buffer.from(text, 'utf8'));
function time(date) {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}
const bitString = (bytes, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), bytes]));
const octet = (bytes) => tlv(0x04, bytes);
const name = (cn) => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const extension = (id, critical, value) => seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), octet(value));
const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const EKU = { serverAuth: '1.3.6.1.5.5.7.3.1', clientAuth: '1.3.6.1.5.5.7.3.2' };

function keyIdentifier(spki) {
  // SHA-1 over the subjectPublicKey BIT STRING contents (RFC 5280 4.2.1.2 method 1).
  return createHash('sha1').update(spki.subarray(spki.length - 65)).digest();
}

export function issueCertificate({ subjectCN, issuer = null, ca = false, uris = [], dns = [], ips = [], eku = [], notBefore = new Date(Date.now() - 60000), notAfter = new Date(Date.now() + 86400000) }) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const ski = keyIdentifier(spki);
  const signer = issuer ?? { cn: subjectCN, key: privateKey, ski };
  const extensions = [extension('2.5.29.19', true, ca ? seq(tlv(0x01, Buffer.from([0xff]))) : seq())];
  extensions.push(extension('2.5.29.15', true, ca ? bitString(Buffer.from([0x06]), 1) : bitString(Buffer.from([0x80]), 7)));
  extensions.push(extension('2.5.29.14', false, octet(ski)));
  extensions.push(extension('2.5.29.35', false, seq(tlv(0x80, signer.ski))));
  if (eku.length) extensions.push(extension('2.5.29.37', false, seq(...eku.map((usage) => oid(EKU[usage])))));
  const names = [...uris.map((uri) => tlv(0x86, Buffer.from(uri))), ...dns.map((host) => tlv(0x82, Buffer.from(host))), ...ips.map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number))))];
  if (names.length) extensions.push(extension('2.5.29.17', false, seq(...names)));
  const serial = randomBytes(12); serial[0] &= 0x7f;
  const tbs = seq(explicit(0, integer(Buffer.from([2]))), integer(serial), ECDSA_SHA256, name(signer.cn), seq(time(notBefore), time(notAfter)), name(subjectCN), spki, explicit(3, seq(...extensions)));
  const signature = sign('sha256', tbs, signer.key);
  const der = seq(tbs, ECDSA_SHA256, bitString(signature));
  return { cert: pem('CERTIFICATE', der), key: privateKey.export({ type: 'pkcs8', format: 'pem' }), signer: { cn: subjectCN, key: createPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' })), ski } };
}

export function createTestPki() {
  const ca = issueCertificate({ subjectCN: 'PB-Test-CA', ca: true, notAfter: new Date(Date.now() + 2 * 86400000) });
  const server = issueCertificate({ subjectCN: 'localhost', issuer: ca.signer, dns: ['localhost'], ips: ['127.0.0.1'], eku: ['serverAuth'] });
  const client = (cn, options = {}) => issueCertificate({ subjectCN: cn, issuer: options.issuer ?? ca.signer, uris: options.uris ?? [`urn:privacy-bubble:test:${cn}`], eku: options.eku ?? ['clientAuth'], ...options });
  return { ca, server, client };
}
