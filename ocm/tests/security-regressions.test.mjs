import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountExistsError,
  MemoryAccounts,
  normalizeEmail,
} from '../gateway/accounts.mjs';
import { createGateway } from '../gateway/server.mjs';
import { issueSession, readSession } from '../gateway/session.mjs';
import { WsConnection } from '../gateway/ws.mjs';

class FakeSocket extends EventEmitter {
  constructor({ writeResult = true } = {}) {
    super();
    this.destroyed = false;
    this.ended = false;
    this.writeResult = writeResult;
    this.writes = [];
  }

  write(data) {
    this.writes.push(Buffer.from(data));
    return this.writeResult;
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.emit('close');
  }

  setNoDelay() {}
}

function maskedClientFrame(op, payload, { fin = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (data.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | op;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | op;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const masked = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

function lastServerCloseCode(socket) {
  const frame = [...socket.writes].reverse().find((write) => (write[0] & 0x0f) === 0x8);
  assert.ok(frame, 'server must emit a close frame');
  const lengthTag = frame[1] & 0x7f;
  const offset = lengthTag < 126 ? 2 : lengthTag === 126 ? 4 : 10;
  return frame.readUInt16BE(offset);
}

async function listen(gateway) {
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${gateway.server.address().port}`;
}

const form = (base, path, fields) => fetch(`${base}/console${path}`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

test('the old public session fallback cannot forge a current local session', () => {
  // Build the historical value at runtime so the secret scanner does not mistake
  // this negative regression fixture for an active credential.
  const historicalFallback = ['dev', 'session', 'secret'].join('-');
  const token = issueSession(historicalFallback, 'acct_test', 'cred_test');
  const split = token.lastIndexOf('.');
  const payload = token.slice(0, split);
  const signature = token.slice(split + 1);
  const forgedWithKnownString = createHmac('sha256', historicalFallback)
    .update(payload).digest('base64url');

  assert.notEqual(signature, forgedWithKnownString,
    'the historical literal must be replaced with unpredictable process entropy');
  assert.deepEqual(readSession(historicalFallback, token), {
    accountId: 'acct_test',
    credentialId: 'cred_test',
  }, 'the process-local fallback must still support local sessions within one run');
});

test('email labels are normalized but are not account-recovery credentials', async () => {
  assert.equal(normalizeEmail('  Victim@Example.COM  '), 'victim@example.com');
  assert.throws(() => normalizeEmail('not-an-email'), /valid email/);
  assert.throws(() => normalizeEmail('a@b\n.example'), /valid email/);

  const accounts = new MemoryAccounts();
  const account = await accounts.createAccount('Victim@Example.COM');
  await accounts.issue(account.id, 'developer_key', 'first');

  await assert.rejects(
    accounts.createAccount(' victim@example.com '),
    AccountExistsError,
    'knowing an existing email must not reopen the account',
  );
  assert.equal((await accounts.listCredentials(account.id)).length, 1);
});

test('public duplicate signup cannot mint a second key for an existing email', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-duplicate-signup-'));
  const gateway = await createGateway({
    inviteCode: 'potter',
    sessionSecret: 'test-session-secret-not-for-production',
    secureCookies: false,
    ledgerPath: join(dir, 'usage.jsonl'),
    keys: new Map(),
  });
  const base = await listen(gateway);
  try {
    const first = await form(base, '/signup', { email: 'victim@example.com', invite: 'potter' });
    assert.equal(first.status, 200);
    const [account] = await gateway.accounts.listAccounts();
    assert.ok(account);
    assert.equal((await gateway.accounts.listCredentials(account.id)).length, 1);

    const duplicate = await form(base, '/signup', {
      email: '  Victim@Example.COM  ',
      invite: 'potter',
    });
    assert.equal(duplicate.status, 302,
      'duplicate signup must fail closed without a server-error response');
    assert.match(decodeURIComponent(duplicate.headers.get('location') || ''), /cannot be created/i);
    assert.equal(duplicate.headers.get('set-cookie'), null,
      'a rejected duplicate must not receive an authenticated session');
    assert.equal((await gateway.accounts.listCredentials(account.id)).length, 1,
      'the attacker must not get a second key or recovery path');
  } finally {
    await gateway.close();
  }
});

test('socket backpressure does not mean a queued provider job failed', () => {
  const socket = new FakeSocket({ writeResult: false });
  const connection = new WsConnection(socket);
  assert.equal(connection.sendJson({ t: 'job', id: 'one' }), true,
    'Node accepted the bytes into its buffer even when socket.write returned false');
  assert.equal(socket.writes.length, 1);
  assert.equal(socket.ended, false);
});

test('close frames are actually written and the close callback fires once', () => {
  const socket = new FakeSocket();
  const connection = new WsConnection(socket);
  let closes = 0;
  connection.on('close', () => { closes += 1; });

  connection.close(1000, 'done');
  socket.emit('close');

  assert.equal(lastServerCloseCode(socket), 1000);
  assert.equal(closes, 1);
});

test('fragmented messages have a cumulative allocation cap', () => {
  const socket = new FakeSocket();
  const connection = new WsConnection(socket);
  const fiveMiB = Buffer.alloc(5 * 1024 * 1024, 0x61);
  const fourMiB = Buffer.alloc(4 * 1024 * 1024, 0x62);

  socket.emit('data', maskedClientFrame(0x1, fiveMiB, { fin: false }));
  assert.equal(socket.ended, false);
  socket.emit('data', maskedClientFrame(0x0, fourMiB, { fin: true }));

  assert.equal(socket.ended, true);
  assert.equal(lastServerCloseCode(socket), 1009);
});

test('invalid fragmented and binary provider messages are rejected explicitly', () => {
  const interruptedSocket = new FakeSocket();
  const interrupted = new WsConnection(interruptedSocket);
  interruptedSocket.emit('data', maskedClientFrame(0x1, 'part', { fin: false }));
  interruptedSocket.emit('data', maskedClientFrame(0x1, 'new message'));
  assert.equal(lastServerCloseCode(interruptedSocket), 1002);

  const binarySocket = new FakeSocket();
  const binary = new WsConnection(binarySocket);
  binarySocket.emit('data', maskedClientFrame(0x2, Buffer.from([1, 2, 3])));
  assert.equal(lastServerCloseCode(binarySocket), 1003);
  void interrupted;
  void binary;
});

// ---- 2026-09-11 review (docs/REVIEW-BUGS-SPEED-2026-09-11.md), batch 1 ----------------

import { clearCookieHeader } from '../gateway/session.mjs';

async function reviewGateway(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-review-'));
  return createGateway({ secureCookies: false, ledgerPath: join(dir, 'usage.jsonl'), modelAliases: '', grantTokens: 5_000, ...opts });
}

test('P1-5: the admin bearer token cannot sign a console session', async () => {
  const admin = ['admin', 'bearer', 'for-test'].join('-');
  // No sessionSecret given: the old default fell back to the admin token here.
  const gw = await reviewGateway({ adminToken: admin });
  const base = await listen(gw);
  try {
    const acct = await gw.accounts.createAccount('forge@example.test');
    const cred = await gw.accounts.issue(acct.id, 'developer_key', 'k');
    const forged = issueSession(admin, acct.id, cred.id);
    const res = await fetch(`${base}/console/`, { headers: { cookie: `ocm_session=${forged}` }, redirect: 'manual' });
    const body = await res.text();
    assert.doesNotMatch(body, /Your balance|<h2>Credentials<\/h2>|Sign out/, 'a cookie signed with the admin token must not open a dashboard');
    assert.match(body, /Sign in|Create account/, 'the anonymous landing is what it gets');
    // And the admin route itself still works with the real token, and not with a near miss.
    const ok = await fetch(`${base}/admin/accounts`, { method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'made@example.test' }) });
    assert.notEqual(ok.status, 401);
    const near = await fetch(`${base}/admin/accounts`, { method: 'POST', headers: { authorization: `Bearer ${admin}x` }, body: '{}' });
    assert.equal(near.status, 401);
  } finally { await gw.close(); }
});

test('P2-2: an unhandled error answers a generic 500 and never echoes the message', async () => {
  const gw = await reviewGateway({ adminToken: 'adm-' + 'x'.repeat(12), consoleHost: 'console.test.invalid' });
  const base = await listen(gw);
  try {
    gw.ledger.summary = async () => { throw new Error('ECONNREFUSED /var/lib/secret-path'); };
    const res = await fetch(`${base}/console/status`);
    assert.equal(res.status, 500);
    const body = await res.text();
    assert.doesNotMatch(body, /secret-path|ECONNREFUSED/, 'internal detail must stay in the journal');
    assert.match(body, /internal error/);
    // A malformed body on an admin route is the caller's fault, not a 500.
    const bad = await fetch(`${base}/admin/accounts`, { method: 'POST', headers: { authorization: 'Bearer adm-' + 'x'.repeat(12), 'content-type': 'application/json' }, body: '{not json' });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /body must be JSON/);
  } finally { await gw.close(); }
});

test('P2-4: tokens are granted only when a configured invite code matches', async () => {
  const gw = await reviewGateway();   // no inviteCode configured
  const base = await listen(gw);
  try {
    const wrong = await form(base, '/signup', { email: 'typed@example.test', invite: 'anything' });
    assert.equal(wrong.status, 302);
    assert.match(wrong.headers.get('location'), /not\+valid|not%20valid/, 'text in the invite box is refused when no code is configured');
    const plain = await form(base, '/signup', { email: 'plain@example.test' });
    assert.equal(plain.status, 200, 'signup without a code still works');
    const acct = (await gw.accounts.listAccounts()).find((a) => a.email === 'plain@example.test');
    assert.equal(await gw.ledger.balance(acct.id), 0, 'no grant without a configured code');
    const cookie = (plain.headers.get('set-cookie') || '').split(';')[0];
    const dash = await (await fetch(`${base}/console/`, { headers: { cookie } })).text();
    const csrf = dash.match(/name="csrf" value="([^"]+)"/)[1];   // P2-9: signed-in forms carry it
    const redeem = await fetch(`${base}/console/redeem`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ csrf, invite: 'anything' }).toString() });
    assert.equal(redeem.status, 302);
    assert.match(redeem.headers.get('location'), /error=/);
    assert.equal(await gw.ledger.balance(acct.id), 0, 'redeem cannot grant either');
  } finally { await gw.close(); }
});

test('P3-1: clearing the session cookie carries the same Secure attribute as setting it', () => {
  assert.match(clearCookieHeader({ secure: true }), /; Secure$/);
  assert.doesNotMatch(clearCookieHeader({ secure: false }), /Secure/);
  assert.match(clearCookieHeader(), /; Secure$/, 'secure by default, like cookieHeader');
});
