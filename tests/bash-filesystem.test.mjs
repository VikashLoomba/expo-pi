import assert from 'node:assert/strict';
import test from 'node:test';
import { createExpoSqliteDatabase } from '../src/pi/storage/expo-sqlite.ts';
import { createNodeSqliteConnection } from './helpers/node-sqlite.mjs';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';

installBashBrowserHooks();
const { WorkspaceFileSystem } = await import('../src/pi/workspace/filesystem/index.ts');
async function fixture(t, options) {
  const db = createExpoSqliteDatabase(createNodeSqliteConnection());
  t.after(() => db.close());
  return { db, fs: await WorkspaceFileSystem.open(db, 'test', options) };
}

test('binary bytes, Unicode, NUL, empty files and all supported encodings', async (t) => {
  const { fs } = await fixture(t);
  const bytes = new Uint8Array([0, 128, 255, 65, 10]);
  await fs.writeFile('/bytes', bytes);
  bytes[0] = 123;
  assert.deepEqual(await fs.readFileBuffer('/bytes'), new Uint8Array([0, 128, 255, 65, 10]));
  assert.equal(await fs.readFile('/bytes', 'hex'), '0080ff410a');
  assert.equal(await fs.readFile('/bytes', 'base64'), 'AID/QQo=');
  await fs.writeFile('/base64', 'AID/QQo=', 'base64');
  await fs.writeFile('/hex', '0080ff410a', { encoding: 'hex' });
  await fs.writeFile('/latin', '\0\x80\xffA\n', 'latin1');
  for (const name of ['base64', 'hex', 'latin']) assert.deepEqual(await fs.readFileBuffer(`/${name}`), await fs.readFileBuffer('/bytes'));
  assert.equal(await fs.readFileBytes('/bytes'), '\0\x80\xffA\n');
  for (const encoding of ['utf8', 'utf-8', 'ascii']) {
    // Match the selected just-bash codec: ascii uses UTF-8, not Node's 7-bit mask.
    await fs.writeFile('/text', 'hé😀\0', encoding);
    assert.equal(await fs.readFile('/text', encoding), 'hé😀\0');
  }
  await fs.writeFile('/empty', '');
  assert.equal((await fs.stat('/empty')).size, 0);
  await fs.appendFile('/new', 'one'); await fs.appendFile('/new', '74776f', 'hex');
  assert.equal(await fs.readFile('/new'), 'onetwo');
});

test('directory creation, type checks, removal and force follow POSIX error rules', async (t) => {
  const { fs } = await fixture(t);
  await assert.rejects(fs.writeFile('/missing/file', 'x'), { code: 'ENOENT' });
  await fs.mkdir('/a/b', { recursive: true });
  await fs.mkdir('/a/b', { recursive: true });
  await assert.rejects(fs.mkdir('/a'), { code: 'EEXIST' });
  await fs.writeFile('/a/file', 'x');
  await assert.rejects(fs.readFile('/a'), { code: 'EISDIR' });
  await assert.rejects(fs.readdir('/a/file'), { code: 'ENOTDIR' });
  await assert.rejects(fs.mkdir('/a/file/sub', { recursive: true }), { code: 'ENOTDIR' });
  await assert.rejects(fs.rm('/a'), { code: 'ENOTEMPTY' });
  await assert.rejects(fs.rm('/'), { code: 'EBUSY' });
  await fs.rm('/missing', { force: true });
  assert.deepEqual(await fs.readdir('/a'), ['b', 'file']);
  await fs.rm('/a', { recursive: true });
  assert.deepEqual(fs.getAllPaths(), ['/']);
});

test('symbolic links preserve relative targets, intermediate resolution and physical ..', async (t) => {
  const { fs } = await fixture(t);
  await fs.mkdir('/one/sub', { recursive: true });
  await fs.mkdir('/two');
  await fs.writeFile('/one/value', 'physical');
  await fs.symlink('/one/sub', '/two/link');
  assert.equal(await fs.readFile('/two/link/../value'), 'physical');
  assert.equal(await fs.realpath('/two/link/..'), '/one');
  await fs.symlink('../one/value', '/two/relative');
  assert.equal(await fs.readlink('/two/relative'), '../one/value');
  assert.equal(await fs.readFile('/two/relative'), 'physical');
  assert.equal((await fs.lstat('/two/relative')).isSymbolicLink, true);
  assert.equal((await fs.stat('/two/relative')).isFile, true);
  assert.equal((await fs.lstat('/two/link/../value')).isFile, true);
  await fs.symlink('/new', '/dangling');
  assert.equal(await fs.exists('/dangling'), false);
  await fs.writeFile('/dangling', 'created target');
  assert.equal(await fs.readFile('/new'), 'created target');
  await fs.rm('/dangling');
  assert.equal(await fs.readFile('/new'), 'created target');
  await fs.symlink('/cycle2', '/cycle1'); await fs.symlink('/cycle1', '/cycle2');
  await assert.rejects(fs.realpath('/cycle1'), { code: 'ELOOP' });
  assert.equal(await fs.exists('/cycle1'), false);
  await assert.rejects(fs.rm('/two/link/', { recursive: true }), { code: 'ENOTDIR' });
  assert.equal(await fs.readFile('/one/value'), 'physical');
  await fs.symlink('/one/value/', '/target-requires-directory');
  await assert.rejects(fs.readFile('/target-requires-directory'), { code: 'ENOTDIR' });
  await fs.symlink('/absent/', '/missing-directory-target');
  await assert.rejects(fs.writeFile('/missing-directory-target', 'must not create file'), { code: 'ENOENT' });
});

test('hard links share bytes, permission bits, timestamps and identity; final unlink reclaims bytes', async (t) => {
  const { fs, db } = await fixture(t);
  await fs.writeFile('/a', 'one'); await fs.link('/a', '/b');
  assert.equal((await fs.stat('/a')).identity, (await fs.stat('/b')).identity);
  await fs.appendFile('/b', 'two'); await fs.chmod('/b', 0o600);
  await fs.utimes('/a', new Date(0), new Date(1234));
  assert.equal(await fs.readFile('/a'), 'onetwo');
  assert.equal((await fs.stat('/a')).mode, 0o600);
  assert.equal((await fs.stat('/b')).mtime.getTime(), 1234);
  assert.equal((await db.get('SELECT bytes FROM workspaces WHERE id=?', 'test')).bytes, 6);
  await fs.rm('/a'); assert.equal(await fs.readFile('/b'), 'onetwo');
  await fs.rm('/b'); assert.equal((await db.get('SELECT bytes FROM workspaces WHERE id=?', 'test')).bytes, 0);
  await assert.rejects(fs.link('/', '/illegal'), { code: 'EPERM' });
  await fs.symlink('/dangling-target', '/symbolic');
  await fs.link('/symbolic', '/symbolic-hard');
  assert.equal((await fs.lstat('/symbolic')).identity, (await fs.lstat('/symbolic-hard')).identity);
  assert.equal(await fs.readlink('/symbolic-hard'), '/dangling-target');
});

test('copy is independent, preserves symbolic links, follows file destination links, and move retains identities', async (t) => {
  const { fs } = await fixture(t);
  await fs.mkdir('/source/sub', { recursive: true }); await fs.writeFile('/source/sub/file', 'a');
  await fs.symlink('sub/file', '/source/link');
  await assert.rejects(fs.cp('/source', '/copy'), { code: 'EISDIR' });
  await fs.cp('/source', '/copy', { recursive: true });
  await fs.writeFile('/copy/sub/file', 'b');
  assert.equal(await fs.readFile('/source/link'), 'a');
  assert.equal(await fs.readFile('/copy/link'), 'b');
  assert.equal((await fs.lstat('/copy/link')).isSymbolicLink, true);
  await fs.symlink('/destination', '/destination-link');
  await fs.cp('/source/sub/file', '/destination-link');
  assert.equal(await fs.readFile('/destination'), 'a');
  const identity = (await fs.stat('/copy/sub/file')).identity;
  await fs.mv('/copy', '/moved');
  assert.equal((await fs.stat('/moved/sub/file')).identity, identity);
  assert.equal(fs.getAllPaths().includes('/copy'), false);
  assert.equal(fs.getAllPaths().includes('/moved/sub/file'), true);
  await assert.rejects(fs.mv('/source', '/source/sub/nested'), { code: 'EINVAL' });
  await fs.symlink('/source/sub', '/alias');
  await assert.rejects(fs.mv('/source', '/alias/nested'), { code: 'EINVAL' });
  await assert.rejects(fs.cp('/source', '/alias/nested', { recursive: true }), { code: 'EINVAL' });
  await fs.writeFile('/replacement', 'r');
  await fs.mv('/replacement', '/destination-link');
  assert.equal((await fs.lstat('/destination-link')).isSymbolicLink, false);
  assert.equal(await fs.readFile('/destination'), 'a');
});

test('exclusive create, modes and quotas are transactionally enforced across concurrent instances', async (t) => {
  const { fs, db } = await fixture(t, { limits: { maxFileBytes: 8, maxTotalBytes: 10, maxEntries: 6 } });
  const second = await WorkspaceFileSystem.open(db, 'test', { limits: { maxFileBytes: 8, maxTotalBytes: 10, maxEntries: 6 } });
  const results = await Promise.allSettled([fs.createExclusive('/private', { mode: 0o600 }), second.createExclusive('/private', { mode: 0o700 })]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await fs.stat('/private')).mode, 0o600);
  await fs.writeFile('/a', '12345678'); await fs.link('/a', '/b');
  await assert.rejects(fs.writeFile('/oversize', '123456789'), { code: 'EFBIG' });
  await assert.rejects(fs.writeFile('/overflow', '123'), { code: 'ENOSPC' });
  assert.equal(await fs.exists('/overflow'), false);
  await assert.rejects(fs.appendFile('/a', 'x'), { code: 'EFBIG' });
  await fs.writeFile('/a', '1');
  await fs.writeFile('/other', '1234567');
  await fs.symlink('/z', '/dangling');
  await assert.rejects(fs.createExclusive('/dangling', { mode: 0o600 }), { code: 'EEXIST' });
  await assert.rejects(fs.createExclusive('/extra', { mode: 0o600 }), { code: 'ENOSPC' });
  assert.deepEqual(fs.getAllPaths().sort(), second.getAllPaths().sort());
});

test('paths remain a virtual namespace and traversal has finite bounds', async (t) => {
  const { fs } = await fixture(t, { limits: { maxDepth: 3, maxPathLength: 50 } });
  for (const path of ['file:///etc/passwd', 'content://private/file', '/x\0y', '/a\\b', '/bad\ud800', '/bad\udc00']) {
    await assert.rejects(fs.writeFile(path, 'x'), { code: 'EINVAL' });
  }
  await assert.rejects(fs.mkdir('/a/b/c/d', { recursive: true }), { code: 'ENAMETOOLONG' });
  assert.deepEqual(await fs.readdir('/'), []);
  await fs.writeFile('../../inside', 'safe');
  assert.equal(await fs.readFile('/inside'), 'safe');
  assert.equal(fs.resolvePath('/a', '../../inside'), '/inside');
  const types = await fs.readdirWithFileTypes('/');
  assert.deepEqual(types, [{ name: 'inside', isFile: true, isDirectory: false, isSymbolicLink: false }]);
  await fs.writeFile('/hé😀', 'unicode name');
  assert.equal(await fs.readFile('/hé😀'), 'unicode name');
});

test('renames enforce trailing-slash types and depth of the entire relocated subtree', async (t) => {
  const { fs } = await fixture(t, { limits: { maxDepth: 3 } });
  await fs.writeFile('/file', 'a');
  await assert.rejects(fs.mv('/file/', '/new'), { code: 'ENOTDIR' });
  await assert.rejects(fs.mv('/file', '/new/'), { code: 'ENOTDIR' });
  await fs.mkdir('/tree/child', { recursive: true });
  await fs.writeFile('/tree/child/file', 'keep');
  await fs.mkdir('/deep/nested', { recursive: true });
  await assert.rejects(fs.mv('/tree', '/deep/nested/tree'), { code: 'ENAMETOOLONG' });
  assert.equal(await fs.readFile('/tree/child/file'), 'keep');
  assert.equal(await fs.exists('/deep/nested/tree'), false);
});

test('missing final entries obey depth and physically expanded path limits before creation', async (t) => {
  const { db, fs } = await fixture(t, { limits: { maxDepth: 2 } });
  await fs.mkdir('/a/b', { recursive: true });
  await assert.rejects(fs.writeFile('/a/b/c', 'bad'), { code: 'ENAMETOOLONG' });
  await fs.symlink('/a/b/c', '/dangling');
  await assert.rejects(fs.appendFile('/dangling', 'bad'), { code: 'ENAMETOOLONG' });
  assert.deepEqual(await fs.readdir('/a/b'), []);

  const shorter = await WorkspaceFileSystem.open(db, 'short-paths', { limits: { maxPathLength: 20 } });
  await shorter.mkdir('/1234567890/abcd', { recursive: true });
  await shorter.symlink('/1234567890/abcd', '/l');
  await assert.rejects(shorter.writeFile('/l/12345', 'bad'), { code: 'ENAMETOOLONG' });
  await assert.rejects(shorter.createExclusive('/l/12345', { mode: 0o600 }), { code: 'ENAMETOOLONG' });
  assert.deepEqual(await shorter.readdir('/1234567890/abcd'), []);
});

test('mounted absolute link targets retain their guest representation', async (t) => {
  const { db } = await fixture(t);
  const fs = await WorkspaceFileSystem.open(db, 'mounted', { mountPath: '/workspace' });
  await fs.writeFile('/file', 'inside');
  await fs.symlink('/workspace/file', '/link');
  assert.equal(await fs.readFile('/link'), 'inside');
  assert.equal(await fs.readlink('/link'), '/workspace/file');
  await fs.symlink('/tmp/outside', '/cross-mount');
  await assert.rejects(fs.readFile('/cross-mount'), { code: 'EXDEV' });
});

test('database, workspace-count and admitted allocation quotas reject before retaining excessive data', async (t) => {
  const { db } = await fixture(t);
  const limits = { maxWorkspaces: 3, maxDatabaseBytes: 5, maxQueuedBytes: 4 };
  const first = await WorkspaceFileSystem.open(db, 'first', { limits });
  const second = await WorkspaceFileSystem.open(db, 'second', { limits });
  await assert.rejects(WorkspaceFileSystem.open(db, 'fourth', { limits }), { code: 'ENOSPC' });
  const results = await Promise.allSettled([first.writeFile('/a', '1234'), second.writeFile('/b', '1234')]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].reason.code, 'ENOSPC');
  await second.writeFile('/b', 'x');
  await assert.rejects(second.appendFile('/b', 'x'), { code: 'ENOSPC' });
  assert.equal(await second.readFile('/b'), 'x');
});

test('database namespace cap counts empty files and roots across workspaces and snapshots', async (t) => {
  const db = createExpoSqliteDatabase(createNodeSqliteConnection());
  t.after(() => db.close());
  const options = { limits: { maxDatabaseEntries: 4 } };
  const first = await WorkspaceFileSystem.open(db, 'first', options);
  const second = await WorkspaceFileSystem.open(db, 'second', options);
  await first.writeFile('/empty', ''); await second.writeFile('/empty', '');
  await assert.rejects(first.writeFile('/overflow', ''), { code: 'ENOSPC' });
  await assert.rejects(WorkspaceFileSystem.open(db, 'third', options), { code: 'ENOSPC' });
  await assert.rejects(WorkspaceFileSystem.copyWorkspace(db, 'first', 'copy', options), { code: 'ENOSPC' });
  await second.rm('/empty');
  await first.createExclusive('/replacement', { mode: 0o600 });
  assert.equal((await db.get('SELECT SUM(entry_count+1) AS n FROM workspaces')).n, 4);
});
