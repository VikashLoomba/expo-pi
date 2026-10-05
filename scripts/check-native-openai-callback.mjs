#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/check-native-openai-callback.mjs [--port METRO_PORT]\n\n'
    + 'Requires the foreground iOS simulator development build containing PiOAuthCallback, connected to Metro.\n'
    + 'Checks expo-device isDevice === false before any native listener operation. No physical device execution.\n'
    + 'Exercises the real Swift TCP listener through Expo Agent CLI and loopback-only Node TCP clients.\n'
    + 'Uses synthetic states and codes, no account, token exchange, browser, or external network requests.\n'
    + 'Port 1455 must be free initially. Does not start, install, reload, or launch the application.');
  process.exit(0);
}
let metroPort = '8081';
for (let index = 0; index < args.length; index += 2) {
  if (args[index] !== '--port' || !/^\d+$/.test(args[index + 1] ?? '')
    || Number(args[index + 1]) < 1 || Number(args[index + 1]) > 65535) {
    throw new Error('Invalid option. Use --help.');
  }
  metroPort = args[index + 1];
}

const namespace = `__piNativeCallbackProbe_${randomUUID().replaceAll('-', '')}`;
const callbackPort = 1455;
const redirectUri = `http://127.0.0.1:${callbackPort}/auth/callback`;
const clientId = 'synthetic-client';

// This function is serialized into Hermes. Each later operation requires its
// isolated context, so accidentally selecting a different runtime fails closed.
async function nativeProbe({ namespace, operation, state, name, sessionName }) {
  if (operation === 'initialize') {
    const modules = globalThis.__r?.getModules?.();
    if (!modules) throw new Error('Metro development module registry unavailable.');
    function requireOne(suffixes) {
      const ids = [];
      for (const [id, module] of modules) {
        const path = (module.verboseName || '').replace(/\\/g, '/');
        if (suffixes.some((suffix) => path === suffix || path.endsWith(`/${suffix}`))) ids.push(id);
      }
      if (ids.length !== 1) throw new Error('Required native probe module is not uniquely loaded.');
      return globalThis.__r(ids[0]);
    }
    // ExpoDevice is autolinked even when the app does not import its JS wrapper.
    const device = requireOne(['expo/build/Expo.js', 'expo/src/Expo.ts']).requireNativeModule('ExpoDevice');
    if (device.isDevice !== false || !['iOS', 'iPadOS'].includes(device.osName)) {
      throw new Error('This verification is restricted to an iOS simulator.');
    }
    const callback = requireOne(['modules/pi-oauth-callback/src/PiOAuthCallbackModule.ts']).default;
    if (!callback || typeof callback.start !== 'function' || typeof callback.waitForCallback !== 'function'
      || typeof callback.stop !== 'function') throw new Error('Rebuild the simulator with PiOAuthCallback first.');
    if (globalThis[namespace]) throw new Error('Validation namespace already exists.');
    globalThis[namespace] = { callback, sessions: {}, waits: {} };
    return { simulator: true, platform: device.osName };
  }
  const context = globalThis[namespace];
  if (!context) throw new Error('The simulator validation runtime changed or was not initialized.');
  const { callback, sessions, waits } = context;
  if (operation === 'start') {
    try {
      const id = await callback.start(state);
      sessions[name] = id;
      return { started: true, validSessionId: typeof id === 'string' && id.length > 0 };
    } catch {
      return { started: false };
    }
  }
  if (operation === 'wait') {
    if (!sessions[sessionName] || waits[name]) throw new Error('Invalid validation waiter.');
    const result = { status: 'pending', deliveries: 0 };
    waits[name] = result;
    void callback.waitForCallback(sessions[sessionName]).then(
      (url) => { result.status = 'resolved'; result.url = url; result.deliveries += 1; },
      () => { result.status = 'rejected'; result.deliveries += 1; },
    );
    return { registered: true };
  }
  if (operation === 'snapshot') {
    return { waits };
  }
  if (operation === 'stop') {
    if (!sessions[sessionName]) throw new Error('Unknown validation session.');
    await callback.stop(sessions[sessionName]);
    return { stopped: true };
  }
  if (operation === 'cleanup') {
    let stopped = true;
    for (const id of Object.values(sessions)) {
      try { await callback.stop(id); } catch { stopped = false; }
    }
    delete globalThis[namespace];
    return { stopped };
  }
  throw new Error('Unknown validation operation.');
}

async function evaluate(operation, parameters = {}) {
  const expression = `(${nativeProbe.toString()})(${JSON.stringify({ namespace, operation, ...parameters })})`;
  let output;
  try {
    ({ stdout: output } = await runFile('npx', ['--yes', '@expo/agent-cli', 'runtime:eval', expression,
      '--platform', 'ios', '--port', metroPort, '--json', '--timeout', '15s'], {
      cwd: projectRoot, encoding: 'utf8', timeout: 25_000, maxBuffer: 1024 * 1024,
    }));
  } catch {
    throw new Error(`Simulator runtime ${operation} failed; keep the rebuilt development app foreground and connected to Metro.`);
  }
  let report;
  try { report = JSON.parse(output); } catch { throw new Error('Expo Agent CLI returned no JSON report.'); }
  if (report.threw || report.promise?.state === 'rejected' || report.value == null) {
    throw new Error(`Simulator runtime ${operation} rejected. Check that this is an iOS simulator with the rebuilt callback module.`);
  }
  return report.value;
}

function request(target, { host = `127.0.0.1:${callbackPort}`, method = 'GET', headers = '' } = {}) {
  return `${method} ${target} HTTP/1.1\r\nHost: ${host}\r\n${headers}Connection: close\r\n\r\n`;
}

// Only 127.0.0.1 is ever dialed. The simulator shares the host's loopback network.
function exchange(parts, { timeout = 5_000, allowReset = false, fragmentDelay = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: callbackPort });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const deadline = setTimeout(() => finish(new Error('Loopback TCP response timed out.')), timeout);
    socket.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) finish(new Error('Unexpectedly large callback response.'));
      else chunks.push(chunk);
    });
    socket.on('end', () => finish());
    socket.on('close', () => finish());
    socket.on('error', (error) => {
      if (allowReset && error.code === 'ECONNRESET') finish();
      else finish(new Error(`Loopback TCP failed (${error.code ?? 'unknown'}).`));
    });
    socket.once('connect', async () => {
      for (let index = 0; index < parts.length && !settled; index += 1) {
        socket.write(parts[index]);
        if (index < parts.length - 1) await delay(fragmentDelay);
      }
    });
  });
}

function assertRejected(response, label) {
  assert.match(response, /^HTTP\/1\.[01] 4\d\d\b/, `${label} should receive an HTTP client error`);
}
function assertSuccess(response, code, state) {
  assert.match(response, /^HTTP\/1\.[01] 200\b/);
  assert.match(response, /\r\nconnection:\s*close\s*\r\n/i);
  assert.match(response, /\r\ncache-control:[^\r\n]*no-store/i);
  assert.match(response, /\r\ncontent-type:\s*text\/html/i);
  assert.ok(!response.includes(code) && !response.includes(state), 'Callback HTML must not echo code or state');
  const [header, body] = response.split('\r\n\r\n');
  const length = header.match(/\r\ncontent-length:\s*(\d+)/i);
  assert.ok(length, 'Response should delimit its body with Content-Length');
  assert.equal(Number(length[1]), Buffer.byteLength(body));
}
async function start(name, state) {
  assert.deepEqual(await evaluate('start', { name, state }), { started: true, validSessionId: true });
}
async function wait(name, sessionName) {
  assert.deepEqual(await evaluate('wait', { name, sessionName }), { registered: true });
}
async function snapshot() { return (await evaluate('snapshot')).waits; }
async function stop(sessionName) {
  assert.deepEqual(await evaluate('stop', { sessionName }), { stopped: true });
}

const checks = {};
let initialized = false;
let collisionServer;
let failure;
try {
  console.error('Checking simulator identity and the native callback module.');
  checks.simulator = await evaluate('initialize');
  initialized = true;
  const state = `synthetic-${randomUUID()}`;
  const code = `synthetic-code-${randomUUID()}`;
  await start('validation', state);
  await wait('validation', 'validation');

  const { stdout: bound } = await runFile('lsof', ['-nP', '-a', '-iTCP:1455', '-sTCP:LISTEN', '-Fn'], {
    encoding: 'utf8', timeout: 5_000,
  });
  const addresses = bound.split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1));
  assert.ok(addresses.length > 0, 'The simulator listener must be observable');
  assert.ok(addresses.every((address) => address === '127.0.0.1:1455'), 'Listener must bind only the explicit IPv4 loopback address');
  checks.loopbackBinding = addresses;

  console.error('Checking rejected requests, fragmented HTTP, and callback privacy.');
  const callbackTarget = `/auth/callback?code=${code}&state=${state}&client_id=${clientId}`;
  const rejected = [
    ['wrong_host', request(callbackTarget, { host: 'example.invalid:1455' })],
    ['wrong_path', request(`/wrong?code=${code}&state=${state}&client_id=${clientId}`)],
    ['wrong_state', request(`/auth/callback?code=${code}&state=incorrect&client_id=${clientId}`)],
    ['duplicate_state', request(`${callbackTarget}&state=${state}`)],
    ['duplicate_code', request(`${callbackTarget}&code=duplicate`)],
    ['duplicate_client', request(`${callbackTarget}&client_id=${clientId}`)],
    ['missing_client', request(`/auth/callback?code=${code}&state=${state}`)],
    ['wrong_method', request(callbackTarget, { method: 'POST' })],
  ];
  for (const [label, raw] of rejected) {
    assertRejected(await exchange([raw]), label);
    checks[label] = true;
  }
  const oversized = await exchange([request(callbackTarget, { headers: `X-Fill: ${'x'.repeat(64 * 1024)}\r\n` })], { allowReset: true });
  if (oversized) assertRejected(oversized, 'oversized_header');
  checks.oversizedHeader = true;
  const slowStart = Date.now();
  const slowResponse = await exchange(['GET /auth/callback?'], { timeout: 8_000, allowReset: true });
  assert.equal(slowResponse, '', 'Incomplete requests should close without being accepted');
  assert.ok(Date.now() - slowStart < 8_000, 'Partial requests need a bounded lifetime');
  checks.incompleteRequestDeadline = true;
  assert.equal((await snapshot()).validation.status, 'pending', 'Rejected requests must leave the legitimate callback pending');
  checks.rejectionsPreserveWaiter = true;

  const raw = request(callbackTarget);
  const response = await exchange([raw.slice(0, 3), raw.slice(3, 32), raw.slice(32, -2), raw.slice(-2)]);
  assertSuccess(response, code, state);
  const delivered = (await snapshot()).validation;
  assert.equal(delivered.status, 'resolved');
  assert.equal(delivered.deliveries, 1);
  assert.equal(delivered.url, `http://127.0.0.1:${callbackPort}${callbackTarget}`);
  checks.fragmentedCallback = true;
  checks.privateStaticResponse = true;
  await wait('secondDelivery', 'validation');
  assert.equal((await snapshot()).secondDelivery.status, 'rejected', 'A consumed callback cannot be delivered a second time');
  checks.oneShotDelivery = true;
  await stop('validation');
  await stop('validation');
  checks.idempotentStop = true;

  console.error('Checking early delivery, cancellation, stale cleanup, and port ownership.');
  const earlyState = `synthetic-${randomUUID()}`;
  const earlyCode = `synthetic-code-${randomUUID()}`;
  await start('early', earlyState);
  assertSuccess(await exchange([request(`/auth/callback?code=${earlyCode}&state=${earlyState}&client_id=${clientId}`)]), earlyCode, earlyState);
  await wait('early', 'early');
  const early = (await snapshot()).early;
  assert.equal(early.status, 'resolved');
  assert.equal(early.deliveries, 1);
  assert.equal(early.url, `${redirectUri}?code=${earlyCode}&state=${earlyState}&client_id=${clientId}`);
  checks.callbackBeforeWait = true;
  await stop('early');

  await start('cancelled', `synthetic-${randomUUID()}`);
  await wait('cancelled', 'cancelled');
  await stop('cancelled');
  const cancelled = (await snapshot()).cancelled;
  assert.equal(cancelled.status, 'rejected');
  assert.equal(cancelled.deliveries, 1);
  checks.stopRejectsWaiter = true;

  const newState = `synthetic-${randomUUID()}`;
  await start('new', newState);
  await wait('new', 'new');
  await stop('cancelled');
  assert.equal((await snapshot()).new.status, 'pending');
  assertSuccess(await exchange([request(`/auth/callback?code=${code}&state=${newState}&client_id=${clientId}`)]), code, newState);
  assert.equal((await snapshot()).new.status, 'resolved');
  checks.staleStopCannotCancelNewSession = true;
  await stop('new');

  collisionServer = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    collisionServer.once('error', reject);
    collisionServer.listen({ host: '127.0.0.1', port: callbackPort, exclusive: true }, resolve);
  });
  assert.deepEqual(await evaluate('start', { name: 'collision', state: `synthetic-${randomUUID()}` }), { started: false });
  checks.portCollisionRejected = true;
  await new Promise((resolve) => collisionServer.close(resolve));
  collisionServer = undefined;
  await start('rebound', `synthetic-${randomUUID()}`);
  await stop('rebound');
  checks.rebindAfterCollision = true;
} catch (error) {
  failure = error.message;
} finally {
  if (collisionServer) await new Promise((resolve) => collisionServer.close(resolve));
  if (initialized) {
    try { checks.cleanup = await evaluate('cleanup'); }
    catch { checks.cleanup = { stopped: false }; }
  }
}
const ok = !failure && checks.cleanup?.stopped === true;
console.log(JSON.stringify({ ok, checks, ...(failure ? { error: failure } : {}) }, null, 2));
if (!ok) process.exitCode = 1;
