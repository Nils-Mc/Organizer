/**
 * Tests for session tokens.
 *
 * Security-relevant, so the negative cases matter more than the happy path:
 * an expired token, a tampered expiry, and a forged signature must all fail.
 */
import {
  createToken, verifyToken, parseCookies, sessionCookie, clearCookie,
  hashPassword, isAuthenticated, COOKIE_NAME,
} from '../worker/src/auth.js';

const SECRET = 'test-secret-value';
const NOW = 1_757_000_000_000; // fixed clock

export function runAuthTests(report) {
  const eq = (actual, expected, name) =>
    report(name, JSON.stringify(actual) === JSON.stringify(expected),
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  const ok = (cond, name, detail = 'expected truthy') => report(name, !!cond, detail);

  // ---- cookie parsing ---------------------------------------------------
  eq(parseCookies('a=1; b=2').a, '1', 'parseCookies reads the first value');
  eq(parseCookies('a=1; b=2').b, '2', 'parseCookies reads a later value');
  eq(parseCookies('').x, undefined, 'parseCookies tolerates an empty header');
  eq(parseCookies(null).x, undefined, 'parseCookies tolerates a missing header');
  eq(parseCookies('t=a.b=c').t, 'a.b=c', 'parseCookies keeps "=" inside a value');

  // ---- cookie flags -----------------------------------------------------
  {
    const cookie = sessionCookie('tok');
    ok(cookie.includes('HttpOnly'), 'session cookie is HttpOnly');
    ok(cookie.includes('Secure'), 'session cookie is Secure by default');
    ok(cookie.includes('SameSite=Lax'), 'session cookie is SameSite=Lax');
    ok(cookie.startsWith(`${COOKIE_NAME}=tok`), 'session cookie carries the token');
    ok(!sessionCookie('tok', { secure: false }).includes('Secure'),
      'Secure can be dropped for local http development');
    ok(clearCookie().includes('Max-Age=0'), 'clearCookie expires the cookie immediately');
  }

  return (async () => {
    // ---- password hashing ----------------------------------------------
    {
      const a = await hashPassword('hunter2', 'salt');
      const b = await hashPassword('hunter2', 'salt');
      const c = await hashPassword('hunter2', 'other-salt');
      const d = await hashPassword('hunter3', 'salt');
      eq(a, b, 'hashing is deterministic for the same password and salt');
      ok(a !== c, 'a different salt yields a different hash');
      ok(a !== d, 'a different password yields a different hash');
      eq(a.length, 64, 'hash is a 64-char hex SHA-256');
    }

    // ---- token round trip ------------------------------------------------
    {
      const token = await createToken(SECRET, { now: NOW });
      ok(await verifyToken(SECRET, token, { now: NOW }), 'a fresh token verifies');
      ok(!(await verifyToken('other-secret', token, { now: NOW })),
        'a token does not verify under a different secret');
    }

    // ---- expiry ----------------------------------------------------------
    {
      const shortLived = await createToken(SECRET, { ttlSeconds: 60, now: NOW });
      ok(await verifyToken(SECRET, shortLived, { now: NOW + 30_000 }),
        'a token is valid before it expires');
      ok(!(await verifyToken(SECRET, shortLived, { now: NOW + 120_000 })),
        'an expired token is rejected');
    }

    // ---- tampering -------------------------------------------------------
    {
      const token = await createToken(SECRET, { ttlSeconds: 60, now: NOW });
      const [expiry, signature] = token.split('.');

      // Push the expiry far into the future, keep the original signature.
      const extended = `${Number(expiry) + 100_000}.${signature}`;
      ok(!(await verifyToken(SECRET, extended, { now: NOW })),
        'extending the expiry invalidates the signature');

      const forged = `${expiry}.${'0'.repeat(signature.length)}`;
      ok(!(await verifyToken(SECRET, forged, { now: NOW })), 'a forged signature is rejected');

      const truncated = `${expiry}.${signature.slice(0, -2)}`;
      ok(!(await verifyToken(SECRET, truncated, { now: NOW })),
        'a truncated signature is rejected');
    }

    // ---- malformed input --------------------------------------------------
    for (const [value, label] of [
      [undefined, 'undefined'], [null, 'null'], ['', 'an empty string'],
      ['nodot', 'a token with no separator'], ['abc.def', 'a non-numeric expiry'],
      [12345, 'a non-string'],
    ]) {
      ok(!(await verifyToken(SECRET, value, { now: NOW })), `verifyToken rejects ${label}`);
    }

    // ---- request-level check ----------------------------------------------
    // Browsers forbid setting a Cookie header on a Request, so a real Request
    // would silently drop it here and pass for the wrong reason. A stub keeps
    // this testing our logic rather than the platform's header policy — and
    // makes the suite behave identically in Node and in the browser.
    {
      const env = { SESSION_SECRET: SECRET };
      const requestWithCookie = (cookie) => ({
        headers: { get: (name) => (name.toLowerCase() === 'cookie' ? cookie : null) },
      });

      const token = await createToken(SECRET, { now: Date.now() });
      ok(await isAuthenticated(requestWithCookie(sessionCookie(token)), env),
        'a request with a valid cookie authenticates');
      ok(!(await isAuthenticated(requestWithCookie(null), env)),
        'a request with no cookie does not authenticate');
      ok(!(await isAuthenticated(requestWithCookie(`${COOKIE_NAME}=garbage`), env)),
        'a request with a garbage cookie does not authenticate');

      // An expired token in an otherwise well-formed cookie must also fail.
      const stale = await createToken(SECRET, { ttlSeconds: 1, now: Date.now() - 10_000 });
      ok(!(await isAuthenticated(requestWithCookie(sessionCookie(stale)), env)),
        'a request with an expired cookie does not authenticate');
    }
  })();
}
