#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: pnpm test:native [--platform ios|android] [--port PORT]\n'
    + 'Requires a foreground development build connected to Metro. Uses unique validation SQLite databases\n'
    + 'and a scripted provider; no real credentials or model HTTP requests. Does not start or reload the app.\n'
    + 'Also reports how long opening takes with 1 chat, 100 chats, and 100 chats with longer transcripts.');
  process.exit(0);
}
const runtimeArgs = [];
let platform = 'ios';
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (!['--platform', '--port'].includes(flag) || !value
    || (flag === '--platform' && !['ios', 'android'].includes(value))
    || (flag === '--port' && !/^\d+$/.test(value))) {
    console.error('Invalid arguments. Run pnpm test:native --help for usage.');
    process.exit(1);
  }
  if (flag === '--platform') platform = value;
  else runtimeArgs.push(flag, value);
}
runtimeArgs.push('--platform', platform);

function evaluate(expression) {
  let output;
  try {
    output = execFileSync('npx', ['--yes', '@expo/agent-cli', 'runtime:eval', expression,
      '--json', '--timeout', '150s', ...runtimeArgs], {
      cwd: projectRoot, encoding: 'utf8', timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stdout = error.stdout?.toString().trim();
    const stderr = error.stderr?.toString().trim();
    let report;
    try { report = JSON.parse(stdout); } catch { /* Preserve CLI diagnostics below. */ }
    const reason = report?.promise?.reason;
    throw new Error(report?.exception?.text || (typeof reason === 'string' ? reason : reason && JSON.stringify(reason))
      || stderr || stdout || error.message);
  }
  const report = JSON.parse(output);
  if (report.threw || report.promise?.state === 'rejected') {
    throw new Error(report.exception?.text || JSON.stringify(report.promise));
  }
  if (report.value == null) throw new Error('Native evaluation returned no value. Keep the app open and connected to Metro.');
  return report.value;
}

// Use the runtime's observed source paths. Metro changes numeric IDs after every
// bundle edit; matching a filename without its package path can select a different module.
function discoverModules() {
  const modules = globalThis.__r?.getModules?.();
  if (!modules) throw new Error('Metro development module registry is unavailable. Use a development build.');
  const suffixes = {
    ai: '@earendil-works/pi-ai/dist/index.js',
    durable: '@earendil-works/pi-durable/dist/index.js',
    context: '@earendil-works/chord/dist/context/index.js',
    anthropic: '@earendil-works/pi-ai/dist/providers/anthropic.js',
    storage: 'src/pi/storage/index.ts',
    sqlite: 'expo-sqlite/build/index.js',
    service: 'src/pi/chat-service.ts',
  };
  const result = {};
  for (const [name, suffix] of Object.entries(suffixes)) {
    const matches = [];
    for (const [id, module] of modules) {
      const path = (module.verboseName || '').replace(/\\/g, '/');
      if (path === suffix || path.endsWith(`/${suffix}`)) matches.push({ id, path });
    }
    if (matches.length !== 1) throw new Error(`Expected one loaded ${suffix}; found ${matches.length}. Open the app's chat screen first.`);
    result[name] = matches[0].id;
  }
  return result;
}

try {
  const moduleIds = evaluate(`(${discoverModules.toString()})()`);
  const fixture = readFileSync(new URL('../tests/helpers/native-durable-probe.js', import.meta.url), 'utf8')
    .replace('export default async function', 'async function');
  const database = `pi-validation-${Date.now()}-${randomUUID()}.db`;
  const result = evaluate(`(${fixture})(${JSON.stringify({ moduleIds, database })})`);
  if (!result.ok || !result.hermes) throw new Error(`Native Hermes validation failed: ${JSON.stringify(result)}`);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
}
