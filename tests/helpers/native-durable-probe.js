// This function is serialized into the connected Hermes runtime by test:native.
// Keep it self-contained: all imports come from the discovered Metro module IDs.
export default async function nativeDurableProbe({ moduleIds, database, platform }) {
  const startedAt = Date.now();
  const ai = globalThis.__r(moduleIds.ai);
  const { anthropicProvider } = globalThis.__r(moduleIds.anthropic);
  const { openExpoSqliteStorage } = globalThis.__r(moduleIds.storage);
  const { DurableChatService } = globalThis.__r(moduleIds.service);
  const models = ai.createModels({
    credentials: new ai.InMemoryCredentialStore(),
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  let signedIn = true;
  let mode = 'tool';
  let calls = 0;
  let providerAborts = 0;
  const requests = [];
  const check = (condition, reason) => { if (!condition) throw new Error(reason); };
  const message = (model, content, stopReason) => ({
    role: 'assistant', content, api: model.api, provider: model.provider,
    model: model.id, stopReason, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const dispatch = (model, context, options) => {
    calls++;
    requests.push({ context: structuredClone(context), transport: options.transport,
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
        ? [{ type: 'toolCall', id: 'native-add', name: 'add_numbers', arguments: { a: 19, b: 23 } }]
        : [{ type: 'text', text: 'The answer is **42**.' }], isTool ? 'toolUse' : 'stop');
      mode = 'answer';
      stream.push({ type: 'start', partial: result });
      stream.push({ type: 'done', reason: result.stopReason, message: result });
    }
    return stream;
  };
  models.setProvider({
    ...anthropicProvider(),
    auth: { apiKey: {
      name: 'Native validation only',
      check: async () => signedIn ? { type: 'api_key' } : undefined,
      resolve: async () => signedIn ? { auth: { apiKey: 'synthetic-no-network' } } : undefined,
    } },
    stream: dispatch, streamSimple: dispatch,
  });
  const open = async () => DurableChatService.open({
    storage: await openExpoSqliteStorage(database), models, platform,
  });
  const until = async (predicate, label) => {
    const deadline = Date.now() + 4_000;
    while (!predicate()) {
      check(Date.now() < deadline, `Timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  let service = await open();
  try {
    const id = await service.createChat();
    const submission = await service.send(id, 'Add 19 and 23.');
    const receipt = await service.waitForSubmission(submission);
    const tool = service.getConversation(id).messages.find((row) => row.tool)?.tool;
    check(receipt.status === 'done' && tool && JSON.parse(tool.output).sum === 42 && calls === 2,
      'Tool loop did not finish with 42');
    check(requests[1].context.messages.some((row) => row.role === 'toolResult'
      && JSON.parse(row.content[0].text).sum === 42), 'Tool result did not reach the follow-up model call');
    await service.renameChat(id, 'Native SQLite verification');
    await service.close();
    service = await open();
    check(service.getConversation(id).title === 'Native SQLite verification'
      && service.getConversation(id).messages.some((row) => row.text.includes('**42**')),
    'Title or transcript did not survive SQLite close/reopen');

    mode = 'pending';
    const recoverySubmission = await service.send(id, 'Keep working after reopen.');
    await until(() => service.getConversation(id).messages.some((row) => row.streaming
      && row.text.includes('persisted partial')), 'committed streaming partial');
    await service.close();
    signedIn = false;
    const callsBeforeReopen = calls;
    service = await open();
    check(service.getConversation(id).pending, 'Unfinished work was not restored');
    let authBlocked = false;
    try { await service.resume(); } catch { authBlocked = true; }
    await new Promise((resolve) => setTimeout(resolve, 50));
    check(authBlocked && calls === callsBeforeReopen, 'Signed-out recovery dispatched a provider request');
    signedIn = true;
    mode = 'answer';
    await service.resume();
    check((await service.waitForSubmission(recoverySubmission)).status === 'done',
      'The same durable submission did not recover after sign-in');

    mode = 'pending';
    const callsBeforeCancel = calls;
    const cancelled = await service.send(id, 'Stop this response.');
    await until(() => calls > callsBeforeCancel && service.getConversation(id).messages.some((row) => row.streaming),
      'cancellable committed response');
    await service.cancel(id);
    const stopped = await service.waitForSubmission(cancelled);
    check(stopped.status === 'unanswered' && stopped.reason === 'aborted', 'Cancellation was not durable');
    await service.close();
    service = await open();
    check(!service.getConversation(id).pending && !service.getConversation(id).busy,
      'Cancelled work restarted on reopen');
    const secondId = await service.createChat();
    const unchangedSettings = JSON.stringify(service.getConversation(secondId).settings);
    const base = models.getProvider('anthropic');
    const customModel = { ...base.getModels()[0], provider: 'native-settings-provider', id: 'native-settings-model' };
    models.setProvider({ ...base, id: customModel.provider, name: 'Native settings provider', getModels: () => [customModel] });
    const settings = { model: { provider: customModel.provider, modelId: customModel.id }, thinkingLevel: 'high' };
    await service.updateSettings(id, settings);
    check(JSON.stringify(service.getConversation(secondId).settings) === unchangedSettings, 'Settings leaked across chats');
    await service.close();
    service = await open();
    check(JSON.stringify(service.getConversation(id).settings) === JSON.stringify(settings), 'Settings did not survive SQLite reopen');
    mode = 'answer';
    await service.waitForSubmission(await service.send(id, 'Continue with the selected provider.'));
    const selectedRequest = requests[requests.length - 1];
    check(selectedRequest.provider === customModel.provider && selectedRequest.modelId === customModel.id && selectedRequest.reasoning === 'high',
      'Saved provider/model/effort did not reach the SDK request');
    check(requests.every((request) => request.transport === 'sse'), 'A provider call did not use SSE');
    return {
      ok: true, hermes: typeof globalThis.HermesInternal === 'object', database,
      checks: { toolSum: 42, committedPartial: true, reopenedTranscript: true,
        authPaused: true, resumedSubmission: true, durableCancellation: true, perChatSettings: true,
        reopenedSettings: true, selectedProviderRequest: true, sse: true },
      providerCalls: calls, providerAborts, elapsedMs: Date.now() - startedAt,
      network: 'Scripted provider; no model HTTP requests',
    };
  } finally {
    await service.close();
  }
}
