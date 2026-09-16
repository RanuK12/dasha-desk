/**
 * Console destinations: the developer onboarding guide (/developer, public) and
 * the signed-in account's profile page (/profile, session-gated).
 *
 * /developer is the counterpart to /provider — the link API consumers get. Like
 * /provider it must be readable signed out and must carry no account identity.
 * /profile renders only the signed-in account's own data: a stranger is refused,
 * and one account's page must never name another account.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../gateway/server.mjs';

async function startGateway() {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-destinations-'));
  const gw = await createGateway({
    sessionSecret: 'destinations-secret',
    secureCookies: false,
    ledgerPath: join(dir, 'usage.jsonl'),
    modelAliases: '',
  });
  await new Promise((resolve) => gw.server.listen(0, '127.0.0.1', resolve));
  return { ...gw, base: `http://127.0.0.1:${gw.server.address().port}` };
}

const form = (gw, path, fields, cookie) => fetch(`${gw.base}/console${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(fields),
  redirect: 'manual',
});

const signupCookie = async (gw, email) => {
  const r = await form(gw, '/signup', { email });
  assert.equal(r.status, 200, `signup for ${email} should render the key page`);
  return r.headers.get('set-cookie').split(';')[0];
};

test('the developer guide is public and carries no account identity', async (t) => {
  const gw = await startGateway();
  t.after(() => gw.close());
  // Seed an account so the page has something it could leak.
  await signupCookie(gw, 'owner@example.com');

  const res = await fetch(`${gw.base}/console/developer`, { redirect: 'manual' });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Developers/);
  assert.match(body, /OPENAI_BASE_URL/);
  assert.doesNotMatch(body, /owner@example\.com/, 'must not name any account');
  assert.doesNotMatch(body, /acct_[A-Za-z0-9_-]{6,}|ocm_(live|host)_[A-Za-z0-9_-]{8,}/,
    'must not leak an account id or credential');
});

test('the profile page refuses strangers and shows the signed-in account only', async (t) => {
  const gw = await startGateway();
  t.after(() => gw.close());

  const anon = await fetch(`${gw.base}/console/profile`, { redirect: 'manual' });
  assert.equal(anon.status, 302, 'a stranger gets the landing redirect, not the page');

  const alice = await signupCookie(gw, 'alice@example.com');
  const bob = await signupCookie(gw, 'bob@example.com');

  const page = await (await fetch(`${gw.base}/console/profile`, { headers: { cookie: alice } })).text();
  assert.match(page, /alice@example\.com/);
  assert.doesNotMatch(page, /bob@example\.com/, "one account's page must never name another");
  assert.doesNotMatch(page, /ocm_(live|host)_[A-Za-z0-9_-]{8,}/,
    'the profile summarizes credentials; it never prints a secret');
});
