#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/check-native-streaming.mjs [--seed-turns N] [--manual [--duration-seconds N]]\n'
    + 'Requires a foreground Hermes iOS development build on Metro port 8081.\n'
    + 'Temporarily opens an isolated scripted chat, measures streaming, restores hooks, and returns home.\n'
    + 'Default: an 8-second automatic follow check. --manual defaults to 60 seconds; N must be an integer from 15 to 180.\n'
    + 'For slower UI automation: --manual --duration-seconds 120\n'
    + '--seed-turns N saves N earlier question/answer turns first (up to 1000), to measure a long chat.\n'
    + 'After a real upward swipe settles, evaluate __PI_STREAMING_PROBE__.markPhase("reading-history").\n'
    + 'Let text grow, then markPhase("jump-to-latest") before tapping the jump button.\n'
    + 'Manual success requires a stationary reading position, resumed following as text grows, and a final bottom gap <= 2 pixels.');
  process.exit(0);
}
let manual = false;
let requestedSeconds;
let seedTurns = 0;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--manual') manual = true;
  else if (args[index] === '--duration-seconds' && /^\d+$/.test(args[index + 1] || '')) requestedSeconds = Number(args[++index]);
  else if (args[index] === '--seed-turns' && /^\d+$/.test(args[index + 1] || '')) seedTurns = Number(args[++index]);
  else throw new Error(`Invalid argument ${args[index]}. Use --help.`);
}
if (seedTurns > 1000) throw new Error('--seed-turns must be at most 1000.');
if (requestedSeconds !== undefined && (!manual || requestedSeconds < 15 || requestedSeconds > 180)) {
  throw new Error('--duration-seconds requires --manual and an integer from 15 to 180.');
}
const durationMs = manual ? (requestedSeconds ?? 60) * 1_000 : 8_000;
const timeoutMs = durationMs + 30_000;
const fixture = readFileSync(new URL('../tests/helpers/native-streaming-probe.js', import.meta.url), 'utf8')
  .replace('export default async function', 'async function');
const parameters = { database: `pi-streaming-validation-${Date.now()}-${randomUUID()}.db`,
  manual, durationMs, seedTurns };
try {
  const output = execFileSync('npx', ['--yes', '@expo/agent-cli', 'runtime:eval',
    `(${fixture})(${JSON.stringify(parameters)})`, '--json', '--platform', 'ios', '--port', '8081', '--timeout', `${timeoutMs}ms`],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: timeoutMs + 15_000,
    maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const report = JSON.parse(output);
  if (!report.value) throw new Error(report.exception?.text || JSON.stringify(report.promise));
  console.log(JSON.stringify(report.value, null, 2));
  if (!report.value.ok) process.exitCode = 1;
} catch (error) {
  let report;
  try { report = JSON.parse(error.stdout?.toString()); } catch { /* CLI errors may have no JSON stdout. */ }
  console.error(JSON.stringify({ ok: false, error: report?.exception?.text || report?.promise?.reason
    || error.stderr?.toString().trim() || error.message }, null, 2));
  process.exitCode = 1;
}
