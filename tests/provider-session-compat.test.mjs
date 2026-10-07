import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineExtension, defineTask, ProviderDoc } from '@earendil-works/pi-durable';
import { installBashBrowserHooks } from './helpers/bash-browser-hooks.mjs';
import { integrationDatabase } from './helpers/bash-integration.mjs';
import { MODEL_ID, responsesModels, searchItem, textItem } from './helpers/openai-responses.mjs';
import { scriptedModels } from './helpers/scripted-models.mjs';

const hooks = installBashBrowserHooks();
test.after(() => hooks.deregister());
const { DurableChatService } = await import('../src/pi/chat-service.ts');
const { withNativeWebSearch } = await import('../src/pi/native-web-search/provider.ts');
const { NativeResponsesDoc } = await import('../src/pi/native-web-search/documents.ts');
const context = BACKGROUND_CONTEXT;

// The task stays live while its owned conversation generates, matching Pi's
// ownership contract instead of running new work under a terminal owner.
const OwnedRequest = defineTask({
  name: 'test.provider-session-owned-request', version: 1, initial: () => ({ phase: 'create' }),
  phases: {
    async create(task, runtime, ctx) {
      await runtime.commit(async (tx) => {
        const child = await tx.createConversation({ ownership: { kind: 'task', taskId: task.id } });
        return { status: 'running', checkpoint: { phase: 'request', conversationId: child.id } };
      }, ctx);
    },
    async request(task, runtime, ctx) {
      const conversationId = task.state.checkpoint.conversationId;
      const child = await runtime.conversation(conversationId, ctx);
      const submission = await child.submit({ type: 'input', content: 'Answer in the owned conversation.' }, ctx);
      const settled = await submission.wait(ctx);
      if (settled.status !== 'done') throw new Error(`Owned request failed: ${JSON.stringify(settled)}`);
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { conversationId } } }), ctx);
    },
  },
  async abort(_task, runtime, ctx) {
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx);
  },
});
const taskExtension = defineExtension({ name: 'test.provider-session-compat', tasks: [OwnedRequest] });
const execution = (local) => ({ ...local, extensions: [...(local.extensions ?? []), taskExtension] });

const transports = [
  {
    name: 'scripted Pi provider options',
    provider: () => scriptedModels(Array.from({ length: 8 }, () => ({ chunks: ['Recorded.'] }))),
    identity(request) { return request.options.sessionId; },
  },
  {
    name: 'native web-search OpenAI HTTP payload and session header',
    settings: { model: { provider: 'openai', modelId: MODEL_ID }, thinkingLevel: 'medium' },
    provider(prefix) {
      return responsesModels(Array.from({ length: 8 }, (_, index) => (exchange) => exchange.complete([
        searchItem(`ws_${prefix}_${index}`), textItem('Recorded source.', `msg_${prefix}_${index}`, []),
      ], { id: `resp_${prefix}_${index}` })), { wrapProvider: withNativeWebSearch });
    },
    identity(request) {
      assert.ok(request.body.tools.some(({ type }) => type === 'web_search'), 'native hosted-search decoration ran');
      assert.ok(request.body.include.includes('web_search_call.results'));
      assert.equal(request.headers.get('session_id'), request.body.prompt_cache_key,
        'OpenAI session affinity and cache identity preserve the same durable UUID');
      return request.body.prompt_cache_key;
    },
  },
];

async function send(service, id, text) {
  const settled = await service.waitForSubmission(await service.send(id, text));
  assert.equal(settled.status, 'done', JSON.stringify(settled));
}

for (const transport of transports) test(`${transport.name}: stable through turns/reopen/reset, distinct for forks and owned creation`, { timeout: 20_000 }, async (t) => {
  const file = await integrationDatabase(t, DurableChatService);
  const before = transport.provider('before');
  const first = await file.open(before.models, { execution });
  const id = await first.createChat();
  if (transport.settings) await first.updateSettings(id, transport.settings);
  await send(first, id, 'Remember this provider session.');
  await send(first, id, 'Continue in the same conversation.');
  const identity = transport.identity(before.requests[0]);
  assert.match(identity, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.notEqual(identity, id, 'provider identity is a UUID, not a local database conversation number');
  assert.equal(transport.identity(before.requests[1]), identity);
  assert.equal((await first.harness.snapshot(ProviderDoc, Number(id), context)).sessionId, identity,
    'request options use committed Pi provider state');
  if (transport.settings) {
    const archive = await first.harness.snapshot(NativeResponsesDoc, Number(id), context);
    assert.equal(Object.values(archive.responses).filter(({ status }) => status === 'completed').length, 2,
      'both real provider requests passed through durable native-search persistence');
  }
  await file.close(first);

  const after = transport.provider('after');
  const reopened = await file.open(after.models, { execution });
  assert.equal(after.requests.length, 0, 'reopening does not dispatch provider work');
  assert.equal((await reopened.harness.snapshot(ProviderDoc, Number(id), context)).sessionId, identity);
  await send(reopened, id, 'Continue after reopening.');
  assert.equal(transport.identity(after.requests[0]), identity);

  const parent = await reopened.harness.conversation(Number(id), context);
  const at = (await parent.entries({}, 1, undefined, context)).items[0].id;
  const fork = await parent.fork(at, { ownership: { kind: 'ownerless' } }, context);
  // The fork was created through the harness, so it is driven through the harness too.
  const answered = await (await fork.submit({ type: 'input', content: 'Answer in this fork.' }, context)).wait(context);
  assert.equal(answered.status, 'done', JSON.stringify(answered));
  const forkIdentity = transport.identity(after.requests[1]);
  assert.notEqual(forkIdentity, identity);
  assert.equal((await reopened.harness.snapshot(ProviderDoc, fork.id, context)).sessionId, forkIdentity);

  const ownedTask = await parent.commit((tx) => tx.createTask(OwnedRequest, {}, { ownership: { kind: 'conversation' } }), context);
  const outcome = (await reopened.harness.waitForTask(ownedTask, context)).state.outcome;
  assert.equal(outcome.status, 'completed', JSON.stringify(outcome));
  const ownedIdentity = transport.identity(after.requests[2]);
  assert.notEqual(ownedIdentity, identity);
  assert.notEqual(ownedIdentity, forkIdentity);
  assert.equal((await reopened.harness.snapshot(ProviderDoc, outcome.result.conversationId, context)).sessionId, ownedIdentity);

  await parent.reset('Start fresh context while preserving the conversation.', context);
  await send(reopened, id, 'Answer after resetting the transcript.');
  assert.equal(transport.identity(after.requests[3]), identity, 'transcript reset keeps the same conversation session');
  assert.equal(file.metrics.opened, 0, 'provider identity work acquires no execution filesystem');
});
