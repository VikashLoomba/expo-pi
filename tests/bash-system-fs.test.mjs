import assert from 'node:assert/strict';
import test from 'node:test';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { createNodeSqliteConnection } from './helpers/node-sqlite.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { BoundedSystemFs } = await import('../src/pi/workspace/bounded-system-fs.ts');
const { createBashEngine } = await import('../src/pi/bash/engine/index.ts');
const { createExpoSqliteDatabase } = await import('../src/pi/storage/expo-sqlite.ts');
const { WorkspaceRuntime } = await import('../src/pi/workspace/runtime.ts');

test('empty files and automatically created parents consume a bounded namespace', async () => {
  const fs = new BoundedSystemFs({ maxEntries: 4 });
  fs.writeFileSync('/a/b/file', '');
  assert.equal(fs.getAllPaths().length, 4);
  await assert.rejects(fs.writeFile('/another', ''), /ENOSPC/);
  assert.throws(() => fs.mkdirSync('/x/y', { recursive: true }), /ENOSPC/);
  assert.equal(await fs.exists('/x'), false, 'failed admission does not insert partial parents');
  await fs.rm('/a', { recursive: true });
  await fs.appendFile('/new', 'available');
  assert.equal(await fs.readFile('/new'), 'available');
});

test('all entry-creating operations respect metadata quotas', async () => {
  for (const operation of [
    (fs) => fs.writeFileLazy('/new', () => ''),
    (fs) => fs.createExclusive('/new', { directory: false, mode: 0o600 }),
    (fs) => fs.symlink('/source', '/new'),
    (fs) => fs.link('/source', '/new'),
    (fs) => fs.cp('/source', '/new'),
    (fs) => fs.mv('/source', '/new'),
  ]) {
    const fs = new BoundedSystemFs({ maxEntries: 2 });
    fs.writeFileLazy('/source', () => 'lazy source');
    await assert.rejects(async () => operation(fs), /ENOSPC/);
    assert.equal(fs.getAllPaths().length, 2);
    assert.equal(await fs.readFile('/source'), 'lazy source');
  }
});

test('recursive copies preflight the complete destination namespace and depth', async () => {
  const fs = new BoundedSystemFs({ maxEntries: 6, maxDepth: 3 });
  fs.writeFileSync('/source/child/file', 'data');
  await assert.rejects(fs.cp('/source', '/copy', { recursive: true }), /ENOSPC/);
  assert.equal(await fs.exists('/copy'), false);
  const shallow = new BoundedSystemFs({ maxDepth: 3 });
  shallow.writeFileSync('/source/child/file', 'data');
  await assert.rejects(shallow.mv('/source', '/deep/destination'), /ENAMETOOLONG/);
  assert.equal(await shallow.exists('/deep'), false);
  await fs.rm('/source/child/file');
  await fs.cp('/source', '/copy', { recursive: true });
  assert.equal((await fs.stat('/copy/child')).isDirectory, true);
});

test('path strings, symlink targets and file bodies are independently bounded', async () => {
  const fs = new BoundedSystemFs({ maxTotalBytes: 8, maxPathLength: 16, maxDepth: 3 });
  await assert.rejects(fs.mkdir('/a/b/c/d', { recursive: true }), /ENAMETOOLONG/);
  await assert.rejects(fs.writeFile('/' + 'x'.repeat(17), ''), /ENAMETOOLONG/);
  await assert.rejects(fs.symlink('x'.repeat(17), '/link'), /ENAMETOOLONG/);
  await fs.writeFile('/bytes', '12345678');
  await assert.rejects(fs.writeFile('/more', '1'), /memory|storage|limit/i);
  await fs.writeFile('/bytes', 'small');
  await fs.writeFile('/more', '123');
});

test('successive shells share bounded system files while resetting shell variables and cwd', async (t) => {
  const manager = new WorkspaceRuntime(async () => createExpoSqliteDatabase(createNodeSqliteConnection()));
  t.after(() => manager.close());
  await manager.run('ephemeral', undefined, async ({ mounted, signal }) => {
    const result = await createBashEngine(mounted, 2000).exec(
      'printf saved > /workspace/keep; printf temporary > /tmp/session; export PREVIOUS=old; cd /tmp; test -f /bin/cat && test -d /proc && test -d /dev', { signal });
    assert.equal(result.exitCode, 0, result.stderr);
  });
  await manager.run('ephemeral', undefined, async ({ mounted, signal }) => {
    const result = await createBashEngine(mounted, 2000).exec('test -z "$PREVIOUS" && test "$PWD" = /workspace && cat /tmp/session /workspace/keep', { signal });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, 'temporarysaved');
  });
});
