'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const runtime = require('../functions/auth/runtime');

test('auth runtime recognizes anonymous introspection claims', () => {
  assert.equal(runtime.isAnonymousTokenInfo({ sub: 'anon', is_anonymous: true }), true);
  assert.equal(
    runtime.isAnonymousTokenInfo({ sub: 'user', user: { is_anonymous: false }, login_type: 'USERNAME' }),
    false
  );
  assert.equal(runtime.isAnonymousTokenInfo({ sub: 'anon', login_type: 'anonymous' }), true);
});

test('transfer tickets are high entropy and expire after the configured window', () => {
  const first = runtime.createTicket();
  const second = runtime.createTicket();
  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{40,100}$/u);
  const expiresAt = runtime.transferExpiry(1_000);
  assert.equal(runtime.isExpired(expiresAt, 1_000), false);
  assert.equal(runtime.isExpired(expiresAt, 1_000 + runtime.TRANSFER_TTL_MS), true);
});

test('transfer path and body parsing remain strict', () => {
  assert.equal(runtime.getPath({ rawPath: '/api/auth/transfer/start/' }), '/api/auth/transfer/start');
  assert.deepEqual(runtime.parseBody({ body: JSON.stringify({ ticket: 'abc' }) }), { ticket: 'abc' });
  assert.deepEqual(runtime.parseBody({ body: { ticket: 'abc' } }), { ticket: 'abc' });
});
