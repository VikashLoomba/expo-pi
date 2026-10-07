#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/check-native-bash.mjs --namespace pi-bash-UNIQUE --stage seed|verify [--platform ios|android] [--port PORT]\n'
    + 'Requires a connected development build. Run seed, terminate/relaunch the process, then verify with the same namespace.\n'
    + 'Each namespace gets its own chat database and workspace directory; verify deletes them when it finishes.\n'
    + 'Scripted model transport; does not read credentials or use model HTTP.');
  process.exit(0);
}
const options = { platform: 'ios' };
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i];
  const value = args[i + 1];
  if (!['--namespace', '--stage', '--platform', '--port'].includes(flag) || !value) throw new Error('Invalid argument');
  options[flag.slice(2)] = value;
}
if (!/^pi-bash-[a-zA-Z0-9-]+$/.test(options.namespace ?? '')
  || !['seed', 'verify'].includes(options.stage) || !['ios', 'android'].includes(options.platform)
  || (options.port && !/^\d+$/.test(options.port))) throw new Error('Invalid validation options; see --help');
const probe = readFileSync(new URL('../tests/helpers/native-bash-probe.js', import.meta.url), 'utf8')
  .replace('export default async function', 'async function');
const expression = `(${probe})(${JSON.stringify(options)})`;
try {
  const raw = execFileSync('npx', ['--yes', '@expo/agent-cli', 'runtime:eval', expression,
    '--json', '--timeout', '45s', '--platform', options.platform,
    ...(options.port ? ['--port', options.port] : [])], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const report = JSON.parse(raw);
  if (report.threw || report.promise?.state === 'rejected' || !report.value?.ok || !report.value.hermes) {
    throw new Error(JSON.stringify({ exception: report.exception, promise: report.promise, value: report.value }));
  }
  console.log(JSON.stringify(report.value, null, 2));
} catch (error) {
  let report;
  try { report = JSON.parse(error.stdout?.toString()); } catch { /* Retain ordinary CLI errors. */ }
  console.error(report ? JSON.stringify({ exception: report.exception, promise: report.promise, value: report.value })
    : error.stderr?.toString() || error.message);
  process.exitCode = 1;
}
