#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/check-native-auth.mjs [--stage all|prepare|verify|cleanup]\n'
    + '  [--namespace pi.auth.validation.v1.<UUID>] [--platform ios|android] [--port PORT]\n'
    + '  [--reload-method runtime|dev-server|device]\n\n'
    + 'Requires a foreground Hermes development build containing expo-secure-store, connected to Metro.\n'
    + 'Default all: prepare → Expo Agent CLI runtime:reload → verify → cleanup. Uses a unique test key,\n'
    + 'actual native SecureStore and synthetic OAuth data; token HTTP requests are intercepted, never sent.\n'
    + 'Verify requires a new JavaScript runtime: a marker detects a missing reload.\n\n'
    + 'For a physical process restart, run --stage prepare, keep the reported non-secret namespace,\n'
    + 'restart the app externally, then --stage verify --namespace <key> and --stage cleanup --namespace <key>.\n'
    + 'The verifier intentionally retains its isolated key until cleanup. No real app credential key is read or written.');
  process.exit(0);
}

let stage = 'all';
let namespace;
let platform = 'ios';
let port = '8081';
let reloadMethod = 'runtime';
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (!value) throw new Error('Each option requires a value. Use --help.');
  if (flag === '--stage' && ['all', 'prepare', 'verify', 'cleanup'].includes(value)) stage = value;
  else if (flag === '--namespace' && /^pi\.auth\.validation\.v1\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) namespace = value;
  else if (flag === '--platform' && ['ios', 'android'].includes(value)) platform = value;
  else if (flag === '--port' && /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535) port = value;
  else if (flag === '--reload-method' && ['runtime', 'dev-server', 'device'].includes(value)) reloadMethod = value;
  else throw new Error('Invalid option or value. Use --help.');
}
if (['verify', 'cleanup'].includes(stage) && !namespace) throw new Error('--namespace from prepare is required for verify/cleanup.');
const generatedNamespace = namespace === undefined;
namespace ??= `pi.auth.validation.v1.${randomUUID()}`;

const runtimeArgs = ['--json', '--platform', platform, '--port', port];
const fixture = readFileSync(new URL('../tests/helpers/native-auth-probe.js', import.meta.url), 'utf8')
  .replace('export default async function', 'async function');
function runCli(command, parameters, timeout = 40_000) {
  let output;
  try {
    output = execFileSync('npx', ['--yes', '@expo/agent-cli', command, ...parameters, ...runtimeArgs], {
      cwd: projectRoot, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // Do not echo runtime expressions, exceptions, or credential-bearing CLI payloads.
    throw new Error(`${command} failed. Check that the native development build is foreground and connected to Metro.`);
  }
  try { return JSON.parse(output); }
  catch { throw new Error(`${command} did not return a JSON report.`); }
}
function evaluate(currentStage) {
  const report = runCli('runtime:eval', [`(${fixture})(${JSON.stringify({ stage: currentStage, namespace })})`, '--timeout', '20s']);
  if (report.threw || report.promise?.state === 'rejected' || report.value == null) throw new Error(`Native auth ${currentStage} did not return a report.`);
  return report.value;
}

if (stage !== 'all') {
  try {
    const result = evaluate(stage);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, stage, namespace, error: error.message }, null, 2));
    process.exitCode = 1;
  }
} else {
  const stages = {};
  let error;
  // An interrupted prepare may have written its fresh key before the CLI lost
  // contact. Cleanup still owns generated keys; caller-supplied keys require
  // confirmation that prepare observed them empty.
  let prepared = generatedNamespace;
  try {
    console.error('Checking native credential persistence: prepare.');
    stages.prepare = evaluate('prepare');
    prepared = generatedNamespace || stages.prepare.checks?.isolatedKeyWasEmpty === true;
    if (!stages.prepare.ok) throw new Error(`Prepare failed at ${stages.prepare.failure ?? 'its assertions'}.`);
    console.error('Reloading the JavaScript runtime through Expo Agent CLI.');
    const reload = runCli('runtime:reload', ['--method', reloadMethod, '--timeout', '40s'], 55_000);
    stages.reload = { ok: reload.reloaded === true };
    if (!stages.reload.ok) throw new Error('The CLI did not verify a reload.');
    console.error('Checking native credential persistence: restore and refresh.');
    stages.verify = evaluate('verify');
    if (!stages.verify.ok) throw new Error(`Verify failed at ${stages.verify.failure ?? 'its assertions'}.`);
  } catch (cause) {
    error = cause.message;
  } finally {
    if (prepared) {
      console.error('Deleting the isolated validation credential.');
      try { stages.cleanup = evaluate('cleanup'); }
      catch { stages.cleanup = { ok: false, failure: 'cleanup_runtime_unavailable' }; }
    }
  }
  const ok = !error && stages.prepare?.ok === true && stages.reload?.ok === true
    && stages.verify?.ok === true && stages.cleanup?.ok === true;
  console.log(JSON.stringify({ ok, namespace, stages, ...(error ? { error } : {}) }, null, 2));
  if (!ok) process.exitCode = 1;
}
