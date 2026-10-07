#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/check-native-ssh.mjs [--platform ios|android] [--port PORT | --dev-server-url URL] [--transport-config PATH]\n'
    + 'Requires a foreground Hermes development build containing SSH and Nitro, connected to Metro.\n'
    + 'Loads an isolated modules-only probe from that same Metro server. Does not alter the app entry or start/reload the app.\n'
    + 'Checks native linkage, ephemeral Ed25519 generation/inspection, and native invalid-input errors.\n'
    + 'Without --transport-config no SSH sockets, user credentials, saved keys, or application data are used.\n'
    + '--transport-config runs actual SSH checks against disposable upstream/OpenSSH fixtures; never use production credentials.');
  process.exit(0);
}
const options = { platform: 'ios' };
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index], value = args[index + 1];
  if (!['--platform', '--port', '--dev-server-url', '--transport-config'].includes(flag) || !value
    || (flag === '--platform' && !['ios', 'android'].includes(value))
    || (flag === '--port' && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535))) {
    throw new Error('Invalid arguments; see --help.');
  }
  if (flag === '--dev-server-url') {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('--dev-server-url requires an HTTP(S) URL without credentials.');
    }
  }
  options[flag.slice(2)] = value;
}
if (options.port && options['dev-server-url']) throw new Error('Use either --port or --dev-server-url.');
const transportConfig = options['transport-config']
  ? JSON.parse(readFileSync(options['transport-config'], 'utf8')) : undefined;
if (transportConfig) {
  for (const name of ['upstream', 'openssh']) {
    const target = transportConfig[name];
    if (!target || typeof target.host !== 'string' || !Number.isInteger(target.port)
      || target.port < 1 || target.port > 65535 || typeof target.username !== 'string'
      || typeof target.fingerprint !== 'string' || !target.fingerprint.startsWith('SHA256:')) {
      throw new Error(`Transport config requires a disposable ${name} SSH fixture.`);
    }
    if (target.privateKeyPath) {
      target.privateKey = readFileSync(target.privateKeyPath, 'utf8');
      delete target.privateKeyPath;
    }
    if (typeof target.password !== 'string' && typeof target.privateKey !== 'string') {
      throw new Error(`Transport config requires ${name} fixture authentication.`);
    }
  }
}
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
// Agent CLI 1.0.18's iOS inspector filter omits a physical target titled
// "iPhone". Let its single connected target resolve, then verify Platform.OS
// inside the probe before any native operations.
const runtimeArgs = [
  ...(options.port ? ['--port', options.port] : []),
  ...(options['dev-server-url'] ? ['--dev-server-url', options['dev-server-url']] : [])];
const slot = JSON.stringify(`__piSshProbe_${randomUUID().replaceAll('-', '')}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function evaluate(expression) {
  let output;
  try {
    output = execFileSync('npx', ['--yes', '@expo/agent-cli', 'runtime:eval', expression,
      '--json', '--timeout', '15s', ...runtimeArgs], {
      cwd: projectRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    let report;
    try { report = JSON.parse(error.stdout?.toString()); } catch { /* Keep ordinary CLI diagnostics. */ }
    // execFileSync's default message includes the command arguments, which can
    // contain disposable fixture credentials. Never surface that message.
    throw new Error(report ? JSON.stringify({ error: report.error, exception: report.exception, promise: report.promise })
      : error.stderr?.toString() || `Expo runtime evaluation failed (${error.code || error.status || 'unknown status'}).`);
  }
  const report = JSON.parse(output);
  if (report.threw || report.promise?.state === 'rejected') {
    throw new Error(JSON.stringify({ exception: report.exception, promise: report.promise }));
  }
  return report.value;
}

// Serialized into the running Hermes development runtime. Omit the prelude and
// entry execution, then match definitions by source path: Expo assigns numeric
// IDs per entry bundle, even when both entries come from the same Metro server.
async function loadAndRunProbe(platform, signal, transportConfig) {
  const registry = globalThis.__r?.getModules?.();
  if (!registry || typeof globalThis.HermesInternal !== 'object') {
    throw new Error('A connected Hermes development build is required.');
  }
  const requireModule = (suffix) => {
    const matches = [...registry].filter(([, module]) => {
      const path = (module.verboseName || '').replace(/\\/g, '/');
      return path === suffix || path.endsWith(`/${suffix}`);
    });
    if (matches.length !== 1) throw new Error(`Expected one Metro module ${suffix}; got ${matches.length}.`);
    return globalThis.__r(matches[0][0]);
  };
  const server = requireModule('react-native/Libraries/Core/Devtools/getDevServer.js').default();
  if (!server.bundleLoadedFromServer || !server.fullBundleUrl) {
    throw new Error('The app must be running a development bundle from Metro.');
  }
  const url = new URL(server.fullBundleUrl);
  const entry = transportConfig ? 'native-ssh-transport-probe' : 'native-ssh-probe';
  url.pathname = `/tests/helpers/${entry}.bundle`;
  url.searchParams.set('platform', platform);
  url.searchParams.set('dev', 'true');
  url.searchParams.set('minify', 'false');
  url.searchParams.set('lazy', 'false');
  url.searchParams.set('modulesOnly', 'true');
  url.searchParams.set('runModule', 'false');
  url.searchParams.set('transform.bytecode', '0');
  const response = await fetch(url.toString(), { signal });
  if (!response.ok) throw new Error(`Metro probe bundle returned HTTP ${response.status}.`);
  const source = await response.text();
  if (signal.aborted) throw new Error('Probe loading was cancelled.');
  const before = [...registry];
  const definitions = [];
  // Collect factories without executing any module or replacing Metro globals.
  // eslint-disable-next-line no-new-func
  new Function('__d', source)((factory, id, dependencies, name) => {
    if (!name || !Array.isArray(dependencies) || dependencies.some((dependency) => typeof dependency !== 'number')) {
      throw new Error('Unexpected Metro probe definition; reload the app before retrying.');
    }
    definitions.push({ factory, id, dependencies, name });
  });
  const byName = new Map(before.map(([id, module]) => [module.verboseName, id]));
  // Refresh only test helpers on repeated invocations. Product modules retain
  // their original instances, while an edited probe cannot silently run old code.
  const isProbe = (name) => /(^|\/)tests\/helpers\/native-ssh[^/]*probe\.js$/.test(name);
  let nextId = Math.max(...registry.keys()) + 1;
  const ids = new Map(definitions.map(({ id, name }) => [id, isProbe(name) ? nextId++ : (byName.get(name) ?? nextId++)]));
  for (const { factory, id, dependencies, name } of definitions) {
    if (!isProbe(name) && byName.has(name)) continue;
    const mapped = dependencies.map((dependency) => {
      if (!ids.has(dependency)) throw new Error(`Missing Metro dependency ${dependency}.`);
      return ids.get(dependency);
    });
    globalThis.__d(factory, ids.get(id), mapped, isProbe(name) ? `${name}?probe=${ids.get(id)}` : name);
  }
  const entryDefinition = definitions.find(({ name }) => name === `tests/helpers/${entry}.js`
    || name.endsWith(`/tests/helpers/${entry}.js`));
  if (!entryDefinition) throw new Error('Metro probe entry was missing.');
  const result = await globalThis.__r(ids.get(entryDefinition.id)).default({ platform, signal, config: transportConfig });
  if (globalThis.__r.getModules() !== registry || before.some(([id, module]) => registry.get(id) !== module)) {
    throw new Error('Probe changed the existing app module registry or identities.');
  }
  return { ...result, appModulesPreserved: true };
}

// Do not await a long promise inside runtime:eval: launch once, then poll its
// plain status. Retrying a timed-out launch could duplicate native operations.
const launch = `(() => {
  const controller = new AbortController();
  const state = globalThis[${slot}] = { state: 'running', controller };
  const timer = setTimeout(() => controller.abort(), 120000);
  Promise.resolve().then(() => (${loadAndRunProbe.toString()})(${JSON.stringify(options.platform)}, controller.signal, ${JSON.stringify(transportConfig)})).then(
    value => { state.state = 'done'; state.value = value; },
    error => { state.state = 'failed'; state.error = String(error); }
  ).finally(() => clearTimeout(timer));
  return { started: true };
})()`;

let launched = false;
try {
  // Establish a connected runtime before starting any work. A definite absence
  // must fail promptly; only an ambiguous launch timeout warrants status polling.
  const runtime = evaluate(`({
    hermes: typeof globalThis.HermesInternal === 'object',
    metro: typeof globalThis.__r?.getModules === 'function'
  })`);
  if (!runtime?.hermes || !runtime.metro) {
    throw new Error('A connected Hermes development build with Metro is required.');
  }
  let launchError;
  try { evaluate(launch); launched = true; } catch (error) { launchError = error; }
  const deadline = Date.now() + 150_000;
  let lastReadError;
  for (;;) {
    if (Date.now() >= deadline) throw new Error(`Probe did not settle in 150s; it was not relaunched. ${lastReadError?.message || ''}`);
    let status;
    try {
      status = evaluate(`(() => {
        const state = globalThis[${slot}];
        return state ? { state: state.state, value: state.value, error: state.error } : { state: 'missing' };
      })()`);
    } catch (error) { lastReadError = error; await sleep(500); continue; }
    if (status?.state === 'missing') throw launchError || new Error('The app reloaded before the probe result was read.');
    launched = true;
    if (status?.state === 'failed') throw new Error(status.error);
    if (status?.state === 'done') {
      console.log(JSON.stringify(status.value, null, 2));
      if (!status.value?.ok || !status.value.hermes) process.exitCode = 1;
      break;
    }
    await sleep(250);
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  if (launched) {
    try { evaluate(`globalThis[${slot}]?.controller.abort(); delete globalThis[${slot}]`); }
    catch { /* A stale result can remain only in this development process. */ }
  }
}
