// This function is serialized into the connected Hermes runtime by test:native.
// Keep it self-contained: all imports come from the discovered Metro module IDs.
export default async function nativeDurableProbe({ moduleIds, database }) {
  const startedAt = Date.now();
  const ai = globalThis.__r(moduleIds.ai);
  const durable = globalThis.__r(moduleIds.durable);
  const { BACKGROUND_CONTEXT: context } = globalThis.__r(moduleIds.context);
  const { anthropicProvider } = globalThis.__r(moduleIds.anthropic);
  const { openExpoSqliteStorage } = globalThis.__r(moduleIds.storage);
  const { deleteDatabaseAsync } = globalThis.__r(moduleIds.sqlite);
  const { DurableChatService } = globalThis.__r(moduleIds.service);
  const check = (condition, reason) => { if (!condition) throw new Error(reason); };
  const until = async (predicate, label, timeout = 4_000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      check(Date.now() < deadline, `Timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  // The app ships no demo tool; the probe registers its own.
  const addition = durable.defineExtension({ name: 'probe-addition', tools: [durable.defineTool({
    name: 'probe_add', description: 'Add two numbers.', replay: 'safe',
    parameters: ai.Type.Object({ a: ai.Type.Number(), b: ai.Type.Number() }),
    async execute({ a, b }) {
      const result = { sum: a + b };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  })] });
  const models = ai.createModels({
    credentials: new ai.InMemoryCredentialStore(),
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const signedIn = { anthropic: true, 'probe-other': true };
  let mode = 'tool';
  let calls = 0;
  let providerAborts = 0;
  const requests = [];
  const message = (model, content, stopReason) => ({
    role: 'assistant', content, api: model.api, provider: model.provider,
    model: model.id, stopReason, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const dispatch = (model, requestContext, options) => {
    calls++;
    requests.push({ context: structuredClone(requestContext), transport: options.transport,
      provider: model.provider, modelId: model.id, reasoning: options.reasoning });
    const stream = ai.createAssistantMessageEventStream();
    if (mode === 'pending') {
      const partial = message(model, [{ type: 'text', text: 'A persisted partial response.' }], 'stop');
      stream.push({ type: 'start', partial });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: partial.content[0].text, partial });
      const abort = () => {
        providerAborts++;
        stream.push({ type: 'error', reason: 'aborted', error: message(model, partial.content, 'aborted') });
      };
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    } else {
      const isTool = mode === 'tool';
      const result = message(model, isTool
        ? [{ type: 'toolCall', id: 'native-add', name: 'probe_add', arguments: { a: 19, b: 23 } }]
        : [{ type: 'text', text: 'The answer is **42**.' }], isTool ? 'toolUse' : 'stop');
      if (isTool) mode = 'answer';
      stream.push({ type: 'start', partial: result });
      stream.push({ type: 'done', reason: result.stopReason, message: result });
    }
    return stream;
  };
  const register = (id, base, getModels) => models.setProvider({ ...base, id, name: id, getModels,
    auth: { apiKey: {
      name: 'Native validation only',
      check: async () => signedIn[id] ? { type: 'api_key' } : undefined,
      resolve: async () => signedIn[id] ? { auth: { apiKey: 'synthetic-no-network' } } : undefined,
    } },
    stream: dispatch, streamSimple: dispatch,
  });
  const anthropic = anthropicProvider();
  register('anthropic', anthropic, anthropic.getModels);
  const otherModel = { ...anthropic.getModels()[0], provider: 'probe-other', id: 'probe-other-model' };
  register('probe-other', anthropic, () => [otherModel]);
  const open = async (name = database) => DurableChatService.open({
    storage: await openExpoSqliteStorage(name), models, extensions: [addition],
  });
  /** Subscribe like the chat screen and wait until the view has loaded. */
  const watch = async (service, id) => {
    const view = service.chat(id, { transcript: true });
    const close = view.subscribe(() => {});
    await until(() => view.getSnapshot().status !== 'loading', 'the chat view to load');
    return { get conversation() { return view.getSnapshot().conversation; }, close };
  };
  const read = async (service, id) => {
    const chat = await watch(service, id);
    try { return chat.conversation; } finally { chat.close(); }
  };
  const text = (conversation) => conversation.messages.map((row) => [row.text, row.tool?.output].join(' ')).join('\n');

  /** Launch cost: open a database of `count` chats, each with `entries` saved transcript entries. */
  const measureOpen = async (name) => {
    const times = [];
    let chats = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const begin = Date.now();
      const service = await open(name);
      times.push(Date.now() - begin);
      chats = service.getSnapshot().chats.length;
      await service.close();
    }
    return { ms: Math.min(...times), chats };
  };
  const seedHistory = async (service, id, entries) => {
    const conversation = await service.harness.conversation(id, context);
    const model = anthropic.getModels()[0];
    await conversation.commit(async (tx) => {
      for (let index = 0; index < entries; index += 2) {
        await tx.appendEntry(id, { kind: 'pi.user',
          model: [{ role: 'user', content: `Saved question ${index}. `.repeat(8), timestamp: Date.now() }] });
        await tx.appendEntry(id, { kind: 'pi.assistant',
          model: [message(model, [{ type: 'text', text: `Saved answer ${index}. `.repeat(40) }], 'stop')] });
      }
    }, context);
  };
  const scale = async () => {
    const name = `${database.replace(/\.db$/, '')}-scale.db`;
    try { return await measureScale(name); }
    finally {
      // The measurement database is only scaffolding; remove it and its WAL files.
      await deleteDatabaseAsync(name).catch(() => {});
    }
  };
  const measureScale = async (name) => {
    let service = await open(name);
    const first = await service.createChat();
    await seedHistory(service, first, 40);
    await service.close();
    const oneChat = await measureOpen(name);
    service = await open(name);
    const ids = [];
    for (let index = 1; index < 100; index++) ids.push(await service.createChat());
    for (const id of ids) await seedHistory(service, id, 40);
    await service.close();
    const hundredChats = await measureOpen(name);
    service = await open(name);
    for (const id of [first, ...ids]) await seedHistory(service, id, 120);
    await service.close();
    const hundredLongChats = await measureOpen(name);
    service = await open(name);
    const openChatBegin = Date.now();
    const longest = await read(service, first);
    const openChatMs = Date.now() - openChatBegin;
    await service.close();
    check(oneChat.chats === 1 && hundredChats.chats === 100 && hundredLongChats.chats === 100,
      'The chat list did not show every saved chat');
    check(longest.messages.length === 160, 'An opened chat did not show its full saved transcript');
    // Opening reads each chat's metadata, never its transcript, so four times the history costs about the same.
    check(hundredLongChats.ms <= hundredChats.ms * 1.5 + 25, 'Opening the app slowed down as saved history grew');
    return { database: name, oneChat, hundredChats: { ...hundredChats, entriesPerChat: 40 },
      hundredLongChats: { ...hundredLongChats, entriesPerChat: 160 }, openChatWith160EntriesMs: openChatMs };
  };

  let service = await open();
  try {
    // Send, run a probe tool, answer.
    const id = await service.createChat();
    const submission = await service.send(id, 'Add 19 and 23.');
    const receipt = await service.waitForSubmission(submission);
    const tool = (await read(service, id)).messages.find((row) => row.tool)?.tool;
    check(receipt.status === 'done' && tool && JSON.parse(tool.output).sum === 42 && calls === 2,
      'Tool loop did not finish with 42');
    check(requests[1].context.messages.some((row) => row.role === 'toolResult'
      && JSON.parse(row.content[0].text).sum === 42), 'Tool result did not reach the follow-up model call');

    // Title and transcript survive closing and reopening SQLite.
    await service.renameChat(id, 'Native SQLite verification');
    const before = await read(service, id);
    await service.close();
    service = await open();
    const reopened = await read(service, id);
    check(reopened.title === 'Native SQLite verification'
      && JSON.stringify(reopened.messages) === JSON.stringify(before.messages),
    'Title or transcript did not survive SQLite close/reopen');

    // Work cut off by closing resumes on the next open, once.
    mode = 'pending';
    const live = await watch(service, id);
    const recovery = await service.send(id, 'Keep working after reopen.');
    await until(() => live.conversation.messages.some((row) => row.streaming && row.text.includes('persisted partial')),
      'committed streaming partial');
    live.close();
    await service.close();
    mode = 'answer';
    service = await open();
    check((await service.waitForSubmission(recovery)).status === 'done', 'The interrupted submission did not resume');
    const resumed = await read(service, id);
    check(resumed.messages.filter((row) => row.text === 'Keep working after reopen.').length === 1
      && resumed.messages.some((row) => row.interrupted && row.text.includes('persisted partial'))
      && text(resumed).includes('The answer is **42**.'), 'Resumed work was not shown once with its interrupted partial');

    // A recovered chat whose provider is signed out fails on its own; another chat still answers.
    const other = await service.createChat();
    await service.updateSettings(other, { model: { provider: 'probe-other', modelId: otherModel.id },
      thinkingLevel: ai.getSupportedThinkingLevels(otherModel)[0] });
    mode = 'pending';
    const stranded = await service.send(other, 'Finish after the provider signs out.');
    await until(() => requests.at(-1).provider === 'probe-other', 'the other provider request');
    await service.close();
    signedIn['probe-other'] = false;
    mode = 'answer';
    const callsBeforeStranded = calls;
    service = await open();
    const unblocked = await service.waitForSubmission(await service.send(id, 'Answer while another chat is stranded.'));
    const failed = await service.waitForSubmission(stranded);
    const strandedChat = await read(service, other);
    check(unblocked.status === 'done', 'A signed-out recovered chat blocked another chat');
    check(failed.status === 'unanswered' && !!strandedChat.error && !strandedChat.busy,
      'Signed-out recovered work did not fail visibly');
    check(calls === callsBeforeStranded + 1, 'A signed-out provider received a request');

    // Stop is durable and does not restart on reopen.
    mode = 'pending';
    const callsBeforeCancel = calls;
    const stopping = await watch(service, id);
    const cancelled = await service.send(id, 'Stop this response.');
    await until(() => calls > callsBeforeCancel && stopping.conversation.messages.some((row) => row.streaming),
      'cancellable committed response');
    await service.cancel(id);
    const stopped = await service.waitForSubmission(cancelled);
    await until(() => stopping.conversation.messages.at(-1)?.text === 'Response stopped', 'the stop notice');
    stopping.close();
    check(stopped.status === 'unanswered' && stopped.reason === 'aborted', 'Cancellation was not durable');
    await service.close();
    const callsBeforeReopen = calls;
    service = await open();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterStop = await read(service, id);
    check(!afterStop.busy && afterStop.messages.at(-1).text === 'Response stopped' && calls === callsBeforeReopen,
      'Cancelled work restarted on reopen');

    // Settings belong to each chat, survive reopening and reach the request.
    const secondId = await service.createChat();
    const unchangedSettings = JSON.stringify((await read(service, secondId)).settings);
    const base = models.getProvider('anthropic');
    const customModel = { ...base.getModels()[0], provider: 'native-settings-provider', id: 'native-settings-model' };
    models.setProvider({ ...base, id: customModel.provider, name: 'Native settings provider', getModels: () => [customModel] });
    const settings = { model: { provider: customModel.provider, modelId: customModel.id }, thinkingLevel: 'high' };
    await service.updateSettings(id, settings);
    check(JSON.stringify((await read(service, secondId)).settings) === unchangedSettings, 'Settings leaked across chats');
    await service.close();
    service = await open();
    check(JSON.stringify((await read(service, id)).settings) === JSON.stringify(settings),
      'Settings did not survive SQLite reopen');
    mode = 'answer';
    await service.waitForSubmission(await service.send(id, 'Continue with the selected provider.'));
    const selectedRequest = requests[requests.length - 1];
    check(selectedRequest.provider === customModel.provider && selectedRequest.modelId === customModel.id
      && selectedRequest.reasoning === 'high', 'Saved provider/model/effort did not reach the SDK request');
    check(requests.every((request) => request.transport === 'sse'), 'A provider call did not use SSE');
    await service.close();

    const launch = await scale();
    return {
      ok: true, hermes: typeof globalThis.HermesInternal === 'object', database,
      checks: { probeToolSum: 42, reopenedTranscript: true, resumedAfterReopen: true,
        signedOutRecoveryFailsVisibly: true, otherChatNotBlocked: true, durableCancellation: true,
        perChatSettings: true, reopenedSettings: true, selectedProviderRequest: true, sse: true,
        launchFlatAsHistoryGrows: true },
      launch, providerCalls: calls, providerAborts, elapsedMs: Date.now() - startedAt,
      network: 'Scripted provider; no model HTTP requests',
    };
  } finally {
    await service.close();
  }
}
