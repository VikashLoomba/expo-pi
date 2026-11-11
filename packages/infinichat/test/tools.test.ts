import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import {
  createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Context as ModelContext, type ImageContent,
  type TextContent,
} from '@earendil-works/pi-ai';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createBashTool } from '@earendil-works/pi-durable/tools';
import { obj, str } from '@earendil-works/pi-schema';

import { MemoryDoc, MessageDoc, clipToolText } from '../src/pi/infinichat/memory';
import { sharedPrompt, subagentPrompt } from '../src/pi/infinichat/prompt';
import { memoryTools, toolPolicy } from '../src/pi/infinichat/tools';

/** The tool results in the requests a model was sent, in order. */
const toolResults = (requests: ModelContext[]) => requests
  .flatMap((request) => request.messages)
  .flatMap((message) => (message.role === 'toolResult' ? [message] : []));
const textOf = (content: readonly (TextContent | ImageContent)[]) =>
  content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');

test('the prompts name the agent and drop the device paragraphs without device tools', () => {
  // The program a device runs is the agent too; the kind "infinichat" of the agent's replies stays.
  assert.ok(sharedPrompt('OptChat', true).includes('- infinichat: OptChat'));
  assert.ok(sharedPrompt('OptChat', true).includes('have OptChat open now'));
  assert.equal(sharedPrompt('Dot', false).includes('The user\'s computers'), false);
  assert.ok(subagentPrompt('OptChat', true).includes('infinichat\n(OptChat\'s replies)'));
  assert.ok(subagentPrompt('OptChat', true).includes('runs OptChat on'));
  assert.equal(subagentPrompt('Dot', false).includes('Devices:'), false);
  // UniiChat's SUB_HEAD: its first message is the view, then its chat so far, which it may be sent more of.
  const head = subagentPrompt('Dot', false);
  assert.ok(head.includes('view below, then your chat with Dot so far,\nits lines as "i|kind: text"'));
  assert.ok(head.includes('Dot may\nsend you more messages, even while you work: answer the last.'));
  assert.equal(subagentPrompt('Dot', false).includes('devices open now'), false);
});

test('real native zoom/date tools read permanent docs and preserve original image', async () => {
  const faux = fauxProvider({ models: [{ id: 'test' }], tokensPerSecond: 1e9 });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const harness = await Harness.open(new MemoryStorage(), {
    models, registry, settings: { compaction: { enabled: false }, toolExecution: 'sequential' },
  }, context);
  try {
    const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'test' } } });
    const tools = memoryTools(root.id);
    registry.install(defineExtension({ name: 'memory', tools }));
    registry.install(toolPolicy(tools, async () => undefined));
    await root.commit(async (tx) => {
      (await tx.doc(MemoryDoc, root.id)).nextMessage = 1;
      await tx.doc(MessageDoc, root.id, '0', {
        i: 0, kind: 'user', text: 'Original 😀', bytes: 13, date: '2026-10-15T00:00:00Z', source: 'input',
        images: [{ data: 'YWJj', mimeType: 'image/png' }],
      });
    }, context);
    const seen: ModelContext[] = [];
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('zoom', { id: 0, n: 1 }), fauxToolCall('date', { id: 0 }), fauxToolCall('zoom', { id: 1, n: 2 }),
      ], { stopReason: 'toolUse' }),
      (request: ModelContext) => {
        seen.push(request);
        return fauxAssistantMessage('done');
      },
    ]);
    const settled = await (await root.submit({ type: 'input', content: 'read memory' }, context)).wait(context);
    assert.equal(settled.status, 'done');
    const results = toolResults(seen);
    assert.equal(results.length, 3);
    assert.ok(results[0].content.some(
      (x) => x.type === 'text' && x.text === 'Page 1/1\n0+0|user: Original 😀\n[image]',
    ));
    assert.ok(results[0].content.some((x) => x.type === 'image' && x.data === 'YWJj'));
    const date = new Date('2026-10-15T00:00:00Z').toLocaleString('sv-SE');
    assert.ok(results[1].content.some((x) => x.type === 'text' && x.text === date));
    // A line that isn't one is an answer listing the tree's roots, not a failed call.
    assert.equal(results[2].isError, false);
    const noLine = 'No line 1+2: n is a power of 2, id a multiple of n. The tree\'s roots: 0+1.';
    assert.ok(results[2].content.some((x) => x.type === 'text' && x.text === noLine));
  } finally {
    await harness.close(context);
  }
});

test('native output hook keeps exact Unicode head and tail including diagnostic-inclusive model budget', async () => {
  const full = 'HEAD' + '😀\n'.repeat(40_000) + 'TAIL';
  const tool = defineTool({
    name: 'large',
    description: 'large',
    parameters: obj({}, { open: true }),
    async execute() {
      return {
        output: [{ type: 'text' as const, text: full }],
        diagnostics: [{ severity: 'info' as const, message: 'd'.repeat(20_000) }],
      };
    },
  });
  const faux = fauxProvider({ models: [{ id: 'test', contextWindow: 1_000_000 }], tokensPerSecond: 1e9 });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'tools', tools: [tool] }));
  registry.install(toolPolicy([tool], async () => undefined));
  const seen: ModelContext[] = [];
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('large', {})], { stopReason: 'toolUse' }),
    (request: ModelContext) => {
      seen.push(request);
      return fauxAssistantMessage('done');
    },
  ]);
  const harness = await Harness.open(new MemoryStorage(), {
    models, registry, settings: { compaction: { enabled: false } },
  }, context);
  try {
    const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'test' } } });
    await (await root.submit({ type: 'input', content: 'run' }, context)).wait(context);
    const [result] = toolResults(seen);
    assert.ok(result);
    const text = textOf(result.content);
    assert.ok(Array.from(text).length <= 30_000);
    assert.match(text, /\n\[\.\.\. \d+ characters cut \.\.\.\]\n/);
    assert.ok(text.startsWith('HEAD'));
    const entries = await root.entries({ order: 'ascending' }, 100, undefined, context);
    const raw = entries.items.find((e) => e.kind === 'pi.tool-result')?.model?.[0];
    assert.ok(raw?.role === 'toolResult');
    assert.equal(text, clipToolText(textOf(raw.content)));
    assert.ok(text.includes('d'.repeat(100)));
  } finally {
    await harness.close(context);
  }
});

test('native sequential tools finish the round, then the steer is delivered before the next request', async () => {
  let started = () => {};
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release = () => {};
  const go = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const tool = defineTool({
    name: 'work',
    description: 'work',
    parameters: obj({ name: str() }, { open: true }),
    async execute({ name }) {
      calls.push(name);
      if (name === 'a') {
        started();
        await go;
      }
      return { output: [{ type: 'text' as const, text: name }] };
    },
  });
  const faux = fauxProvider({ models: [{ id: 'test' }], tokensPerSecond: 1e9 });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'tools', tools: [tool] }));
  registry.install(toolPolicy([tool], async () => undefined));
  const seen: ModelContext[] = [];
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall('work', { name: 'a' }), fauxToolCall('work', { name: 'b' }), fauxToolCall('work', { name: 'c' }),
    ], { stopReason: 'toolUse' }),
    (request: ModelContext) => {
      seen.push(request);
      return fauxAssistantMessage('done');
    },
  ]);
  const harness = await Harness.open(new MemoryStorage(), {
    models, registry, settings: { compaction: { enabled: false }, toolExecution: 'sequential', steeringMode: 'all' },
  }, context);
  try {
    const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'test' } } });
    const first = await root.submit({ type: 'input', content: 'run' }, context);
    await began;
    const steer = await root.submit({ type: 'input', content: 'change plans', whenBusy: 'steer' }, context);
    release();
    await first.wait(context);
    await steer.wait(context);
    assert.deepEqual(calls, ['a', 'b', 'c']);
    const request = seen.at(-1);
    assert.ok(request);
    const steered = request.messages.findIndex(
      (m) => m.role === 'user' && JSON.stringify(m.content).includes('change plans'),
    );
    assert.ok(steered >= 0);
    assert.equal(request.messages.filter((m) => m.role === 'toolResult').length, 3);
    assert.ok(request.messages.slice(0, steered).filter((m) => m.role === 'toolResult').length === 3);
  } finally {
    await harness.close(context);
  }
});

test('completed native bash spill recovers full Unicode head and tail through public environment API', async () => {
  const env = new NodeExecutionEnv({ cwd: '/tmp' });
  const tool = createBashTool();
  const faux = fauxProvider({ models: [{ id: 'test', contextWindow: 1_000_000 }], tokensPerSecond: 1e9 });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'tools', tools: [tool] }));
  registry.install(toolPolicy([tool], async () => env, { bash: 'bash' }));
  const seen: ModelContext[] = [];
  const command = 'node -e \'process.stdout.write("HEAD" + "😀\\n".repeat(80000) + "TAIL")\'';
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('bash', { command })], { stopReason: 'toolUse' }),
    (request: ModelContext) => {
      seen.push(request);
      return fauxAssistantMessage('done');
    },
  ]);
  const harness = await Harness.open(new MemoryStorage(), {
    models, registry, env: () => env, settings: { compaction: { enabled: false } },
  }, context);
  try {
    const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'test' } } });
    await (await root.submit({ type: 'input', content: 'run' }, context)).wait(context);
    const [result] = toolResults(seen);
    assert.ok(result);
    const text = textOf(result.content);
    assert.equal(result.isError, false);
    assert.ok(text.startsWith('HEAD'));
    assert.ok(text.includes('TAIL'));
    assert.ok(Array.from(text).length <= 30_000);
    assert.match(text, /\n\[\.\.\. \d+ characters cut \.\.\.\]\n/);
  } finally {
    await harness.close(context);
  }
});

for (const body of ['😀'.repeat(40_000), '\n'.repeat(40_000)]) {
  const kind = body[0] === '\n' ? 'newlines' : 'four-byte Unicode';
  test(`native bounds preserve original head before final diagnostic-inclusive cap: ${kind}`, async () => {
    const full = 'HEAD' + body + 'TAIL';
    const tool = defineTool({
      name: 'boundary',
      description: 'boundary',
      parameters: obj({}, { open: true }),
      async execute() {
        return {
          output: [{ type: 'text' as const, text: full }],
          diagnostics: [{ severity: 'info' as const, message: 'diagnostic' }],
        };
      },
    });
    const faux = fauxProvider({ models: [{ id: 'test', contextWindow: 1_000_000 }], tokensPerSecond: 1e9 });
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'tools', tools: [tool] }));
    registry.install(toolPolicy([tool], async () => undefined));
    const seen: ModelContext[] = [];
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('boundary', {})], { stopReason: 'toolUse' }),
      (request: ModelContext) => {
        seen.push(request);
        return fauxAssistantMessage('done');
      },
    ]);
    const harness = await Harness.open(new MemoryStorage(), {
      models, registry, settings: { compaction: { enabled: false } },
    }, context);
    try {
      const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'test' } } });
      await (await root.submit({ type: 'input', content: 'run' }, context)).wait(context);
      const entries = await root.entries({ order: 'ascending' }, 100, undefined, context);
      const original = entries.items.find((e) => e.kind === 'pi.tool-result')?.model?.[0];
      assert.ok(original?.role === 'toolResult');
      const raw = textOf(original.content);
      assert.ok(raw.startsWith('HEAD'));
      assert.ok(raw.includes('TAIL'));
      const [result] = toolResults(seen);
      assert.ok(result);
      const text = textOf(result.content);
      assert.equal(text, clipToolText(raw));
      assert.ok(Array.from(text).length <= 30_000);
      assert.ok(text.startsWith('HEAD'));
      assert.ok(text.includes('TAIL'));
    } finally {
      await harness.close(context);
    }
  });
}

test('a read registered as native pages itself and reaches the model unclipped', async () => {
  const page = 'r'.repeat(40_000);
  const tool = defineTool({
    name: 'read',
    description: 'read',
    parameters: obj({}, { open: true }),
    async execute() {
      return { output: [{ type: 'text' as const, text: page }] };
    },
  });
  const faux = fauxProvider({ models: [{ id: 'test', contextWindow: 1_000_000 }], tokensPerSecond: 1e9 });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'tools', tools: [tool] }));
  registry.install(toolPolicy([tool], async () => undefined, { read: 'read' }));
  const seen: ModelContext[] = [];
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('read', {})], { stopReason: 'toolUse' }),
    (request: ModelContext) => {
      seen.push(request);
      return fauxAssistantMessage('done');
    },
  ]);
  const harness = await Harness.open(new MemoryStorage(), {
    models, registry, settings: { compaction: { enabled: false } },
  }, context);
  try {
    const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'test' } } });
    await (await root.submit({ type: 'input', content: 'run' }, context)).wait(context);
    const texts = seen.flatMap((request) => request.messages)
      .flatMap((message) => message.role === 'toolResult' ? message.content : [])
      .flatMap((block) => block.type === 'text' ? [block.text] : []);
    assert.deepEqual(texts, [page]);
  } finally {
    await harness.close(context);
  }
});
