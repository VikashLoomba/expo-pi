import assert from 'node:assert/strict';
import test from 'node:test';
import { createExpoSqliteDatabase } from '../src/pi/storage/expo-sqlite.ts';
import { createNodeSqliteConnection } from './helpers/node-sqlite.mjs';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { InMemoryFs } = await import('just-bash/browser');
const { WorkspaceFileSystem } = await import('../src/pi/workspace/filesystem/index.ts');
const { createMountedFileSystem } = await import('../src/pi/workspace/mounted-filesystem.ts');
const { createBashEngine } = await import('../src/pi/bash/engine/index.ts');

async function mounted(t, options = {}) {
  const db = createExpoSqliteDatabase(createNodeSqliteConnection());
  t.after(() => db.close());
  const persistent = await WorkspaceFileSystem.open(db, 'mounted', { ...options, mountPath: '/workspace' });
  const temporary = new InMemoryFs();
  await temporary.mkdir('/tmp');
  const fs = createMountedFileSystem(temporary, persistent);
  return { fs, persistent, temporary };
}

test('actual shell resolves absolute and intermediate relative symlinks before dot-dot', async (t) => {
  const { fs, persistent } = await mounted(t);
  const result = await createBashEngine(fs).exec([
    'mkdir -p one/sub two', 'printf physical > one/value',
    'ln -s ../one/sub two/link', 'cat two/link/../value',
    'ln -s /workspace/one/value absolute', 'cat absolute',
    'printf created > two/link/../new', 'readlink absolute',
  ].join('; '));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'physicalphysical/workspace/one/value\n');
  assert.equal(await persistent.readFile('/one/new'), 'created');
  assert.equal(await fs.realpath('/workspace/two/link/../value'), '/workspace/one/value');
});

test('cross-mount links stay within the global virtual filesystem and preserve stored targets', async (t) => {
  const { fs, persistent, temporary } = await mounted(t);
  await fs.writeFile('/tmp/value', 'temporary');
  await fs.symlink('/tmp/value', '/workspace/from-temp');
  assert.equal(await fs.readFile('/workspace/from-temp'), 'temporary');
  assert.equal(await persistent.readlink('/from-temp'), '/tmp/value');
  await fs.symlink('/workspace/new', '/tmp/to-persistent');
  await fs.writeFile('/tmp/to-persistent', 'persisted');
  assert.equal(await persistent.readFile('/new'), 'persisted');
  assert.equal(await temporary.readlink('/tmp/to-persistent'), '/workspace/new');
  await assert.rejects(fs.symlink('file:///private/secret', '/workspace/host'), { code: 'EINVAL' });
  await assert.rejects(fs.readFile('content://private/file'), { code: 'EINVAL' });
});

test('final-link policies preserve exclusive creation, copy, rename and unlink semantics', async (t) => {
  const { fs } = await mounted(t);
  await fs.writeFile('/workspace/original', 'original');
  await fs.symlink('/workspace/original', '/workspace/link');
  await assert.rejects(fs.createExclusive('/workspace/link', { mode: 0o600 }), { code: 'EEXIST' });
  await fs.cp('/workspace/link', '/workspace/copied-link');
  assert.equal((await fs.lstat('/workspace/copied-link')).isSymbolicLink, true);
  assert.equal(await fs.readlink('/workspace/copied-link'), '/workspace/original');
  await fs.writeFile('/workspace/other', 'replacement');
  await fs.cp('/workspace/other', '/workspace/link');
  assert.equal(await fs.readFile('/workspace/original'), 'replacement');
  await fs.mv('/workspace/other', '/workspace/link');
  assert.equal((await fs.lstat('/workspace/link')).isSymbolicLink, false);
  await fs.rm('/workspace/copied-link');
  assert.equal(await fs.readFile('/workspace/original'), 'replacement');
  assert.equal(await fs.exists('/workspace/copied-link'), false);
});

test('mkdir follows existing directory links and preserves no-missing-parent rules', async (t) => {
  const { fs, persistent } = await mounted(t);
  await fs.mkdir('/workspace/directory');
  await fs.symlink('/workspace/directory', '/workspace/alias');
  await fs.mkdir('/workspace/alias/new/deep', { recursive: true });
  assert.equal((await persistent.stat('/directory/new/deep')).isDirectory, true);
  await assert.rejects(fs.createExclusive('/workspace/missing/file', { mode: 0o600 }), /ENOENT/);
  await assert.rejects(fs.writeFile('/workspace/missing/file', 'x'), /ENOENT/);
  await fs.mkdir('/workspace/trailing/');
  assert.equal((await fs.stat('/workspace/trailing')).isDirectory, true);
});

test('directory requirements, cycles and malformed paths fail before mutation', async (t) => {
  const { fs } = await mounted(t);
  await fs.writeFile('/workspace/file', 'kept');
  await assert.rejects(fs.readFile('/workspace/file/../other'), /ENOTDIR/);
  await assert.rejects(fs.mv('/workspace/file/', '/workspace/moved'), /ENOTDIR/);
  await assert.rejects(fs.mv('/workspace/file', '/workspace/moved/'), /ENOTDIR/);
  await fs.symlink('/workspace/file', '/workspace/link');
  await assert.rejects(fs.rm('/workspace/link/', { recursive: true }), /ENOTDIR/);
  assert.equal(await fs.readFile('/workspace/file'), 'kept');
  await fs.symlink('/workspace/cycle2', '/workspace/cycle1');
  await fs.symlink('/workspace/cycle1', '/workspace/cycle2');
  await assert.rejects(fs.readFile('/workspace/cycle1'), /ELOOP/);
  assert.equal(await fs.exists('/workspace/cycle1'), false);
  await assert.rejects(fs.writeFile('/workspace/a\0b', 'x'), /EINVAL/);
});

test('dangling and cross-mount symlinks copy and move without following their final inode', async (t) => {
  const { fs } = await mounted(t);
  await fs.symlink('/workspace/missing', '/workspace/dangling');
  await fs.cp('/workspace/dangling', '/workspace/copy');
  await fs.mv('/workspace/copy', '/workspace/moved');
  assert.equal(await fs.readlink('/workspace/moved'), '/workspace/missing');
  await fs.link('/workspace/dangling', '/workspace/hard');
  assert.equal((await fs.lstat('/workspace/hard')).identity, (await fs.lstat('/workspace/dangling')).identity);
  await fs.cp('/workspace/dangling', '/tmp/copied');
  await fs.mv('/tmp/copied', '/workspace/back');
  assert.equal(await fs.readlink('/workspace/back'), '/workspace/missing');
  await fs.mkdir('/workspace/tree');
  await fs.symlink('/tmp/missing', '/workspace/tree/link');
  await fs.cp('/workspace/tree', '/tmp/tree', { recursive: true });
  assert.equal(await fs.readlink('/tmp/tree/link'), '/tmp/missing');
  const result = await createBashEngine(fs).exec('cp dangling command-copy; mv command-copy command-moved; readlink command-moved');
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, '/workspace/missing\n');
  const entries = await fs.readdirWithFileTypes('/workspace/tree');
  assert.deepEqual(entries, [{ name: 'link', isFile: false, isDirectory: false, isSymbolicLink: true }]);
});


test('cross-mount moves replace final entries and reject incompatible destinations without mutation', async (t) => {
  const { fs } = await mounted(t);
  await fs.mkdir('/tmp/source');
  await fs.writeFile('/tmp/source/new', 'new');
  await fs.mkdir('/workspace/destination');
  await fs.writeFile('/workspace/destination/old', 'old');
  await assert.rejects(fs.mv('/tmp/source', '/workspace/destination'), /ENOTEMPTY/);
  assert.equal(await fs.readFile('/tmp/source/new'), 'new');
  assert.deepEqual(await fs.readdir('/workspace/destination'), ['old']);
  await fs.writeFile('/tmp/file', 'replacement');
  await assert.rejects(fs.mv('/tmp/file', '/workspace/destination'), /EISDIR/);
  await assert.rejects(fs.mv('/tmp/source', '/tmp/file'), /ENOTDIR/);
  await assert.rejects(fs.mv('/tmp/source', '/workspace'), /EBUSY/);
  await fs.writeFile('/workspace/victim', 'victim');
  await fs.symlink('/workspace/victim', '/workspace/alias');
  await fs.mv('/tmp/file', '/workspace/alias');
  assert.equal((await fs.lstat('/workspace/alias')).isSymbolicLink, false);
  assert.equal(await fs.readFile('/workspace/alias'), 'replacement');
  assert.equal(await fs.readFile('/workspace/victim'), 'victim');
  await fs.link('/workspace/victim', '/workspace/hard');
  await fs.writeFile('/tmp/file', 'new inode');
  await fs.mv('/tmp/file', '/workspace/hard');
  assert.equal(await fs.readFile('/workspace/victim'), 'victim');
  assert.notEqual((await fs.stat('/workspace/hard')).identity, (await fs.stat('/workspace/victim')).identity);
  await fs.rm('/workspace/destination/old');
  await fs.mv('/tmp/source', '/workspace/destination');
  assert.equal(await fs.readFile('/workspace/destination/new'), 'new');
  assert.equal(await fs.exists('/tmp/source'), false);
});

test('system initialization and process substitution work through the real engine', async (t) => {
  const { fs } = await mounted(t);
  const result = await createBashEngine(fs).exec('ls /bin | grep "^cat$"; which cat; head -n 1 /proc/self/status; cat <(printf substituted)');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^cat\n\/usr\/bin\/cat\nName:\s+bash\nsubstituted$/);
  assert.throws(() => fs.writeFileSync('/workspace/bypass', 'bad'), /ENOSYS/);
  assert.throws(() => fs.writeFileSync('/proc/../workspace/bypass', 'bad'), /ENOSYS/);
  assert.equal(await fs.exists('/workspace/bypass'), false);
});

test('symlink targets retain trailing directory requirements', async (t) => {
  const { fs } = await mounted(t);
  await fs.writeFile('/workspace/file', 'keep');
  await fs.symlink('/workspace/file/', '/workspace/link');
  await assert.rejects(fs.readFile('/workspace/link'), /ENOTDIR/);
  await fs.symlink('/workspace/missing/', '/tmp/missing-link');
  await assert.rejects(fs.writeFile('/tmp/missing-link', 'bad'), /ENOENT|ENOTDIR/);
  assert.equal(await fs.exists('/workspace/missing'), false);
});

test('cancellation identity reaches temporary operations and errno-shaped catch paths', async (t) => {
  const { persistent, temporary } = await mounted(t);
  const controller = new AbortController();
  const reason = Object.assign(new Error('ENOENT: cancelled'), { code: 'ENOENT' });
  const fs = createMountedFileSystem(temporary, persistent.forInvocation(controller.signal), controller.signal);
  controller.abort(reason);
  for (const operation of [() => fs.writeFile('/tmp/no', 'bad'), () => fs.exists('/tmp/no'), () => fs.rm('/tmp/no', { force: true })]) {
    await assert.rejects(operation(), (cause) => cause === reason);
  }
  assert.equal(await temporary.exists('/tmp/no'), false);
  assert.throws(() => fs.mkdirSync('/proc'), (cause) => cause === reason);
});

test('abort after path lookup is checked before a temporary mutation', async (t) => {
  const { persistent, temporary } = await mounted(t);
  const controller = new AbortController();
  const reason = new Error('cancel during resolution');
  const original = temporary.lstat.bind(temporary);
  temporary.lstat = async (path) => {
    if (path === '/tmp/new') controller.abort(reason);
    return original(path);
  };
  const fs = createMountedFileSystem(temporary, persistent.forInvocation(controller.signal), controller.signal);
  await assert.rejects(fs.writeFile('/tmp/new', 'bad'), (cause) => cause === reason);
  assert.equal(await temporary.exists('/tmp/new'), false);
});


test('a failed cross-mount move retains its source and exposes ordinary partial destination writes', async (t) => {
  const { fs } = await mounted(t, { limits: { maxFileBytes: 4 } });
  await fs.mkdir('/tmp/source');
  await fs.writeFile('/tmp/source/a', 'kept');
  await fs.writeFile('/tmp/source/z', 'too large');
  await assert.rejects(fs.mv('/tmp/source', '/workspace/destination'), /EFBIG/);
  assert.equal(await fs.readFile('/tmp/source/a'), 'kept');
  assert.equal(await fs.readFile('/tmp/source/z'), 'too large');
  assert.equal(await fs.readFile('/workspace/destination/a'), 'kept');
  assert.equal(await fs.exists('/workspace/destination/z'), false);
});


test('recursive mkdir creates missing prefixes before dot-dot and rejects dangling directory links', async (t) => {
  const { fs } = await mounted(t);
  const result = await createBashEngine(fs).exec('mkdir -p a/../b; test -d a && test -d b');
  assert.equal(result.exitCode, 0, result.stderr);
  await fs.symlink('/workspace/missing/parent', '/workspace/link');
  await assert.rejects(fs.mkdir('/workspace/link', { recursive: true }), /EEXIST/);
  assert.equal(await fs.exists('/workspace/missing'), false);
  await fs.mkdir('/tmp/a/../b', { recursive: true });
  assert.equal((await fs.stat('/tmp/a')).isDirectory, true);
  assert.equal((await fs.stat('/tmp/b')).isDirectory, true);
});

test('actual ln and rm commands preserve dangling-link inodes and never remove link targets', async (t) => {
  const { fs } = await mounted(t);
  await fs.symlink('/workspace/missing', '/workspace/dangling');
  const originalIdentity = (await fs.lstat('/workspace/dangling')).identity;
  const result = await createBashEngine(fs).exec([
    'ln dangling hard',
    'ln -sf replacement dangling',
    'ln -s missing doomed',
    'rm doomed',
    'printf retained > regular-target',
    'ln -s regular-target regular-link',
    'rm regular-link',
    'mkdir -p target/sub',
    'printf protected > target/sub/file',
    'ln -s target plain-directory-link',
    'rm plain-directory-link',
    'ln -s target recursive-directory-link',
    'rm -r recursive-directory-link',
  ].join(' && '));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(await fs.readlink('/workspace/dangling'), 'replacement');
  assert.equal(await fs.readlink('/workspace/hard'), '/workspace/missing');
  assert.equal((await fs.lstat('/workspace/hard')).identity, originalIdentity);
  assert.notEqual((await fs.lstat('/workspace/dangling')).identity, originalIdentity);
  assert.equal(await fs.readFile('/workspace/regular-target'), 'retained');
  assert.equal(await fs.readFile('/workspace/target/sub/file'), 'protected');
  for (const name of ['doomed', 'regular-link', 'plain-directory-link', 'recursive-directory-link']) {
    await assert.rejects(fs.lstat(`/workspace/${name}`), /ENOENT/);
  }
});
