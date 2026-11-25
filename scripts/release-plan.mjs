import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Computes (and with --apply, commits and pushes) which targets of this monorepo need releasing based on changes
// since each target's latest git tag: server/v*, mobile/b*, mac/v*. Used by .github/workflows/release.yml and
// runnable locally with --dry-run to preview what a release trigger will do.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim();
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });

const VALID_MODES = new Set(['auto', 'force', 'skip']);
const VALID_BUMPS = new Set(['patch', 'minor', 'major']);

function parseArgs(argv) {
  const options = {
    server: process.env.RELEASE_SERVER || 'auto',
    mobile: process.env.RELEASE_MOBILE || 'auto',
    mac: process.env.RELEASE_MAC || 'auto',
    serverBump: process.env.RELEASE_SERVER_BUMP || 'patch',
    macBump: process.env.RELEASE_MAC_BUMP || 'patch',
    apply: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--server') options.server = argv[++i];
    else if (arg === '--mobile') options.mobile = argv[++i];
    else if (arg === '--mac') options.mac = argv[++i];
    else if (arg === '--server-bump') options.serverBump = argv[++i];
    else if (arg === '--mac-bump') options.macBump = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const key of ['server', 'mobile', 'mac']) {
    if (!VALID_MODES.has(options[key])) throw new Error(`Invalid ${key} mode: ${options[key]}`);
  }
  for (const key of ['serverBump', 'macBump']) {
    if (!VALID_BUMPS.has(options[key])) throw new Error(`Invalid ${key}: ${options[key]}`);
  }
  return options;
}

function latestTag(pattern) {
  const out = read('git', ['tag', '-l', pattern, '--sort=-v:refname']);
  return out ? out.split('\n')[0] : undefined;
}

function tagExists(tag) {
  return Boolean(read('git', ['tag', '-l', tag]));
}

function changedFilesSince(tag) {
  if (!tag) return null;
  const out = read('git', ['diff', '--name-only', `${tag}..HEAD`]);
  return out ? out.split('\n').filter(Boolean) : [];
}

function matchesAny(file, patterns) {
  return patterns.some((pattern) => (pattern.endsWith('/') ? file.startsWith(pattern) : file === pattern));
}

function bumpSemver(version, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Expected x.y.z version, got ${JSON.stringify(version)}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const TARGETS = {
  server: {
    tagPattern: 'server/v*',
    paths: [
      'packages/infinichat/',
      'packages/infinichat-server/src/',
      'packages/infinichat-server/runtime/',
      'packages/infinichat-server/docs/',
      'packages/infinichat-server/scripts/',
      'packages/infinichat-server/package.json',
      'pnpm-workspace.yaml',
      'pnpm-lock.yaml',
    ],
  },
  mobile: {
    tagPattern: 'mobile/b*',
    paths: [
      'apps/mobile/',
      'packages/infinichat/',
      'packages/react-native-ssh/',
      'packages/infinichat-server/assets/pi-env-gz/',
      'pnpm-workspace.yaml',
      'pnpm-lock.yaml',
    ],
  },
  mac: {
    tagPattern: 'mac/v*',
    paths: [
      'apps/mac/',
      'packages/infinichat/',
      'packages/infinichat-server/assets/pi-env/',
      'pnpm-workspace.yaml',
      'pnpm-lock.yaml',
    ],
  },
};

function evaluateTarget(name, mode) {
  const { tagPattern, paths } = TARGETS[name];
  const lastTag = latestTag(tagPattern);
  if (mode === 'skip') return { release: false, lastTag, reason: 'skipped by input', matched: [] };
  const changed = changedFilesSince(lastTag);
  const matched = changed === null ? ['(no previous tag)'] : changed.filter((file) => matchesAny(file, paths));
  if (mode === 'force') {
    return { release: true, lastTag, reason: 'forced by input', matched };
  }
  if (matched.length > 0) {
    return { release: true, lastTag, reason: `${matched.length} file(s) changed since ${lastTag ?? 'start'}`, matched };
  }
  return { release: false, lastTag, reason: `no changes since ${lastTag}`, matched: [] };
}

const options = parseArgs(process.argv.slice(2));
const plan = {
  server: evaluateTarget('server', options.server),
  mobile: evaluateTarget('mobile', options.mobile),
  mac: evaluateTarget('mac', options.mac),
};

// Read current versions from manifests; bump only when that version is already tagged, so retries stay idempotent.
const serverPkgPath = join(root, 'packages/infinichat-server/package.json');
const serverPkg = JSON.parse(readFileSync(serverPkgPath, 'utf8'));
const currentServerVersion = serverPkg.version;
const nextServerVersion = plan.server.release
  ? (tagExists(`server/v${currentServerVersion}`) ? bumpSemver(currentServerVersion, options.serverBump) : currentServerVersion)
  : currentServerVersion;

const mobileAppPath = join(root, 'apps/mobile/app.json');
const mobileApp = JSON.parse(readFileSync(mobileAppPath, 'utf8'));
const currentMobileBuild = Number(mobileApp.expo.ios.buildNumber);
if (!Number.isInteger(currentMobileBuild) || currentMobileBuild < 1) {
  throw new Error(`Invalid ios.buildNumber in apps/mobile/app.json: ${mobileApp.expo.ios.buildNumber}`);
}
const nextMobileBuild = plan.mobile.release
  ? (tagExists(`mobile/b${currentMobileBuild}`) ? currentMobileBuild + 1 : currentMobileBuild)
  : currentMobileBuild;

const macPkgPath = join(root, 'apps/mac/package.json');
const macPkg = JSON.parse(readFileSync(macPkgPath, 'utf8'));
const currentMacVersion = macPkg.version;
const nextMacVersion = plan.mac.release
  ? (tagExists(`mac/v${currentMacVersion}`) ? bumpSemver(currentMacVersion, options.macBump) : currentMacVersion)
  : currentMacVersion;

const any = plan.server.release || plan.mobile.release || plan.mac.release;
let releaseSha = read('git', ['rev-parse', 'HEAD']);

if (options.apply && any) {
  if (read('git', ['status', '--porcelain'])) {
    throw new Error('Working tree is not clean before applying release version bumps.');
  }
  const edited = [];
  const labels = [];
  if (plan.server.release && nextServerVersion !== currentServerVersion) {
    serverPkg.version = nextServerVersion;
    writeFileSync(serverPkgPath, `${JSON.stringify(serverPkg, null, 2)}\n`);
    edited.push('packages/infinichat-server/package.json');
    labels.push(`server ${nextServerVersion}`);
  }
  if (plan.mobile.release && nextMobileBuild !== currentMobileBuild) {
    mobileApp.expo.ios.buildNumber = String(nextMobileBuild);
    writeFileSync(mobileAppPath, `${JSON.stringify(mobileApp, null, 2)}\n`);
    edited.push('apps/mobile/app.json');
    labels.push(`mobile build ${nextMobileBuild}`);
  }
  if (plan.mac.release && nextMacVersion !== currentMacVersion) {
    macPkg.version = nextMacVersion;
    writeFileSync(macPkgPath, `${JSON.stringify(macPkg, null, 2)}\n`);
    edited.push('apps/mac/package.json');
    labels.push(`mac ${nextMacVersion}`);
  }
  if (edited.length > 0) {
    run('git', ['add', '--', ...edited]);
    run('git', ['commit', '-m', `chore(release): ${labels.join(', ')}`]);
    run('git', ['push', 'origin', 'HEAD:main']);
    releaseSha = read('git', ['rev-parse', 'HEAD']);
  }
}

const rows = [
  ['Server', plan.server.release ? 'Release' : 'Skip', plan.server.lastTag ?? '(none)',
    plan.server.release ? `server/v${nextServerVersion}` : '—', plan.server.reason],
  ['Mobile (iOS)', plan.mobile.release ? 'Release' : 'Skip', plan.mobile.lastTag ?? '(none)',
    plan.mobile.release ? `mobile/b${nextMobileBuild}` : '—', plan.mobile.reason],
  ['Mac Desktop', plan.mac.release ? 'Release' : 'Skip', plan.mac.lastTag ?? '(none)',
    plan.mac.release ? `mac/v${nextMacVersion}` : '—', plan.mac.reason],
];

const summary = [
  `## Release Plan${options.apply ? '' : ' (Dry Run)'}`,
  '',
  `Target commit: \`${releaseSha}\``,
  '',
  '| Target | Action | Last Tag | Next Tag | Reason |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map((cols) => `| ${cols.join(' | ')} |`),
  '',
].join('\n');

console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

if (process.env.GITHUB_OUTPUT) {
  const outputs = {
    any: String(any),
    server: String(plan.server.release),
    mobile: String(plan.mobile.release),
    mac: String(plan.mac.release),
    server_version: nextServerVersion,
    mobile_build: String(nextMobileBuild),
    mac_version: nextMacVersion,
    release_sha: releaseSha,
  };
  const lines = Object.entries(outputs).map(([k, v]) => `${k}=${v}`).join('\n');
  appendFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`);
}
