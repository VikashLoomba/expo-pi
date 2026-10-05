#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/check-native-web-search.mjs [--platform ios|android] [--port PORT] [--hold-ms N] [--hold-stage searching|completed]\n'
    + 'Requires a foreground development build on Metro. Uses real Pi OpenAI Responses parsing, synthetic HTTP SSE,\n'
    + 'and an isolated native SQLite database. Temporarily mounts its fixture chat and restores UI hooks afterward.\n'
    + '--hold-ms (0–45000) keeps the selected stage visible for screenshots; no real credentials are read or model requests sent.');
  process.exit(0);
}
let platform = 'ios';
let port = '8081';
let holdMs = 0;
let holdStage = 'completed';
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (flag === '--platform' && ['ios', 'android'].includes(value)) platform = value;
  else if (flag === '--port' && /^\d+$/.test(value || '') && Number(value) > 0 && Number(value) <= 65535) port = value;
  else if (flag === '--hold-ms' && /^\d+$/.test(value || '') && Number(value) <= 45000) holdMs = Number(value);
  else if (flag === '--hold-stage' && ['searching', 'completed'].includes(value)) holdStage = value;
  else throw new Error('Invalid arguments. Use --help.');
}
const fixture = readFileSync(new URL('../tests/helpers/native-web-search-probe.js', import.meta.url), 'utf8')
  .replace('export default async function', 'async function');
const parameters = { database: `pi-web-search-validation-${randomUUID()}.db`, platform, holdMs, holdStage };
try {
  const output = execFileSync('npx', ['--yes', '@expo/agent-cli', 'runtime:eval',
    `(${fixture})(${JSON.stringify(parameters)})`, '--json', '--platform', platform, '--port', port,
    '--timeout', `${holdMs + 25000}ms`], { cwd: fileURLToPath(new URL('../', import.meta.url)),
    encoding: 'utf8', timeout: holdMs + 35000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const report = JSON.parse(output);
  if (!report.value) throw new Error(report.exception?.text || JSON.stringify(report.promise));
  console.log(JSON.stringify(report.value, null, 2));
  if (!report.value.ok) process.exitCode = 1;
} catch (error) {
  let report;
  try { report = JSON.parse(error.stdout?.toString()); } catch { /* The CLI may fail before JSON output. */ }
  console.error(JSON.stringify({ ok: false, error: report?.exception?.text || report?.promise?.reason
    || error.stderr?.toString().trim() || error.message }, null, 2));
  process.exitCode = 1;
}
