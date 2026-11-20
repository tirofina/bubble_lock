import type { OidcSessionConfig } from './oidc-session.ts';

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Discovery and token transport share the same HTTPS trust boundary. */
export async function createOidcProvider(config: OidcSessionConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const issuer = new URL(config.issuer);
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.hash || issuer.search) throw new Error('등록된 HTTPS issuer를 확인하세요.');
  const trustedOrigins = new Set([issuer.origin, ...(config.trustedEndpointOrigins ?? [])]);
  for (const origin of trustedOrigins) if (new URL(origin).origin !== origin || new URL(origin).protocol !== 'https:') throw new Error('OIDC endpoint의 HTTPS origin을 등록하세요.');
  const endpoint = (value: unknown) => {
    if (typeof value !== 'string') throw new Error('OIDC endpoint를 확인하세요.');
    const url = new URL(value);
    if (url.protocol !== 'https:' || !trustedOrigins.has(url.origin) || url.username || url.password || url.hash) throw new Error('등록된 OIDC endpoint origin을 사용하세요.');
    return url.href;
  };
  const fetchJson = async (url: string, init: RequestInit = {}) => {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json', ...init.headers } });
    if (!response.ok || !response.body) throw new Error('OIDC 응답을 확인하세요.');
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) throw new Error('OIDC 응답 크기를 확인하세요.');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!object(value)) throw new Error('OIDC JSON 응답을 확인하세요.');
    return value;
  };
  const discovery = await fetchJson(endpoint(config.discoveryUrl ?? `${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`));
  if (discovery['issuer'] !== config.issuer) throw new Error('Discovery issuer 일치를 확인하세요.');
  const authorizationEndpoint = endpoint(discovery['authorization_endpoint']);
  const tokenEndpoint = endpoint(discovery['token_endpoint']);
  const jwksUri = endpoint(discovery['jwks_uri']);
  const endSessionEndpoint = endpoint(discovery['end_session_endpoint']);
  if (!Array.isArray(discovery['response_types_supported']) || !discovery['response_types_supported'].includes('code')
    || !Array.isArray(discovery['code_challenge_methods_supported']) || !discovery['code_challenge_methods_supported'].includes('S256')) throw new Error('Authorization Code와 PKCE S256을 지원하는 IdP를 사용하세요.');
  const authMethod = config.clientSecret ? 'client_secret_basic' : 'none';
  const supportedMethods = discovery['token_endpoint_auth_methods_supported'] ?? ['client_secret_basic'];
  if (!Array.isArray(supportedMethods) || !supportedMethods.includes(authMethod)) throw new Error('등록한 client 인증 방식과 IdP 설정을 맞추세요.');
  const exchange = async (fields: Record<string, string>) => {
    const body = new URLSearchParams({ ...fields, client_id: config.clientId });
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (config.clientSecret) {
      const encode = (value: string) => new URLSearchParams({ key: value }).toString().slice(4);
      headers['Authorization'] = `Basic ${Buffer.from(`${encode(config.clientId)}:${encode(config.clientSecret)}`).toString('base64')}`;
    }
    return fetchJson(tokenEndpoint, { method: 'POST', headers, body: body.toString() });
  };
  return { authorizationEndpoint, endSessionEndpoint, jwksUri, exchange };
}
