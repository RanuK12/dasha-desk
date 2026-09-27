/**
 * Console sessions.
 *
 * A signed cookie carrying the account id and the id of the credential used to sign
 * in — no server-side session store, and nothing secret inside the cookie. The
 * signature is HMAC-SHA256 over `accountId.credentialId.expiry`, so a tampered or
 * expired cookie fails to verify.
 *
 * Carrying the credential id is what lets revocation take effect immediately: the
 * caller re-checks that the credential is still active on every request. Without it
 * a revoked key would keep its browser session alive until expiry, which makes
 * "revoked" mean two different things for the API and the console.
 *
 * The developer key itself is never stored in the cookie: a stolen cookie grants
 * console access until it expires or the key is revoked, not a usable API credential.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const MAX_AGE_S = 12 * 3600;
const LEGACY_DEV_SECRET = 'dev-session-secret';
// Local runs that omit OCM_SESSION_SECRET get an unpredictable process-local key.
// Their sessions intentionally die on restart. Production should always supply a
// durable secret, but an omitted variable must never fall back to a public string.
const EPHEMERAL_SECRET = randomBytes(32).toString('base64url');

export const effectiveSessionSecret = (configured) =>
  configured && configured !== LEGACY_DEV_SECRET ? configured : EPHEMERAL_SECRET;

const sign = (secret, payload) =>
  createHmac('sha256', effectiveSessionSecret(secret)).update(payload).digest('base64url');

export function issueSession(secret, accountId, credentialId) {
  const expires = Math.floor(Date.now() / 1000) + MAX_AGE_S;
  const payload = `${accountId}.${credentialId}.${expires}`;
  return `${payload}.${sign(secret, payload)}`;
}

export function readSession(secret, token) {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i);
  const given = Buffer.from(token.slice(i + 1), 'utf8');
  const want = Buffer.from(sign(secret, payload), 'utf8');
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  const [accountId, credentialId, expires] = payload.split('.');
  if (!accountId || !credentialId) return null;
  if (!Number.isFinite(Number(expires)) || Number(expires) < Math.floor(Date.now() / 1000)) return null;
  return { accountId, credentialId };
}

/**
 * CSRF token for a session (review P2-9). `SameSite=Strict` on the cookie already
 * stops a classic cross-site form post, but it is one browser policy standing in for
 * a server-side check, and it says nothing about a same-site sibling origin. The
 * token is an HMAC over the session cookie itself under a domain-separated key, so
 * it is stateless like the session, unique to this sign-in, and useless on its own:
 * a page can only render it after the cookie has been verified, and a request can
 * only pass the check by carrying both. A different session's token never matches.
 */
export const csrfToken = (secret, sessionToken) =>
  createHmac('sha256', effectiveSessionSecret(secret)).update(`csrf:${sessionToken}`).digest('base64url');

export function csrfOk(secret, sessionToken, given) {
  if (!sessionToken || typeof given !== 'string' || !given) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(csrfToken(secret, sessionToken), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const cookieHeader = (token, { secure = true } = {}) =>
  `ocm_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE_S}` +
  (secure ? '; Secure' : '');

// Same attributes as the set, so the browser matches and removes the right cookie.
export const clearCookieHeader = ({ secure = true } = {}) =>
  'ocm_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + (secure ? '; Secure' : '');

export function readCookie(header, name = 'ocm_session') {
  for (const part of (header || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/** Parse an HTML form body. Deliberately tiny — the console posts flat forms only. */
export function parseForm(body) {
  const out = {};
  for (const pair of (body || '').split('&')) {
    if (!pair) continue;
    const [k, ...v] = pair.split('=');
    out[decodeURIComponent(k.replace(/\+/g, ' '))] =
      decodeURIComponent(v.join('=').replace(/\+/g, ' '));
  }
  return out;
}
