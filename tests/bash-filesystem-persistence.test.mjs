import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { createExpoSqliteDatabase } from '../src/pi/storage/expo-sqlite.ts';
import { createNodeSqliteConnection } from './helpers/node-sqlite.mjs';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';

installBashBrowserHooks();
const { WorkspaceFileSystem } = await import('../src/pi/workspace/filesystem/index.ts');

test('database close/reopen preserves bytes, links and metadata; current-state copies are independent', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-workspace-fs-'));
  const filename = join(directory, 'test.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  let db = createExpoSqliteDatabase(createNodeSqliteConnection(filename));
  let fs = await WorkspaceFileSystem.open(db, 'original');
  await fs.mkdir('/dir'); await fs.writeFile('/dir/file', new Uint8Array([0, 255, 1]));
  await fs.link('/dir/file', '/hard'); await fs.symlink('dir/file', '/soft');
  await fs.chmod('/hard', 0o700); await fs.utimes('/hard', new Date(0), new Date(5678));
  const identity = (await fs.stat('/hard')).identity;
  await fs.drain(); await db.close();
  db = createExpoSqliteDatabase(createNodeSqliteConnection(filename));
  t.after(() => db.close());
  fs = await WorkspaceFileSystem.open(db, 'original');
  assert.deepEqual(await fs.readFileBuffer('/soft'), new Uint8Array([0, 255, 1]));
  assert.equal((await fs.stat('/hard')).identity, identity);
  assert.equal((await fs.stat('/hard')).mode, 0o700);
  assert.equal((await fs.stat('/hard')).mtime.getTime(), 5678);
  await WorkspaceFileSystem.copyWorkspace(db, 'original', 'fork');
  const fork = await WorkspaceFileSystem.open(db, 'fork');
  assert.notEqual((await fork.stat('/hard')).identity, identity);
  assert.equal((await fork.stat('/hard')).identity, (await fork.stat('/dir/file')).identity);
  await fork.writeFile('/hard', 'changed');
  assert.equal(await fork.readFile('/soft'), 'changed');
  assert.deepEqual(await fs.readFileBuffer('/hard'), new Uint8Array([0, 255, 1]));
  await assert.rejects(WorkspaceFileSystem.copyWorkspace(db, 'original', 'fork'), { code: 'EEXIST' });
  await WorkspaceFileSystem.deleteWorkspace(db, 'fork');
  await assert.rejects(fork.readFile('/hard'), { code: 'ENOENT' });
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM inodes WHERE workspace_id=?', 'fork')).n, 0);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM entries WHERE workspace_id=?', 'fork')).n, 0);
  assert.deepEqual(await db.all('PRAGMA foreign_key_check'), []);
});

for (const reason of [new Error('user canceled'), null]) test(`aborted work rolls back and drains, preserving ${reason === null ? 'null' : 'Error'} reason`, async (t) => {
  const native = createNodeSqliteConnection();
  const originalRun = native.runAsync;
  let abortDuringWrite;
  native.runAsync = async (sql, values) => {
    const result = await originalRun(sql, values);
    if (abortDuringWrite && sql.startsWith('UPDATE inodes SET data=')) abortDuringWrite();
    return result;
  };
  const db = createExpoSqliteDatabase(native);
  t.after(() => db.close());
  const fs = await WorkspaceFileSystem.open(db, 'cancel');
  await fs.writeFile('/file', 'before');
  const controller = new AbortController();
  const invocation = fs.forInvocation(controller.signal);
  abortDuringWrite = () => controller.abort(reason);
  const updating = invocation.writeFile('/file', 'after');
  const queued = invocation.writeFile('/queued', 'must not exist');
  const results = await Promise.allSettled([updating, queued]);
  assert.equal(results[0].reason, reason); assert.equal(results[1].reason, reason);
  await invocation.drain();
  abortDuringWrite = undefined;
  assert.equal(await fs.readFile('/file'), 'before');
  assert.equal(await fs.exists('/queued'), false);
  await assert.rejects(invocation.writeFile('/late', 'x'), (error) => error === reason);
  await fs.writeFile('/another-invocation', 'works');
});

test('failed migration rolls back DDL and version marker; newer schemas are rejected', async (t) => {
  const native = createNodeSqliteConnection();
  const exec = native.execAsync;
  native.execAsync = async (sql) => exec(sql.includes('CREATE TABLE entries') ? sql.replace('CREATE TABLE entries', 'CREATE TABLE invalid syntax entries') : sql);
  const db = createExpoSqliteDatabase(native);
  t.after(() => db.close());
  await assert.rejects(WorkspaceFileSystem.open(db, 'failed'));
  assert.equal((await db.get('PRAGMA user_version')).user_version, 0);
  assert.deepEqual(await db.all("SELECT name FROM sqlite_master WHERE type='table'"), []);
  native.execAsync = exec;
  const recovered = await WorkspaceFileSystem.open(db, 'retry');
  await recovered.writeFile('/working', 'recovered on the same database owner');
  assert.equal(await recovered.readFile('/working'), 'recovered on the same database owner');
  assert.equal((await db.get('PRAGMA user_version')).user_version, 1);
  const newer = createExpoSqliteDatabase(createNodeSqliteConnection());
  t.after(() => newer.close());
  await newer.exec('PRAGMA user_version=2');
  await assert.rejects(WorkspaceFileSystem.open(newer, 'future'), /newer/);
});

test('independent connections read current state; explicit refresh updates the synchronous namespace index', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-workspace-connections-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const firstDb = createExpoSqliteDatabase(createNodeSqliteConnection(join(directory, 'test.db')));
  const secondDb = createExpoSqliteDatabase(createNodeSqliteConnection(join(directory, 'test.db')));
  t.after(async () => { await firstDb.close(); await secondDb.close(); });
  const first = await WorkspaceFileSystem.open(firstDb, 'same');
  const second = await WorkspaceFileSystem.open(secondDb, 'same');
  await first.writeFile('/first', 'one');
  assert.equal(await second.readFile('/first'), 'one');
  await second.appendFile('/first', 'two');
  assert.equal(await first.readFile('/first'), 'onetwo');
  await assert.rejects(second.createExclusive('/first', { mode: 0o600 }), { code: 'EEXIST' });
  await second.refresh();
  assert.deepEqual(second.getAllPaths(), ['/', '/first']);
});

test('copy quota failure rolls back all destination entries and preserves both source and cache', async (t) => {
  const db = createExpoSqliteDatabase(createNodeSqliteConnection());
  t.after(() => db.close());
  const fs = await WorkspaceFileSystem.open(db, 'quota', { limits: { maxTotalBytes: 7 } });
  await fs.mkdir('/source'); await fs.writeFile('/source/a', '123'); await fs.writeFile('/source/b', '45');
  const paths = fs.getAllPaths().sort();
  await assert.rejects(fs.cp('/source', '/copy', { recursive: true }), { code: 'ENOSPC' });
  assert.deepEqual(fs.getAllPaths().sort(), paths);
  assert.equal(await fs.exists('/copy'), false);
  assert.equal((await db.get('SELECT bytes FROM workspaces WHERE id=?', 'quota')).bytes, 5);
  await assert.rejects(WorkspaceFileSystem.copyWorkspace(db, 'quota', 'too-small', { limits: { maxTotalBytes: 4 } }), { code: 'ENOSPC' });
  assert.equal(await db.get('SELECT id FROM workspaces WHERE id=?', 'too-small'), undefined);
});

test('a deleted workspace cannot be silently revived or accessed through an old handle after recreation', async (t) => {
  const db = createExpoSqliteDatabase(createNodeSqliteConnection());
  t.after(() => db.close());
  const old = await WorkspaceFileSystem.open(db, 'generation');
  await old.writeFile('/old', 'old');
  await WorkspaceFileSystem.deleteWorkspace(db, 'generation');
  await assert.rejects(old.refresh(), { code: 'ENOENT' });
  const replacement = await WorkspaceFileSystem.open(db, 'generation');
  await replacement.writeFile('/new', 'new');
  await assert.rejects(old.readFile('/new'), { code: 'ESTALE' });
  await assert.rejects(old.refresh(), { code: 'ESTALE' });
});

test('independent concurrent SQLite connections serialize exclusive creation, appends and quota decisions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-workspace-workers-'));
  const filename = join(directory, 'test.db');
  const db = createExpoSqliteDatabase(createNodeSqliteConnection(filename));
  t.after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }); });
  const fs = await WorkspaceFileSystem.open(db, 'shared', { limits: { maxTotalBytes: 40 } });
  await fs.writeFile('/append', '');
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { installBashBrowserHooks } = await import(workerData.hooks); installBashBrowserHooks();
      const { WorkspaceFileSystem } = await import(workerData.fs);
      const { createExpoSqliteDatabase } = await import(workerData.driver);
      const { createNodeSqliteConnection } = await import(workerData.connection);
      const db = createExpoSqliteDatabase(createNodeSqliteConnection(workerData.filename));
      const fs = await WorkspaceFileSystem.open(db, 'shared', {limits:{maxTotalBytes:40}});
      parentPort.postMessage('ready');
      await new Promise(resolve => parentPort.once('message', resolve));
      let exclusive;
      try { await fs.createExclusive('/winner',{mode:384}); exclusive='created'; }
      catch(error) { exclusive=error.code; }
      for(let i=0;i<20;i++) await fs.appendFile('/append','x');
      await db.close(); parentPort.postMessage({exclusive});
    })().catch(error => { parentPort.postMessage({error:String(error)}); process.exitCode=1; });
  `;
  const workers = Array.from({ length: 2 }, () => new Worker(workerSource, { eval: true, workerData: {
    filename, hooks: new URL('./helpers/bash-browser-hooks.mjs', import.meta.url).href,
    fs: new URL('../src/pi/workspace/filesystem/index.ts', import.meta.url).href,
    driver: new URL('../src/pi/storage/expo-sqlite.ts', import.meta.url).href,
    connection: new URL('./helpers/node-sqlite.mjs', import.meta.url).href,
  } }));
  t.after(() => Promise.all(workers.map((worker) => worker.terminate())));
  await Promise.all(workers.map((worker) => new Promise((resolve, reject) => {
    worker.once('error', reject); worker.once('message', (value) => value === 'ready' ? resolve() : reject(new Error(JSON.stringify(value))));
  })));
  const outcomes = workers.map((worker) => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }));
  for (const worker of workers) worker.postMessage('start');
  const results = await Promise.all(outcomes);
  assert.deepEqual(results.map((result) => result.exclusive).sort(), ['EEXIST', 'created']);
  assert.equal((await fs.readFile('/append')).length, 40);
  await assert.rejects(fs.appendFile('/append', 'x'), { code: 'ENOSPC' });
  assert.equal((await db.get('SELECT bytes FROM workspaces WHERE id=?', 'shared')).bytes, 40);
});
