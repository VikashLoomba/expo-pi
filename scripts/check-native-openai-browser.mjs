#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixture = readFileSync(new URL('../tests/helpers/native-openai-browser-probe.js', import.meta.url), 'utf8')
  .replace('export default async function', 'async function');
if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/check-native-openai-browser.mjs\nRequires a foreground iOS simulator development build on Metro8081. Accept the simulator\'s native Continue prompt. Uses a local synthetic redirect server and intercepted tokens; never touches real accounts.');
  process.exit(0);
}
function evaluate(input) {
  const raw = execFileSync('npx', ['--yes', '@expo/agent-cli', 'runtime:eval', `(${fixture})(${JSON.stringify(input)})`,
    '--platform', 'ios', '--port', '8081', '--timeout', '20s', '--json'],
  { cwd: projectRoot, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = JSON.parse(raw);
  if (result.threw || result.promise?.state === 'rejected' || !result.value) throw new Error('Simulator probe unavailable.');
  return result.value;
}
let requests = 0;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/authorize' || !url.searchParams.get('state')) { res.writeHead(404); res.end(); return; }
  requests++;
  const callback = new URL('http://127.0.0.1:1455/auth/callback');
  callback.searchParams.set('state', url.searchParams.get('state'));
  callback.searchParams.set('code', 'synthetic-native-browser-code');
  callback.searchParams.set('client_id', 'oaiapp_synthetic_native_browser');
  res.writeHead(302, { location: callback.href, 'cache-control': 'no-store' }); res.end();
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
let report;
let cleanup;
try {
  evaluate({ action: 'start', authorizationURL: `http://127.0.0.1:${server.address().port}/authorize` });
  console.error('Accept Continue in the simulator authentication prompt. Waiting for the actual native browser callback.');
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    report = evaluate({ action: 'status' });
    if (report.phase === 'complete') break;
  }
} catch { report = { ok: false, failure: 'simulator_probe_failed' }; }
finally {
  try { cleanup = evaluate({ action: 'cleanup' }); } catch { cleanup = { cleaned: false }; }
  await new Promise((resolve) => server.close(resolve));
}
const ok = report?.ok === true && requests > 0 && cleanup.cleaned;
console.log(JSON.stringify({ ok, browserRedirectRequests: requests, report, cleanup }, null, 2));
if (!ok) process.exitCode = 1;
