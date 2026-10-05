import assert from 'node:assert/strict';
import test from 'node:test';
import { createSharedDatabasePool } from '../src/pi/workspace/shared-database.ts';
import { createExpoSqliteDatabase } from '../src/pi/storage/expo-sqlite.ts';
import { createNodeSqliteConnection } from './helpers/node-sqlite.mjs';

test('concurrent leases share exactly one connection and transaction queue', async () => {
  let opened = 0;
  let closed = 0;
  const acquire = createSharedDatabasePool(async () => {
    opened++;
    const native = createNodeSqliteConnection();
    const close = native.closeAsync.bind(native);
    native.closeAsync = async () => { closed++; await close(); };
    return createExpoSqliteDatabase(native);
  });
  const [a, b] = await Promise.all([acquire('files'), acquire('files')]);
  assert.equal(opened, 1);
  await a.exec('CREATE TABLE counter(value INTEGER); INSERT INTO counter VALUES(0)');
  await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? a : b).transaction(async (tx) => {
    const { value } = await tx.get('SELECT value FROM counter');
    await new Promise((resolve) => setImmediate(resolve));
    await tx.run('UPDATE counter SET value=?', value + 1);
  })));
  assert.equal((await a.get('SELECT value FROM counter')).value, 20);
  await a.close();
  await assert.rejects(a.get('SELECT 1'), /lease is closed/);
  assert.equal(closed, 0);
  assert.equal((await b.get('SELECT value FROM counter')).value, 20);
  await Promise.all([b.close(), b.close()]);
  assert.equal(closed, 1);
});

test('last lease drains admitted writes before closing and a new lease waits for close', async () => {
  let opened = 0;
  let unblock;
  const barrier = new Promise((resolve) => { unblock = resolve; });
  const acquire = createSharedDatabasePool(async () => {
    opened++;
    const database = createExpoSqliteDatabase(createNodeSqliteConnection());
    const close = database.close;
    if (opened === 1) database.close = async () => { await barrier; await close(); };
    return database;
  });
  const first = await acquire('files');
  await first.exec('CREATE TABLE test(value INTEGER)');
  const admitted = first.run('INSERT INTO test VALUES(42)');
  const closing = first.close();
  let acquired = false;
  const reopened = acquire('files').then((value) => { acquired = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acquired, false);
  await admitted;
  unblock();
  await closing;
  await (await reopened).close();
  assert.equal(opened, 2);
});

test('failed shared opens release their entry and distinct names own distinct connections', async () => {
  let attempts = 0;
  const acquire = createSharedDatabasePool(async () => {
    if (++attempts === 1) throw new Error('temporary open failure');
    return createExpoSqliteDatabase(createNodeSqliteConnection());
  });
  const failed = await Promise.allSettled([acquire('files'), acquire('files')]);
  assert.ok(failed.every((value) => value.status === 'rejected'));
  const a = await acquire('files');
  const b = await acquire('other');
  assert.equal(attempts, 3);
  await a.exec('CREATE TABLE only_a(value INTEGER)');
  await assert.rejects(b.get('SELECT * FROM only_a'), /no such table/);
  await Promise.all([a.close(), b.close()]);
});
