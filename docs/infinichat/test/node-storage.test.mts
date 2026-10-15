import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, createRegistry, defineDoc } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai';
import { openNodeStore } from '../src/node.mjs';

const ctx = BACKGROUND_CONTEXT;
const ValueDoc = defineDoc<{ value: string }>({
  kind: 'storage-proof', version: 1, scope: 'conversation', history: 'latest',
  fork: 'current', initial: () => ({ value: '' }),
});

test('Linux exclusive writer, FULL transaction storage, and exact reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'optchat-store-'));
  try {
    const owner = await openNodeStore(dir);
    await assert.rejects(openNodeStore(dir), /already has a writer/);
    const harness = await Harness.open(owner.storage, { models: createModels(), registry: createRegistry() }, ctx);
    const root = await harness.root(ctx, { init: async (tx, id) => {
      (await tx.doc(ValueDoc, id)).value = 'exact persisted view refs';
    } });
    const rootId = root.id;
    assert.equal((await harness.snapshot(ValueDoc, rootId, ctx))?.value, 'exact persisted view refs');
    await harness.close(ctx);
    await owner.close(ctx);
    const reopened = await openNodeStore(dir);
    const next = await Harness.open(reopened.storage, { models: createModels(), registry: createRegistry() }, ctx);
    assert.equal((await next.snapshot(ValueDoc, rootId, ctx))?.value, 'exact persisted view refs');
    await next.close(ctx);
    await reopened.close(ctx);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('acknowledged native records survive SIGKILL and kernel ownership releases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'optchat-writer-'));
  const moduleURL = new URL('../src/node.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { openNodeStore } from ${JSON.stringify(moduleURL)};
     import { Harness, createRegistry, defineDoc } from '@earendil-works/pi-durable';
     import { createModels } from '@earendil-works/pi-ai';
     import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
     const Doc = defineDoc({ kind: 'storage-proof', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({value: ''}) });
     const owner = await openNodeStore(${JSON.stringify(dir)});
     const h = await Harness.open(owner.storage, {models: createModels(), registry: createRegistry()}, BACKGROUND_CONTEXT);
     const root = await h.root(BACKGROUND_CONTEXT, {init: async (tx,id) => { (await tx.doc(Doc,id)).value = 'committed before process death'; }});
     process.stdout.write(root.id + '\\n'); setInterval(() => {}, 1000);`],
    { stdio: ['ignore', 'pipe', 'pipe'], cwd: new URL('..', import.meta.url) });
  try {
    const ready = await Promise.race([
      once(child.stdout, 'data').then(([data]) => String(data)),
      once(child, 'exit').then(([code]) => { throw new Error('Child exited before ownership: ' + code); }),
    ]);
    const rootId = Number(ready.trim()) as Parameters<Harness['conversation']>[0];
    assert.ok(rootId);
    await assert.rejects(openNodeStore(dir), /already has a writer/);
    const exited = once(child, 'exit');
    child.kill('SIGKILL'); await exited;
    const owner = await openNodeStore(dir);
    const recovered = await Harness.open(owner.storage, { models: createModels(), registry: createRegistry() }, ctx);
    assert.equal((await recovered.snapshot(ValueDoc, rootId, ctx))?.value, 'committed before process death');
    await recovered.close(ctx);
    await owner.close(ctx);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});
