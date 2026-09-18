/**
 * In-process rate limiter for the credential-establishing routes (review P1-4).
 *
 * Signup, sign-in, provider enrollment and recovery are the four POSTs that accept a
 * request with no credential and may hand one back. Without a throttle, guessing an
 * `ocm_live_` key or an `ocm_enroll_` code online is bounded only by how fast the
 * gateway answers. This is the smallest thing that changes that: a fixed window per
 * (rule, key), counted in memory, with no dependency and no shared state between
 * gateway processes. There is one process today; if that changes, the limit becomes
 * per-process and the numbers below should be read as "times N".
 *
 * Keys are the caller's address and, where the request names a target (a key, an
 * email), that target as well, so a guess spread across many addresses is still
 * throttled per account. Identifier keys are hashed before they are stored: the map
 * must never hold a submitted secret or an address in plaintext.
 */
import { createHash } from 'node:crypto';

/**
 * Alpha limits. Each is `limit` requests per `windowMs` for one key. The window is
 * fixed, not sliding, so a burst can reach 2x the limit across a boundary; that is
 * fine for what these protect and keeps `Retry-After` exact.
 *
 *   signup_ip      5/min per address. A person creates one account; a script does not.
 *   signin_ip      10/min per address. Mistyping a key a few times is fine; a guess is not.
 *   signin_key     10/min per submitted key prefix, so a distributed guess against one
 *                  prefix collides on a single bucket regardless of source address.
 *   enroll_ip      10/min per address. One install exchanges one code.
 *   recover_ip     10/min per address.
 *   recover_email  3 per 10 minutes per submitted address, counted whether or not that
 *                  address has an account. This sits in front of the existing cap on
 *                  outstanding links per account, and unlike that cap it is visible in
 *                  the response, so it must not depend on the account existing.
 */
export const RATE_LIMITS = Object.freeze({
  signup_ip:     { limit: 5,  windowMs: 60_000 },
  signin_ip:     { limit: 10, windowMs: 60_000 },
  signin_key:    { limit: 10, windowMs: 60_000 },
  enroll_ip:     { limit: 10, windowMs: 60_000 },
  recover_ip:    { limit: 10, windowMs: 60_000 },
  recover_email: { limit: 3,  windowMs: 600_000 },
});

/** Upper bound on tracked (rule, key) pairs; past it the oldest entries go first. */
export const MAX_TRACKED_KEYS = 10_000;

/** How many characters of a submitted key identify its "target" bucket. */
const KEY_PREFIX_CHARS = 16;

/** Hash an identifier so memory never holds the submitted value. */
export const identifierKey = (kind, value) =>
  `${kind}:${createHash('sha256').update(String(value)).digest('base64url').slice(0, 32)}`;

/** The bucket a submitted developer key falls into: its prefix, hashed. */
export const keyPrefixIdentifier = (key) =>
  identifierKey('key', String(key || '').trim().slice(0, KEY_PREFIX_CHARS));

/** The bucket a submitted email falls into: trimmed and lower-cased, hashed. */
export const emailIdentifier = (email) =>
  identifierKey('email', String(email || '').trim().toLowerCase());

/**
 * The address a request came from, for rate-limit keying.
 *
 * `trustProxy` is the number of proxies in front of this process that append to
 * `X-Forwarded-For`. In production that is the ALB, so 1. A client may send its own
 * `X-Forwarded-For` and the ALB appends the address it actually saw AFTER it, so the
 * trustworthy entry is counted from the right, never taken from the front: with one
 * trusted proxy it is the last entry; with two, the one before it. With zero the
 * header is ignored entirely and the socket peer is used, which is correct for a
 * direct connection and for tests.
 */
export function clientIp(req, trustProxy = 0) {
  const hops = Math.max(0, Math.floor(Number(trustProxy) || 0));
  if (hops > 0) {
    const raw = req.headers['x-forwarded-for'];
    const header = Array.isArray(raw) ? raw.join(',') : (raw || '');
    const chain = header.split(',').map((s) => s.trim()).filter(Boolean);
    if (chain.length) {
      const idx = Math.max(0, chain.length - hops);
      return chain[idx].slice(0, 64);
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

export class RateLimiter {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now]   clock, injectable for tests
   * @param {object} [opts.limits]      rule table; defaults to RATE_LIMITS
   * @param {number} [opts.maxKeys]     memory bound on tracked (rule, key) pairs
   */
  constructor({ now = Date.now, limits = RATE_LIMITS, maxKeys = MAX_TRACKED_KEYS } = {}) {
    this.now = now;
    this.limits = limits;
    this.maxKeys = maxKeys;
    this.buckets = new Map();   // `${rule}|${key}` -> { count, resetAt }
    this.lastSweep = 0;
  }

  /**
   * Count one request against `rule` for `key`.
   * Returns `{ ok: true }` or `{ ok: false, retryAfter }` with `retryAfter` in whole
   * seconds (at least 1) until the window opens again.
   */
  hit(rule, key) {
    const spec = this.limits[rule];
    if (!spec) throw new Error(`unknown rate-limit rule "${rule}"`);
    const now = this.now();
    const id = `${rule}|${key}`;
    let b = this.buckets.get(id);
    if (!b || now >= b.resetAt) {
      // A new window is about to be inserted; make room for it first so the map
      // never holds more than maxKeys entries, not even for one request.
      if (b) this.buckets.delete(id);
      this.#sweep(now, /* reserve */ 1);
      b = { count: 0, resetAt: now + spec.windowMs };
      // Appended, so Map order reflects window start; the sweep evicts from the front.
      this.buckets.set(id, b);
    }
    if (b.count >= spec.limit) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
    }
    b.count += 1;
    return { ok: true };
  }

  /**
   * Count one request against several (rule, key) pairs at once. Every bucket is
   * charged, so a request refused by the second rule still counts against the first,
   * and the answer is the longest wait among the rules that refused.
   */
  hitAll(pairs) {
    let retryAfter = 0;
    for (const [rule, key] of pairs) {
      const r = this.hit(rule, key);
      if (!r.ok) retryAfter = Math.max(retryAfter, r.retryAfter);
    }
    return retryAfter ? { ok: false, retryAfter } : { ok: true };
  }

  /** Tracked bucket count, for tests and for a future health line. */
  get size() { return this.buckets.size; }

  /**
   * Bounded memory. Called with `reserve` slots about to be filled: drop expired
   * windows, and if that still leaves no room, drop the oldest live windows, which
   * are the ones nearest to expiry anyway. The expired scan is throttled to once a
   * second when there is room, so a burst does not pay a full pass per request.
   */
  #sweep(now, reserve = 0) {
    const full = this.buckets.size + reserve > this.maxKeys;
    if (!full && now - this.lastSweep < 1000) return;
    this.lastSweep = now;
    for (const [id, b] of this.buckets) {
      if (now >= b.resetAt) this.buckets.delete(id);
    }
    const excess = this.buckets.size + reserve - this.maxKeys;
    if (excess > 0) {
      let n = 0;
      for (const id of this.buckets.keys()) {
        if (n++ >= excess) break;
        this.buckets.delete(id);
      }
    }
  }
}
