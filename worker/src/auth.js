/**
 * Single-user authentication.
 *
 * One password, held as a Worker secret; a signed, expiring cookie afterwards.
 * No user table, no registration — this app has exactly one user, and pretending
 * otherwise would be more code and more attack surface for no benefit.
 *
 * The token is `<expiry>.<hmac>`, signed with SESSION_SECRET. It carries no
 * secrets itself, and a tampered expiry fails the signature check.
 */

const encoder = new TextEncoder();
export const COOKIE_NAME = 'organizer_session';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison, so a wrong signature leaks no timing information. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hashPassword(password, salt) {
  const bits = await crypto.subtle.digest('SHA-256', encoder.encode(`${salt}:${password}`));
  return toHex(bits);
}

export async function createToken(secret, { ttlSeconds = DEFAULT_TTL_SECONDS, now = Date.now() } = {}) {
  const expiry = Math.floor(now / 1000) + ttlSeconds;
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(String(expiry)));
  return `${expiry}.${toHex(signature)}`;
}

/** @returns {Promise<boolean>} */
export async function verifyToken(secret, token, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [expiryPart, signature] = token.split('.');
  const expiry = Number(expiryPart);
  if (!Number.isFinite(expiry)) return false;
  if (expiry * 1000 < now) return false;

  const key = await hmacKey(secret);
  const expected = await crypto.subtle.sign('HMAC', key, encoder.encode(expiryPart));
  return timingSafeEqual(toHex(expected), signature);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name) out[name] = rest.join('=');
  }
  return out;
}

export function sessionCookie(token, { secure = true, ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  const flags = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',                 // unreachable from JS, so XSS cannot lift it
    'SameSite=Lax',             // blocks cross-site form posts
    `Max-Age=${ttlSeconds}`,
  ];
  if (secure) flags.push('Secure');
  return flags.join('; ');
}

export function clearCookie({ secure = true } = {}) {
  return sessionCookie('', { secure, ttlSeconds: 0 });
}

/** True when the request carries a valid session. */
export async function isAuthenticated(request, env) {
  const token = parseCookies(request.headers.get('cookie'))[COOKIE_NAME];
  if (!token) return false;
  return verifyToken(env.SESSION_SECRET, token);
}
