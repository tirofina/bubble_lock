import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const target = resolve(process.env.RUN_TMP ?? '.local/deployment');
const domain = process.env.PUBLIC_DOMAIN || 'bubble.localhost';
const gatewayId = process.env.GATEWAY_ID ?? 'gateway-1';
if (!/^[A-Za-z0-9_-]{1,64}$/.test(gatewayId)) throw new TypeError('Invalid GATEWAY_ID');
const port = Number(process.env.HTTPS_PORT ?? 443);
if (!/^[a-z0-9.-]+$/.test(domain) || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new TypeError('PUBLIC_DOMAIN and HTTPS_PORT must be a hostname and valid TCP port');
}
try {
  await access(resolve(target, 'accounts.json'));
  throw new Error(`Existing secrets at ${target}; reuse them or choose a new RUN_TMP`);
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
}
await mkdir(resolve(target, 'pki'), { recursive: true, mode: 0o700 });
const save = (name, value) => writeFile(resolve(target, name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const secret = () => randomBytes(24).toString('base64url');
const origin = new URL(`https://${domain}:${port}`).origin;
const issuer = `${origin}/identity/realms/bubble`;
const clientId = 'bubble-lock-dashboard';
const audience = 'privacy-bubble-api';
const guardian = ['portal:read', 'household:write', 'device:write', 'consent:write', 'grant:write', 'grant:revoke', 'command:request', 'bubble:command', 'incident:write', 'incident:resolve'];
const roles = [
  { role: 'guardian', scopes: guardian },
  { role: 'visitor', scopes: ['portal:read', 'command:request', 'incident:write'] },
  { role: 'operator', scopes: ['portal:read', 'dashboard:read'] },
];
const accounts = roles.map(({ role, scopes }) => ({ role, scopes, username: role, principalId: `${role}-1`, subject: randomUUID(), password: secret() }));
const dbPassword = secret();
const adminPassword = secret();
const clientSecret = secret();
const cseDbPassword = secret();
const cseAdmin = `CAdmin-${secret()}`;
const principals = accounts.map(({ principalId, subject, scopes }) => ({ principalId, oidcIssuer: issuer, oidcSubject: subject, scopes }));
const scopes = [...new Set(roles.flatMap(({ scopes }) => scopes))];
await save('accounts.json', { accounts, adminUsername: 'bootstrap-admin', adminPassword });
await save('postgres.env', `POSTGRES_USER=bubble\nPOSTGRES_DB=bubble\nPOSTGRES_PASSWORD=${dbPassword}\n`);
await save('keycloak.env', `KC_DB_PASSWORD=${dbPassword}\nKC_BOOTSTRAP_ADMIN_USERNAME=bootstrap-admin\nKC_BOOTSTRAP_ADMIN_PASSWORD=${adminPassword}\nKC_HOSTNAME=${origin}/identity\n`);
await save('app.env', `BUBBLE_DATABASE_URL=postgresql://bubble:${dbPassword}@postgres:5432/bubble\nBUBBLE_DATABASE_NAMESPACE=bubble-lock\nBUBBLE_MEC_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`);
await save('cse-db.env', `POSTGRES_DB=mobius\nPOSTGRES_USER=mobius\nPOSTGRES_PASSWORD=${cseDbPassword}\n`);
await save('cse.env', `DB_PW=${cseDbPassword}\nCSE_ADMIN=${cseAdmin}\nGATEWAY_ID=${gatewayId}\n`);
await save('bridge.json', { broker: 'mqtts://mqtt:8883', endpoint: 'https://cse:8443', cseId: 'bubble-cse', identities: [gatewayId] });
await save('realm.json', {
  realm: 'bubble', enabled: true, registrationAllowed: false, resetPasswordAllowed: false,
  sslRequired: 'external', accessTokenLifespan: Number(process.env.ACCESS_TOKEN_LIFESPAN ?? 120),
  ssoSessionIdleTimeout: 1800, ssoSessionMaxLifespan: 28800,
  revokeRefreshToken: true, refreshTokenMaxReuse: 0,
  roles: { realm: roles.map(({ role }) => ({ name: role })) },
  clients: [{
    clientId, enabled: true, publicClient: false, secret: clientSecret,
    standardFlowEnabled: true, directAccessGrantsEnabled: false,
    redirectUris: [`${origin}/api/auth/callback`], webOrigins: [origin],
    attributes: { 'pkce.code.challenge.method': 'S256' },
    defaultClientScopes: scopes,
    protocolMappers: [{
      name: 'subject', protocol: 'openid-connect', protocolMapper: 'oidc-sub-mapper',
      config: { 'access.token.claim': 'true', 'introspection.token.claim': 'true' },
    }, {
      name: 'api-audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper',
      config: { 'included.custom.audience': audience, 'access.token.claim': 'true', 'id.token.claim': 'false' },
    }],
  }],
  clientScopes: scopes.map((name) => ({ name, protocol: 'openid-connect', attributes: { 'include.in.token.scope': 'true' } })),
  users: accounts.map(({ username, subject, password, role }) => ({
    id: subject, username, enabled: true, emailVerified: true,
    firstName: role, lastName: 'Local', email: `${role}@bubble.invalid`,
    realmRoles: [role], credentials: [{ type: 'password', value: password, temporary: false }],
  })),
});
await save('portal.json', {
  oidc: { issuer, clientId, audience, clientSecret, redirectUri: `${origin}/api/auth/callback`, scopes: ['openid', ...scopes], principals },
  api: { baseUrl: 'https://api:8787', caFile: '/run/bubble/pki/ca.pem' },
});
await save('api.json', {
  host: '0.0.0.0', tls: { key: '/run/bubble/pki/api.key', cert: '/run/bubble/pki/api.pem', ca: '/run/bubble/pki/ca.pem' },
  oidc: { issuer, audience, jwksUri: `${issuer}/protocol/openid-connect/certs` },
  principals, receiptPath: '/var/lib/bubble/integration.jsonl',
  households: [{ householdId: 'household-1', name: 'Local acceptance household', ownerId: 'guardian-1', members: [{ principalId: 'visitor-1', role: 'visitor' }] }],
  core: { mec: { autoReconcile: false } },
});
const nginx = await readFile(new URL('./nginx.conf.template', import.meta.url), 'utf8');
await save('nginx.conf', nginx.replaceAll('@HOST@', domain).replaceAll('@HTTPS_PORT@', String(port)));
const pki = resolve(target, 'pki');
await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${pki}/ca.key`, '-out', `${pki}/ca.pem`, '-days', '365', '-subj', '/CN=BubbleLock local deployment CA']);
for (const [name, names, usage] of [['public', `DNS:${domain}`, 'serverAuth'], ['api', 'DNS:api', 'serverAuth'], ['cse-server', 'DNS:cse', 'serverAuth'], ['mqtt', `DNS:${domain},DNS:mqtt`, 'serverAuth'], ['gateway-1', 'DNS:gateway-1', 'clientAuth'], ['cse', 'DNS:cse', 'clientAuth']]) {
  await exec('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${pki}/${name}.key`, '-out', `${pki}/${name}.csr`, '-subj', `/CN=${name === 'gateway-1' ? gatewayId : name}`]);
  await save(`pki/${name}.ext`, `subjectAltName=${names}\nextendedKeyUsage=${usage}\n`);
  await exec('openssl', ['x509', '-req', '-in', `${pki}/${name}.csr`, '-CA', `${pki}/ca.pem`, '-CAkey', `${pki}/ca.key`, '-CAcreateserial', '-out', `${pki}/${name}.pem`, '-days', '30', '-extfile', `${pki}/${name}.ext`]);
}
console.log(JSON.stringify({ status: 'CONFIGURED', directory: target, origin, issuer, accounts: accounts.map(({ role, principalId }) => ({ role, principalId })), secrets: 'accounts.json (do not publish)' }));
