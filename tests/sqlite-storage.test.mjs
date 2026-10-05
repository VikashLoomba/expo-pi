import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { createStorageConformance } from '@earendil-works/pi-durable/testing';
import { createExpoSqliteDatabase } from '../src/pi/storage/expo-sqlite.ts';
import { createNodeSqliteConnection } from './helpers/node-sqlite.mjs';

const context = BACKGROUND_CONTEXT;
const storageEntry = new URL('../src/pi/storage/index.ts', import.meta.url).href;
const nativeUrl = 'test:expo-sqlite';
const helperUrl = new URL('./helpers/node-sqlite.mjs', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'expo-sqlite') return { url: nativeUrl, shortCircuit: true };
    if (context.parentURL === storageEntry && specifier === './expo-sqlite') {
      return { url: new URL('../src/pi/storage/expo-sqlite.ts', import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === nativeUrl) return {
      format: 'module', shortCircuit: true,
      source: `import { createNodeSqliteConnection } from ${JSON.stringify(helperUrl)};
        export const native = { open: async (name) => createNodeSqliteConnection(name) };
        export const openDatabaseAsync = (...args) => native.open(...args);`,
    };
    return nextLoad(url, context);
  },
});
test.after(() => hooks.deregister());
const { native } = await import('expo-sqlite');
const { openExpoSqliteStorage } = await import(storageEntry);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function database(t) {
  const native = createNodeSqliteConnection();
  const db = createExpoSqliteDatabase(native);
  t.after(() => db.close());
  return { db, native };
}

// All upstream cases run against the actual portable storage and actual SQLite,
// with only Expo's native database connection substituted for this Node process.
for (const scenario of createStorageConformance({
  assertions: {
    ok: (value, message) => assert.ok(value, message),
    strictEqual: (actual, expected) => assert.equal(actual, expected),
    deepEqual: (actual, expected) => assert.deepEqual(actual, expected),
    partialDeepEqual: (actual, expected) => assert.partialDeepStrictEqual(actual, expected),
    greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} must be greater than ${expected}`),
    rejects: (operation, messageIncludes) => assert.rejects(operation, (error) => {
      assert.ok(error.message.includes(messageIncludes), `${error.message} must include ${messageIncludes}`);
      return true;
    }),
  },
  withStorage: async (runCase) => {
    const storage = await SqliteStorage.open(createExpoSqliteDatabase(createNodeSqliteConnection()));
    try { await runCase(storage); } finally { await storage.close(context); }
  },
})) test(`Pi storage conformance: ${scenario.name}`, scenario.run);

test('Expo driver binds strings, blobs, null and safe bigint without interpolating SQL', async (t) => {
  const { db } = database(t);
  await db.exec('CREATE TABLE values_test (id INTEGER PRIMARY KEY, text_value TEXT, blob_value BLOB, optional_value TEXT);');
  const text = "'); DROP TABLE values_test; --";
  await db.run('INSERT INTO values_test VALUES (?, ?, ?, ?)', 12n, text, new Uint8Array([0, 128, 255]), null);
  const row = await db.get('SELECT * FROM values_test WHERE id = ?', 12n);
  assert.deepEqual({ ...row }, { id: 12, text_value: text, blob_value: new Uint8Array([0, 128, 255]), optional_value: null });
  assert.equal(await db.get('SELECT * FROM values_test WHERE id = ?', 99), undefined);
  assert.equal((await db.all('SELECT * FROM values_test')).length, 1);
  assert.equal((await db.get('SELECT ? AS value', 9007199254740991n)).value, Number.MAX_SAFE_INTEGER);
  await assert.rejects(db.run('INSERT INTO values_test (id) VALUES (?)', 9007199254740993n), /safe integer range/);
  await assert.rejects(db.get('SELECT ? AS value', -9007199254740993n), /safe integer range/);
  assert.equal((await db.get('SELECT count(*) AS count FROM values_test')).count, 1);
});

test('Expo driver serializes ordinary async operations and recovers its queue after a rejection', async (t) => {
  const { db, native } = database(t);
  await db.exec('CREATE TABLE values_test (id INTEGER)');
  const started = deferred();
  const release = deferred();
  const originalRun = native.runAsync.bind(native);
  t.mock.method(native, 'runAsync', async (sql, params) => {
    started.resolve();
    await release.promise;
    return originalRun(sql, params);
  });
  const write = db.run('INSERT INTO values_test VALUES (?)', 7);
  await started.promise;
  let readFinished = false;
  const read = db.get('SELECT count(*) AS count FROM values_test').then((row) => { readFinished = true; return row; });
  await new Promise((resolve) => setImmediate(resolve));
  try { assert.equal(readFinished, false); } finally { release.resolve(); }
  await write;
  assert.equal((await read).count, 1);
  await assert.rejects(db.exec('INVALID SQL'), /syntax error/);
  assert.equal((await db.get('SELECT count(*) AS count FROM values_test')).count, 1);
});

test('transactions queue outside work and invalidate their handle before the asynchronous commit settles', async (t) => {
  const { db, native } = database(t);
  await db.exec('CREATE TABLE values_test (id INTEGER)');
  const commitStarted = deferred();
  const releaseCommit = deferred();
  const originalExec = native.execAsync.bind(native);
  t.mock.method(native, 'execAsync', async (sql) => {
    if (sql === 'COMMIT') { commitStarted.resolve(); await releaseCommit.promise; }
    return originalExec(sql);
  });
  let handle;
  const transaction = db.transaction(async (tx) => {
    handle = tx;
    await Promise.all([tx.run('INSERT INTO values_test VALUES (?)', 1), tx.run('INSERT INTO values_test VALUES (?)', 2)]);
    return 'committed';
  });
  let outsideFinished = false;
  const outside = db.run('INSERT INTO values_test VALUES (?)', 3).then(() => { outsideFinished = true; });
  await commitStarted.promise;
  try {
    await assert.rejects(handle.run('INSERT INTO values_test VALUES (?)', 99), /no longer active/);
    assert.equal(outsideFinished, false);
  } finally {
    releaseCommit.resolve();
  }
  assert.equal(await transaction, 'committed');
  await outside;
  assert.deepEqual((await db.all('SELECT id FROM values_test ORDER BY rowid')).map((row) => row.id), [1, 2, 3]);
});

test('rollback removes partial writes, preserves the callback error and lets queued work continue', async (t) => {
  const { db } = database(t);
  await db.exec('CREATE TABLE values_test (id INTEGER)');
  const callbackError = new Error('synthetic callback failure');
  let handle;
  const transaction = db.transaction(async (tx) => {
    handle = tx;
    await tx.run('INSERT INTO values_test VALUES (?)', 1);
    throw callbackError;
  });
  const outside = db.run('INSERT INTO values_test VALUES (?)', 2);
  await assert.rejects(transaction, (error) => error === callbackError);
  await outside;
  await assert.rejects(handle.get('SELECT 1'), /no longer active/);
  assert.deepEqual((await db.all('SELECT id FROM values_test')).map((row) => row.id), [2]);
});

test('a failed commit is rolled back before the transaction rejects', async (t) => {
  const { db, native } = database(t);
  await db.exec('CREATE TABLE values_test (id INTEGER)');
  const originalExec = native.execAsync.bind(native);
  const commitError = new Error('synthetic commit failure');
  t.mock.method(native, 'execAsync', async (sql) => {
    if (sql === 'COMMIT') throw commitError;
    return originalExec(sql);
  });
  await assert.rejects(db.transaction(async (tx) => {
    await tx.run('INSERT INTO values_test VALUES (?)', 1);
  }), (error) => error === commitError);
  assert.equal((await db.get('SELECT count(*) AS count FROM values_test')).count, 0);
});

test('rollback failure is distinguishable from callback failure and stops reuse of the uncertain connection', async (t) => {
  const { db, native } = database(t);
  const callbackError = new Error('synthetic callback failure');
  const rollbackError = new Error('synthetic rollback failure');
  const originalExec = native.execAsync.bind(native);
  t.mock.method(native, 'execAsync', async (sql) => {
    if (sql === 'ROLLBACK') throw rollbackError;
    return originalExec(sql);
  });
  const transaction = db.transaction(async () => { throw callbackError; });
  let failure;
  await assert.rejects(transaction, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [callbackError, rollbackError]);
    failure = error;
    return true;
  });
  await assert.rejects(db.get('SELECT 1'), (error) => error === failure);
});

test('close waits for admitted transactions, rejects new calls and closes the native connection once', async (t) => {
  const { db, native } = database(t);
  const entered = deferred();
  const release = deferred();
  const close = t.mock.method(native, 'closeAsync');
  const transaction = db.transaction(async (tx) => {
    entered.resolve();
    await release.promise;
    await tx.exec('CREATE TABLE before_close (id INTEGER)');
  });
  await entered.promise;
  const closed = db.close();
  try {
    assert.equal(db.close(), closed);
    await assert.rejects(db.get('SELECT 1'), /closing or closed/);
    assert.equal(close.mock.callCount(), 0);
  } finally {
    release.resolve();
  }
  await transaction;
  await closed;
  assert.equal(close.mock.callCount(), 1);
  await assert.rejects(db.transaction(async () => {}), /closing or closed/);
});

test('openExpoSqliteStorage owns a separate connection and configures the default persistent database', async (t) => {
  let connection;
  const open = t.mock.method(native, 'open', async (name, options) => {
    assert.equal(name, 'pi-chats.db');
    assert.deepEqual(options, { useNewConnection: true });
    connection = createNodeSqliteConnection();
    return connection;
  });
  const storage = await openExpoSqliteStorage();
  try {
    assert.equal(open.mock.callCount(), 1);
    assert.equal((await connection.getFirstAsync('PRAGMA foreign_keys')).foreign_keys, 1);
    assert.equal((await connection.getFirstAsync('PRAGMA busy_timeout')).timeout, 5000);
    assert.equal((await connection.getFirstAsync('PRAGMA synchronous')).synchronous, 1);
    assert.equal(await storage.mintId(), 2);
  } finally {
    await storage.close(context);
  }
});

test('failed database configuration closes its native connection and preserves the original error', async (t) => {
  const connection = createNodeSqliteConnection();
  const originalError = new Error('synthetic configuration failure');
  const close = t.mock.method(connection, 'closeAsync');
  t.mock.method(connection, 'execAsync', async () => { throw originalError; });
  t.mock.method(native, 'open', async () => connection);
  await assert.rejects(openExpoSqliteStorage(), (error) => error === originalError);
  assert.equal(close.mock.callCount(), 1);
});

test('Expo storage reopening preserves separate conversations, entries, commit sequence and next ID', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-expo-sqlite-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'chats.db');
  const first = await openExpoSqliteStorage(filename);
  const chatA = await first.mintId();
  const chatB = await first.mintId();
  const entryA = await first.mintId();
  const entryB = await first.mintId();
  let sequence;
  try {
    sequence = await first.commit([
      { type: 'conversation', value: { id: 1 } },
      { type: 'conversation', value: { id: chatA, ownerConversationId: 1 } },
      { type: 'conversation', value: { id: chatB, ownerConversationId: 1 } },
      { type: 'entry', value: { id: entryA, conversationId: chatA, kind: 'message', data: { role: 'user', text: 'First chat' } } },
      { type: 'entry', value: { id: entryB, conversationId: chatB, kind: 'message', data: { role: 'assistant', text: 'Second chat' } } },
    ], context);
  } finally {
    await first.close(context);
  }
  const reopened = await openExpoSqliteStorage(filename);
  try {
    assert.deepEqual((await reopened.scanConversations({}, 10, undefined, context)).items.map(({ id }) => id), [1, chatA, chatB]);
    assert.equal((await reopened.entry(entryA, context)).entry.data.text, 'First chat');
    assert.equal((await reopened.entry(entryB, context)).entry.conversationId, chatB);
    const nextId = await reopened.mintId();
    assert.ok(nextId > entryB);
    const nextSequence = await reopened.commit([
      { type: 'entry', value: { id: nextId, conversationId: chatA, kind: 'message', data: { text: 'After restart' } } },
    ], context);
    assert.ok(nextSequence > sequence);
  } finally {
    await reopened.close(context);
  }
});
