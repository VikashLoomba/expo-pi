#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/check-native-workspace-tools.mjs --namespace pi-workspace-tools-UNIQUE --stage seed|verify|ui [--platform ios|android] [--port PORT] [--hold-ms MS]\n'
    + 'Requires a connected development build. Run seed, terminate/relaunch the process, then verify with the same namespace.\n'
    + 'Each namespace gets its own chat database and workspace directory (expo-file-system). verify and ui delete\n'
    + 'them when they finish; seed keeps them for verify. Scripted model transport; no credentials or model HTTP.');
  process.exit(0);
}
const options = { platform: 'ios' };
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i];
  const value = args[i + 1];
  if (!['--namespace', '--stage', '--platform', '--port', '--hold-ms'].includes(flag) || !value) throw new Error('Invalid argument');
  options[flag.slice(2)] = value;
}
if (!/^pi-workspace-tools-[a-zA-Z0-9-]+$/.test(options.namespace ?? '')
  || !['seed', 'verify', 'ui'].includes(options.stage) || !['ios', 'android'].includes(options.platform)
  || (options.port && !/^\d+$/.test(options.port))
  || (options['hold-ms'] && (!/^\d+$/.test(options['hold-ms']) || Number(options['hold-ms']) > 45000))) throw new Error('Invalid validation options; see --help');
if (options['hold-ms']) options.holdMs = Number(options['hold-ms']);
const helper = options.stage === 'ui' ? 'workspace-tools-ui-probe.js' : 'workspace-tools-probe.js';
const probe = readFileSync(new URL(`../tests/helpers/${helper}`, import.meta.url), 'utf8')
  .replace('export default async function', 'async function');
const slot = JSON.stringify(`__piWorkspaceToolsProbe_${randomUUID().replaceAll('-', '')}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function evaluate(source) {
  // Hermes inspector receives source as UTF-16; escape non-ASCII code units so
  // astral characters survive its source parser exactly, as in Metro bundles.
  const expression = source.replace(/[^\x00-\x7f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  let raw;
  try {
    raw = execFileSync('npx', ['--yes', '@expo/agent-cli', 'runtime:eval', expression,
      '--json', '--timeout', '30s', '--platform', options.platform,
      ...(options.port ? ['--port', options.port] : [])], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 45_000,
      maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    let report;
    try { report = JSON.parse(error.stdout?.toString()); } catch { /* Preserve ordinary CLI errors. */ }
    throw new Error(report ? JSON.stringify({ error: report.error, exception: report.exception, promise: report.promise })
      : error.stderr?.toString() || error.message);
  }
  const report = JSON.parse(raw);
  if (report.threw || report.promise?.state === 'rejected') {
    throw new Error(JSON.stringify({ exception: report.exception, promise: report.promise }));
  }
  return report.value;
}

// The CLI polls returned promises with a fixed 2s request budget, even when its
// outer timeout is longer. Park this one execution and poll its plain status;
// delayed inspector reads can be retried without repeating filesystem work.
const launch = `(() => {
  const state = globalThis[${slot}] = { state: 'running' };
  Promise.resolve().then(() => (${probe})(${JSON.stringify(options)})).then(
    value => { state.state = 'done'; state.value = value; },
    error => { state.state = 'failed'; state.error = String(error); state.stack = error?.stack; }
  );
  return { started: true };
})()`;
let launched = false;
try {
  // Never retry this call: an inspector timeout cannot prove it did not execute.
  let launchError;
  try { evaluate(launch); launched = true; } catch (error) { launchError = error; }
  const deadline = Date.now() + 180_000;
  let lastReadError;
  for (;;) {
    if (Date.now() >= deadline) throw new Error(`Probe did not settle in 180s; it was not relaunched. ${lastReadError?.message || ''}`);
    let status;
    try { status = evaluate(`globalThis[${slot}] || { state: 'missing' }`); }
    catch (error) { lastReadError = error; await sleep(500); continue; }
    if (status.state === 'missing') throw launchError || new Error('The app reloaded before the probe outcome was read.');
    launched = true;
    if (status.state === 'failed') throw new Error(JSON.stringify({ error: status.error, stack: status.stack }));
    if (status.state === 'done') {
      if (!status.value?.ok || !status.value.hermes) throw new Error(JSON.stringify(status.value));
      console.log(JSON.stringify(status.value, null, 2));
      break;
    }
    await sleep(250);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (launched) {
    try { evaluate(`delete globalThis[${slot}]`); } catch { /* Only this isolated result may remain until reload. */ }
  }
}
