import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTask } from '@earendil-works/pi-durable';

import {
  MemoryDoc, MessageDoc, NodeDoc, appendMessage, clipToolText, publishNode, renderCompaction, renderMain,
  type NodeRef,
} from '../src/pi/infinichat/memory';
import { BuildNode, ConfigDoc, pumpBuilds } from '../src/pi/infinichat/summary';

/**
 * A node records the task that built it. These tests publish nodes themselves, so they name a task that builds
 * nothing and ends at once, whose ID pi-durable issues.
 */
const Builder = defineTask<null, { phase: 'done' }, string>({
  name: 'independent.builder',
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: '' } }), ctx),
  },
  abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
});

async function memoryHarness() {
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'independent-memory', tasks: [Builder] }));
  const h = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);
  const root = await h.root(context, {
    init: async (tx, id) => {
      await tx.doc(MemoryDoc, id);
    },
  });
  const builder = await h.commit((tx) => tx.createTask(Builder, null, {
    conversationId: root.id,
    ownership: { kind: 'conversation' },
    background: true,
  }), context);
  return { h, root, builder };
}
const input = (text: string, source = 'test') =>
  ({ kind: 'user' as const, text, date: '2026-10-15T01:02:03.000Z', source, images: [] });

test('independent scalar clipping and exact lossless canonical splitting', async () => {
  // The accent is a combining mark, a scalar of its own.
  const text = '😀e\u0301雪'.repeat(12_000);
  const clipped = clipToolText(text);
  const chars = Array.from(text);
  // UniiChat's clip: 15,000 from the head, 14,936 from the tail, and a marker that counts what it cut.
  assert.equal(chars.length - 15_000 - 14_936, 18_064);
  const marker = '\n[... 18064 characters cut ...]\n';
  assert.equal(clipped, chars.slice(0, 15_000).join('') + marker + chars.slice(-14_936).join(''));
  assert.ok(Array.from(clipped).length <= 30_000);
  assert.ok(clipped.startsWith(text.slice(0, 200)));
  assert.ok(clipped.endsWith(text.slice(-200)));
  const { h, root } = await memoryHarness();
  try {
    const images = [{ data: 'original', mimeType: 'image/png' }];
    const ids = await h.commit((tx) => appendMessage(tx, root.id, { ...input(text), images }, true), context);
    const records = await Promise.all(ids.map((i) => h.snapshot(MessageDoc, root.id, String(i), context)));
    const stored = records.flatMap((record) => (record ? [record] : []));
    assert.equal(stored.length, ids.length);
    assert.equal(stored.map((x) => x.text).join(''), text);
    assert.equal(stored.reduce((n, x) => n + x.images.length, 0), 1);
    assert.ok(stored.every((x) => x.bytes === Buffer.byteLength(x.text, 'utf8')));
  } finally {
    await h.close(context);
  }
});

test('independent compaction cutoff stops at hole and never exposes future text', async () => {
  const { h, root, builder } = await memoryHarness();
  try {
    await h.commit(async (tx) => {
      for (let i = 0; i < 5; i++) await appendMessage(tx, root.id, input(`SOURCE_${i}`), true);
      for (const i of [0, 2, 3, 4]) {
        await publishNode(tx, root.id, { ref: [0, i], text: `user: SOURCE_${i}`, bytes: 14, builder });
      }
      assert.equal(await renderCompaction(tx, root.id, 5), '<chat>\n0+1|user: SOURCE_0\n</chat>');
      await assert.rejects(() => renderMain(tx, root.id), /not ready/);
      await publishNode(tx, root.id, { ref: [0, 1], text: 'user: SOURCE_1', bytes: 14, builder });
      const beforeTwo = await renderCompaction(tx, root.id, 2);
      assert.ok(beforeTwo.includes('SOURCE_0'));
      assert.ok(beforeTwo.includes('SOURCE_1'));
      assert.ok(!beforeTwo.includes('SOURCE_2'));
      assert.ok(!beforeTwo.includes('not summarized'));
      const complete = await renderMain(tx, root.id);
      for (let i = 0; i < 5; i++) assert.ok(complete.includes(`SOURCE_${i}`));
    }, context);
  } finally {
    await h.close(context);
  }
});

test('independent permanent node publication refuses overwrite', async () => {
  const { h, root, builder } = await memoryHarness();
  try {
    await h.commit(async (tx) => {
      await appendMessage(tx, root.id, input('exact'));
      await publishNode(tx, root.id, { ref: [0, 0], text: 'user: exact', bytes: 11, builder });
    }, context);
    await assert.rejects(
      h.commit((tx) => publishNode(tx, root.id, { ref: [0, 0], text: 'changed', bytes: 7, builder }), context),
      /already published/,
    );
    assert.equal((await h.snapshot(NodeDoc, root.id, '0:0', context))?.value?.text, 'user: exact');
  } finally {
    await h.close(context);
  }
});

test('independent incomplete sawtooth waits for a message boundary rather than parent publication', async () => {
  const { h, root, builder } = await memoryHarness();
  try {
    await h.commit(async (tx) => {
      for (let i = 0; i < 260; i++) {
        await appendMessage(tx, root.id, input(`message ${i}`));
        await publishNode(tx, root.id, { ref: [0, i], text: 'x'.repeat(500), bytes: 500, builder });
      }
      const s = await tx.doc(MemoryDoc, root.id);
      assert.equal(s.main.reducing, true);
      assert.equal(s.main.refs.length, 260);
      const saved = JSON.stringify(s.main.refs);
      for (let i = 0; i < 130; i++) {
        const text = `pair${i}`;
        await publishNode(tx, root.id, { ref: [1, i], text, bytes: Buffer.byteLength(text), builder });
      }
      assert.equal(JSON.stringify(s.main.refs), saved, 'Parent completions cannot create a new message boundary');
      await appendMessage(tx, root.id, input('next boundary'));
      await publishNode(tx, root.id, { ref: [0, 260], text: 'next', bytes: 4, builder });
      await renderMain(tx, root.id);
      assert.equal(s.main.reducing, false);
      assert.ok(s.main.refs.length < 260);
    }, context);
  } finally {
    await h.close(context);
  }
});

test('independent failed summary, Harness retries off, retries on next assistant canonical message, not pump',
  async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    // Not the model's own failure (a missing credential), with the Harness's retries off: released until the next
    // message.
    faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'No API key for provider: faux' }),
      fauxAssistantMessage('summary recovered'),
    ]);
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'independent-summary', tasks: [BuildNode] }));
    const settings = { retry: { enabled: false } };
    const h = await Harness.open(new MemoryStorage(), { models, registry, settings }, context);
    const root = await h.root(context);
    const model = { provider: 'faux', modelId: faux.getModel().id };
    try {
      const first = await h.commit(async (tx) => {
        (await tx.doc(ConfigDoc, root.id)).summary = { model, thinkingLevel: 'off' };
        await appendMessage(tx, root.id, input('long '.repeat(300)));
        return await pumpBuilds(tx, root.id);
      }, context);
      assert.equal(first.length, 1);
      assert.equal((await h.waitForTask(first[0], context)).state.outcome.status, 'failed');
      assert.deepEqual(await h.commit((tx) => pumpBuilds(tx, root.id), context), []);
      assert.equal(faux.state.callCount, 1);
      const retry = await h.commit(async (tx) => {
        await appendMessage(tx, root.id, { ...input('later assistant reply'), kind: 'infinichat' });
        return await pumpBuilds(tx, root.id);
      }, context);
      assert.ok(retry.length >= 1);
      for (const id of retry) await h.waitForTask(id, context);
      assert.equal((await h.snapshot(NodeDoc, root.id, '0:0', context))?.value?.text, 'summary recovered');
      assert.equal(faux.state.callCount, 2);
    } finally {
      await h.close(context);
    }
  });

test('independent strict main and compact high-water byte thresholds', async () => {
  for (const [count, target, field] of [[256, 128_000, 'main'], [64, 32_000, 'compact']] as const) {
    const { h, root, builder } = await memoryHarness();
    try {
      await h.commit(async (tx) => {
        // A view's size is its lines' text, as UniiChat counts it: legal 500-byte lines reach the threshold exactly.
        const lengths = Array<number>(count).fill(target / count);
        assert.ok(lengths.every((n) => n <= 512), 'Fixture must use legal <=512-byte node text');
        for (let i = 0; i < count; i++) {
          await appendMessage(tx, root.id, input(`source${i}`));
          await publishNode(tx, root.id, { ref: [0, i], text: 'x'.repeat(lengths[i]), bytes: lengths[i], builder });
          // Parents become available normally, after both children, but must not trigger a main batch.
          if (i % 2 === 1) await publishNode(tx, root.id, { ref: [1, (i - 1) / 2], text: 'p', bytes: 1, builder });
        }
        const s = await tx.doc(MemoryDoc, root.id);
        assert.equal(s[field].reducing, false);
        const compactBefore = s.compact.refs.map((ref): NodeRef => [ref[0], ref[1]]);
        await appendMessage(tx, root.id, input('threshold plus one'));
        await publishNode(tx, root.id, { ref: [0, count], text: 'x', bytes: 1, builder });
        assert.ok(s[field].refs.length < count);
        // Each view batches on its own size: the chat's batch only appends to the compactions' view. A copy is
        // compared, as above: Bun's strict deepEqual does not take pi-durable's document proxy for an equal array,
        // and composing that failure's message from the proxy never ends.
        const compactAfter = s.compact.refs.map((ref): NodeRef => [ref[0], ref[1]]);
        if (field === 'main') assert.deepEqual(compactAfter, [...compactBefore, [0, count]]);
      }, context);
    } finally {
      await h.close(context);
    }
  }
});
