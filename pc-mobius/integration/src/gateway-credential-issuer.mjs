import { spawn } from 'node:child_process';
import { createHash, createPublicKey, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const run = (binary, args) => new Promise((resolveResult, reject) => {
  const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = []; let size = 0;
  const timeout = setTimeout(() => { child.kill(); reject(new Error('인증서 발급 시간 상한을 확인하세요.')); }, 15000);
  child.stdout.on('data', (data) => { size += data.length; if (size > 65536) child.kill(); else chunks.push(data); });
  child.stderr.resume();
  child.on('error', () => { clearTimeout(timeout); reject(new Error('인증서 발급 도구를 확인하세요.')); });
  child.on('close', (code) => { clearTimeout(timeout); if (code === 0 && size <= 65536) resolveResult(Buffer.concat(chunks)); else reject(new Error('CSR 서명·키·CA 설정을 확인하세요.')); });
});

export class GatewayCredentialIssuer {
  constructor({ caFile, caKeyFile, openssl = 'openssl', validityDays = 1 }) {
    if (!caFile || !caKeyFile || !Number.isSafeInteger(validityDays) || validityDays < 1 || validityDays > 30) throw new Error('서버 CA와 인증서 유효기간을 설정하세요.');
    Object.assign(this, { caFile: resolve(caFile), caKeyFile: resolve(caKeyFile), openssl, validityDays });
  }
  async issue({ csrPem, principalId, aei, registrationId }) {
    if (typeof csrPem !== 'string' || Buffer.byteLength(csrPem) > 8192 || !csrPem.includes('BEGIN CERTIFICATE REQUEST') || !/^[A-Za-z0-9._:-]{1,64}$/.test(principalId) || typeof aei !== 'string' || aei.length > 256 || !/^[a-f0-9]{64}$/.test(registrationId)) throw new Error('등록 CSR와 서버 principal binding을 확인하세요.');
    const directory = await mkdtemp(join(tmpdir(), 'bubble-gateway-csr-'));
    try {
      const csr = join(directory, 'request.pem'), certificate = join(directory, 'certificate.pem'), extensions = join(directory, 'extensions.cnf'), requestConfig=join(directory,'request.cnf');
      await writeFile(csr, csrPem, { mode: 0o600 });
      await writeFile(requestConfig,'[req]\ndistinguished_name=dn\n[dn]\n');
      await run(this.openssl, ['req', '-config', requestConfig, '-in', csr, '-verify', '-noout']);
      const key = createPublicKey(await run(this.openssl, ['req', '-config', requestConfig, '-in', csr, '-pubkey', '-noout']));
      const strong = key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 2048 || key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails.namedCurve === 'prime256v1';
      if (!strong) throw new Error('RSA2048 이상 또는 P-256 CSR을 사용하세요.');
      await writeFile(extensions, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\nsubjectAltName=URI:urn:privacy-bubble:principal:${encodeURIComponent(principalId)},URI:urn:privacy-bubble:ae:${encodeURIComponent(aei)}\n`);
      await run(this.openssl, ['x509', '-req', '-in', csr, '-CA', this.caFile, '-CAkey', this.caKeyFile, '-set_serial', `0x${registrationId.slice(0, 32)}`, '-days', String(this.validityDays), '-sha256', '-subj', `/CN=${principalId}`, '-extfile', extensions, '-out', certificate]);
      const certificatePem = await readFile(certificate, 'utf8'), caPem = await readFile(this.caFile, 'utf8');
      const issued = new X509Certificate(certificatePem), authority = new X509Certificate(caPem);
      if (!authority.ca || issued.ca || !issued.verify(authority.publicKey) || !issued.publicKey.export({ type: 'spki', format: 'der' }).equals(key.export({ type: 'spki', format: 'der' }))) throw new Error('발급 인증서의 CA·공개키 binding을 확인하세요.');
      return { credentialId: createHash('sha256').update(issued.raw).digest('hex'), fingerprint: issued.fingerprint256, certificatePem, caPem, expiresAt: new Date(issued.validTo).toISOString(), authentication: 'mtls', scope: 'AE_BOUND' };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
