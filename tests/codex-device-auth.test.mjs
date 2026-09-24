import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDeviceLogin, parseDevicePoll, pollCodexDeviceLogin, startCodexDeviceLogin } from '../src/pi/codex-auth/device-auth.ts';

// Protocol tests only; the app always contacts the real OpenAI service.
test('device-code response accepts the server interval and rejects malformed secrets safely', () => {
  assert.deepEqual(parseDeviceLogin({ device_auth_id: 'device', user_code: 'ABCD-EFGH', interval: '5' }), {
    deviceAuthId: 'device', userCode: 'ABCD-EFGH', intervalSeconds: 5,
  });
  for (const value of [null, {}, { device_auth_id: 'secret', user_code: 'code', interval: -1 },
    { device_auth_id: 'secret', user_code: 'code', interval: Infinity },
    { device_auth_id: 12, user_code: 'code', interval: 5 }]) {
    assert.throws(() => parseDeviceLogin(value), (error) => !error.message.includes('secret'));
  }
});

test('device authorization handles pending and slowdown separately from failed and complete', () => {
  assert.deepEqual(parseDevicePoll(403, null), { status: 'pending' });
  assert.deepEqual(parseDevicePoll(404, null), { status: 'pending' });
  assert.deepEqual(parseDevicePoll(400, { error: { code: 'deviceauth_authorization_pending' } }), { status: 'pending' });
  assert.deepEqual(parseDevicePoll(429, { error: 'slow_down' }), { status: 'slow_down' });
  assert.deepEqual(parseDevicePoll(200, { authorization_code: 'one-use', code_verifier: 'verifier' }), {
    status: 'complete', authorizationCode: 'one-use', codeVerifier: 'verifier',
  });
  for (const [status, body] of [[200, {}], [200, { authorization_code: 'secret' }],
    [400, { error: 'access_denied', error_description: 'secret' }], [500, null]]) {
    assert.throws(() => parseDevicePoll(status, body), (error) => !error.message.includes('secret'));
  }
});

test('device polling sends the server-issued codes and cancellation aborts an in-flight request', async (t) => {
  const controller = new AbortController();
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  let requestSignal;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://auth.openai.com/api/accounts/deviceauth/token');
    assert.deepEqual(JSON.parse(options.body), { device_auth_id: 'device', user_code: 'code' });
    requestSignal = options.signal;
    started();
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  });
  const result = pollCodexDeviceLogin({ deviceAuthId: 'device', userCode: 'code', intervalSeconds: 5 }, controller.signal);
  const rejected = assert.rejects(result, { name: 'AbortError' });
  await requestStarted;
  controller.abort();
  await rejected;
  assert.equal(requestSignal.aborted, true);
});

test('already-cancelled device login never sends a request', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Must not call fetch'); });
  const signal = AbortSignal.abort();
  await assert.rejects(startCodexDeviceLogin('client', signal), { name: 'AbortError' });
  await assert.rejects(pollCodexDeviceLogin({ deviceAuthId: 'd', userCode: 'c', intervalSeconds: 5 }, signal), { name: 'AbortError' });
  assert.equal(fetch.mock.callCount(), 0);
});

test('polling respects slow_down and clears its expiry timer after completion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return calls === 1 ? Response.json({ error: 'slow_down' }, { status: 429 })
      : Response.json({ authorization_code: 'code', code_verifier: 'verifier' });
  });
  const result = pollCodexDeviceLogin({ deviceAuthId: 'd', userCode: 'c', intervalSeconds: 1 }, new AbortController().signal);
  // Let the async fetch/JSON response settle before advancing its polling timer.
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.equal((await result).authorizationCode, 'code');
  assert.equal(calls, 2);
});

test('device-code expiry aborts a request that never completes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const result = pollCodexDeviceLogin({ deviceAuthId: 'd', userCode: 'c', intervalSeconds: 5 }, new AbortController().signal);
  const rejected = assert.rejects(result, /sign-in code expired/);
  t.mock.timers.tick(900_000);
  await rejected;
});
