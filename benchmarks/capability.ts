/** Short-lived, role- and resource-scoped access for isolated experiments. */
export type Capability = {
  id: string;
  role: 'host' | 'sender' | 'reader' | 'writer' | 'relay';
  expiresAt: number;
};
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const decode = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
const key = (secret: string) => crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
  { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export async function signCapability(secret: string, claims: Capability): Promise<string> {
  const body = encode(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(body));
  return body + '.' + encode(new Uint8Array(signature));
}

export async function verifyCapability(secret: string, token: string): Promise<Capability | null> {
  try {
    if (secret.length < 32 || token.length > 1024) return null;
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra !== undefined || !await crypto.subtle.verify('HMAC', await key(secret),
      decode(signature), new TextEncoder().encode(body))) return null;
    const claims = JSON.parse(new TextDecoder().decode(decode(body))) as Capability;
    if (!/^[0-9a-f-]{36}$/.test(claims.id) || !['host', 'sender', 'reader', 'writer', 'relay'].includes(claims.role) ||
        !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= Date.now()) return null;
    return claims;
  } catch { return null; }
}
