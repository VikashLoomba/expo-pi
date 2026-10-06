// Serialized into Hermes; every imported module comes from Metro's observed registry.
export default async function nativeWebSearchProbe({ database, platform, holdMs = 0, holdStage = 'completed' }) {
  const modules = globalThis.__r?.getModules?.();
  const devtools = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!modules || !devtools?.getFiberRoots) throw new Error('A connected Hermes development build is required.');
  const check = (value, message) => { if (!value) throw new Error(message); };
  function requireSuffix(suffix) {
    const found = [...modules].filter(([, module]) => {
      const path = (module.verboseName || '').replace(/\\/g, '/');
      return path === suffix || path.endsWith(`/${suffix}`);
    });
    check(found.length === 1, `Expected one Metro module for ${suffix}; found ${found.length}.`);
    return globalThis.__r(found[0][0]);
  }
  const ai = requireSuffix('@earendil-works/pi-ai/dist/index.js');
  const { openaiProvider } = requireSuffix('@earendil-works/pi-ai/dist/providers/openai.js');
  const { withNativeWebSearch } = requireSuffix('src/pi/native-web-search/provider.ts');
  const { openExpoSqliteStorage } = requireSuffix('src/pi/storage/index.ts');
  const { DurableChatService } = requireSuffix('src/pi/chat-service.ts');
  const { buildModelCatalog } = requireSuffix('src/pi/model-catalog.ts');
  const providerModule = requireSuffix('src/chat/chat-provider.tsx');
  const { router } = requireSuffix('expo-router/build/exports.js');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (predicate, message) => {
    const deadline = Date.now() + 8000;
    while (!predicate()) { check(Date.now() < deadline, message); await sleep(15); }
  };
  const models = ai.createModels({ credentials: new ai.InMemoryCredentialStore(),
    authContext: { env: async () => undefined, fileExists: async () => false } });
  const base = openaiProvider();
  const requests = [];
  const output = [
    { id: 'rs_native', type: 'reasoning', summary: [], status: 'completed', encrypted_content: 'opaque-native-test-state' },
    { id: 'ws_native', type: 'web_search_call', status: 'completed', action: { type: 'search',
      queries: ['OpenAI Responses native web search'], sources: [
        { type: 'url', url: 'https://developers.openai.com/api/docs/guides/tools-web-search', title: 'OpenAI web search guide' },
        { type: 'url', url: 'https://openai.com/research/', title: 'OpenAI Research' },
      ] }, results: [{ type: 'web_search_result', title: 'Calibration bulletin',
        url: 'https://developers.openai.com/api/docs/guides/tools-web-search',
        snippet: 'The cobalt observatory calibrates its beacon every 47 seconds.' }] },
    { id: 'msg_native', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{
      type: 'output_text', text: 'Native web search returns sources and inline citations.\n\nThe response, search activity, and sources survive reopening this chat.',
      annotations: [{ type: 'url_citation', start_index: 0, end_index: 55,
        url: 'https://developers.openai.com/api/docs/guides/tools-web-search', title: 'OpenAI web search guide' }],
    }] },
  ];
  let complete;
  let phase = 'setup';
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    check(String(url) === 'https://api.openai.com/v1/responses', 'Unexpected model endpoint');
    check(new Headers(init.headers).get('authorization') === 'Bearer eyJ.native-test.signature', 'Synthetic bearer auth was not applied');
    let controller;
    let sequence = 0;
    let closed = false;
    const stream = new ReadableStream({ start(value) { controller = value; } });
    const emit = (type, fields) => controller.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`));
    const finish = (items, id) => {
      items.forEach((item, index) => {
        emit('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress' } });
        emit('response.output_item.done', { output_index: index, item });
      });
      emit('response.completed', { response: { id, status: 'completed', model: 'gpt-6-sol', output: items,
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } });
      closed = true; controller.close();
    };
    emit('response.created', { response: { id: `resp_native_${requests.length}`, status: 'in_progress', output: [] } });
    if (requests.length === 1) {
      emit('response.output_item.added', { output_index: 1, item: { id: 'ws_native', type: 'web_search_call', status: 'in_progress' } });
      emit('response.web_search_call.searching', { output_index: 1, item_id: 'ws_native' });
      complete = () => finish(output, 'resp_native_1');
    } else {
      for (const item of output.filter((entry) => entry.type !== 'web_search_call')) {
        check(body.input.filter((entry) => entry.id === item.id).length === 1, `Pi lost or duplicated ${item.id}`);
      }
      check(!body.input.some((entry) => entry.type === 'web_search_call'), 'Raw hosted calls replaced ordinary evidence');
      const evidence = body.input.filter((entry) => entry.role === 'user').flatMap((entry) =>
        typeof entry.content === 'string' ? [entry.content] : (entry.content || []).map((part) => part.text || '')).join('\n');
      check(evidence.split('The cobalt observatory calibrates its beacon every 47 seconds.').length === 2,
        'The source-only fact did not survive native SQLite reopen exactly once as ordinary text');
      check(body.input.find((entry) => entry.id === 'rs_native').encrypted_content === 'opaque-native-test-state', 'Encrypted state was not replayed');
      const answer = { ...output[2], id: 'msg_followup', content: [{ type: 'output_text', text: 'The saved search is available on the next turn.', annotations: [] }] };
      finish([answer], 'resp_native_2');
    }
    init.signal?.addEventListener('abort', () => { if (!closed) { closed = true; controller.error(new Error('Synthetic HTTP cancelled')); } }, { once: true });
    // React Native's global Response does not expose a ReadableStream body. Keep
    // its HTTP fields and supply the synthetic stream at the fetch boundary.
    const response = new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    Object.defineProperty(response, 'body', { value: stream });
    return response;
  };
  models.setProvider(withNativeWebSearch({ ...base, auth: { apiKey: {
    name: 'Native search validation', check: async () => ({ type: 'api_key' }),
    resolve: async () => ({ auth: { apiKey: 'eyJ.native-test.signature' } }),
  } }, stream: (model, context, options) => base.stream(model, context, { ...options, fetch }),
  streamSimple: (model, context, options) => base.streamSimple(model, context, { ...options, fetch }) }));
  let service;
  const reopen = async () => { service = await DurableChatService.open({ storage: await openExpoSqliteStorage(database), models, platform }); };
  const restores = [];
  let id;
  let fixtureRowId;
  function mountedProps() {
    const props = [];
    for (const renderer of devtools.renderers?.keys?.() || [1]) for (const root of devtools.getFiberRoots(renderer) || []) {
      const stack = [root.current];
      while (stack.length) {
        const fiber = stack.pop();
        if (!fiber) continue;
        if (fiber.memoizedProps?.testID) props.push(fiber.memoizedProps);
        for (let child = fiber.child; child; child = child.sibling) stack.push(child);
      }
    }
    return props;
  }
  try {
    await reopen();
    id = await service.createChat();
    await service.updateSettings(id, { model: { provider: 'openai', modelId: 'gpt-6-sol' }, thinkingLevel: 'medium' });
    await service.renameChat(id, 'Native web search verification');
    let boundRuntime;
    const delegateRuntime = (runtime) => {
      if (boundRuntime === runtime) return;
      check(!boundRuntime, 'The mounted app runtime changed during the fixture');
      boundRuntime = runtime;
      const originalSubscribe = runtime.subscribe;
      const overrides = {
        subscribe: (listener) => {
          const unsubscribeApp = originalSubscribe(listener);
          const unsubscribeFixture = service.subscribe(listener);
          return () => { unsubscribeApp(); unsubscribeFixture(); };
        },
        getConversation: (chatId) => service.getConversation(chatId),
        getConversationState: (chatId) => service.getConversation(chatId),
        send: (chatId, text) => service.send(chatId, text),
        cancel: (chatId) => service.cancel(chatId),
        resume: () => service.resume(),
        updateSettings: (chatId, settings) => service.updateSettings(chatId, settings),
        createChat: () => service.createChat(),
        renameChat: (chatId, title) => service.renameChat(chatId, title),
        archiveChat: (chatId) => service.archiveChat(chatId),
      };
      for (const [name, replacement] of Object.entries(overrides)) {
        const descriptor = Object.getOwnPropertyDescriptor(runtime, name);
        Object.defineProperty(runtime, name, { configurable: true, writable: true, value: replacement });
        restores.push(() => { if (descriptor) Object.defineProperty(runtime, name, descriptor); else delete runtime[name]; });
      }
    };
    // Keep every original React hook call. Changing a mounted screen from
    // useContext to useSyncExternalStore corrupts its hook list after cleanup.
    // Only the runtime's public methods delegate to the isolated test service.
    const originalApp = providerModule.useChatApp;
    const appDescriptor = Object.getOwnPropertyDescriptor(providerModule, 'useChatApp');
    providerModule.useChatApp = () => {
      const app = originalApp();
      delegateRuntime(app.runtime);
      return { ...app, ...service.getSnapshot(), ready: true,
        catalog: buildModelCatalog(models), providerAccess: () => ({ ready: true, connected: true }),
        signedIn: true, signingIn: false, hasConnectedProvider: true };
    };
    restores.push(() => Object.defineProperty(providerModule, 'useChatApp', appDescriptor));
    const probeDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__PI_NATIVE_SEARCH_PROBE__');
    globalThis.__PI_NATIVE_SEARCH_PROBE__ = { snapshot: () => ({ phase, database, id,
      messageIds: service.getConversation(id)?.messages.map((row) => row.id),
      testIds: mountedProps().map((props) => props.testID).filter((testId) => testId.startsWith('web-')) }) };
    restores.push(() => { if (probeDescriptor) Object.defineProperty(globalThis, '__PI_NATIVE_SEARCH_PROBE__', probeDescriptor);
      else delete globalThis.__PI_NATIVE_SEARCH_PROBE__; });
    router.push(`/chat/${id}`);
    await until(() => mountedProps().some((props) => props.testID === 'conversation-screen'), 'Fixture conversation did not mount');
    const submission = await service.send(id, 'Search the web and include sources.');
    await until(() => service.getConversation(id).messages.some((row) => row.webSearch?.calls.some((call) => call.status === 'running')),
      'Search activity did not reach the committed app projection');
    const running = service.getConversation(id).messages.find((row) => row.webSearch);
    fixtureRowId = running.id;
    check(!running.text, 'Search progress must be visible before the first text');
    await until(() => mountedProps().some((props) => props.testID === `web-search-${running.id}` && props.accessibilityState?.busy),
      'Running search UI did not mount before text');
    phase = 'searching';
    await sleep(holdStage === 'searching' ? Math.max(350, holdMs) : 350);
    complete();
    check((await service.waitForSubmission(submission)).status === 'done', 'Native response did not settle');
    const finished = service.getConversation(id).messages.find((row) => row.webSearch?.citations.length);
    check(finished?.id === running.id, 'The assistant row identity changed at completion');
    check(finished.webSearch.calls[0].status === 'completed', 'The search did not complete');
    check(finished.webSearch.sources.length === 2 && finished.webSearch.citations.length === 1, 'Sources or citations were lost');
    check(!JSON.stringify(finished).includes('opaque-native-test-state'), 'Encrypted provider state leaked into a UI row');
    await until(() => mountedProps().some((props) => props.testID === `web-sources-${finished.id}`), 'Sources UI did not mount');
    phase = 'completed';
    if (holdMs && holdStage === 'completed') await sleep(holdMs);
    const previous = JSON.stringify(service.getConversation(id).messages);
    await service.close();
    await reopen();
    check(JSON.stringify(service.getConversation(id).messages) === previous, 'Native SQLite reopen lost displayed metadata');
    // Re-mount after replacing the service so the fixture hooks subscribe to the new instance.
    router.replace('/');
    await until(() => !mountedProps().some((props) => props.testID === `web-search-${fixtureRowId}`),
      'Fixture conversation did not unmount before reopening');
    router.push(`/chat/${id}`);
    await until(() => mountedProps().some((props) => props.testID === `web-sources-${fixtureRowId}`),
      'Reopened fixture conversation did not mount');
    await service.waitForSubmission(await service.send(id, 'Continue using those results.'));
    check(requests.length === 2, 'Unexpected request count');
    check(requests[0].tools.filter((tool) => tool.type === 'web_search').length === 1, 'Native web search was not injected exactly once');
    check(requests[0].include.includes('web_search_call.action.sources'), 'Source inclusion was not requested');
    return { ok: true, hermes: typeof globalThis.HermesInternal === 'object', database, providerCalls: requests.length,
      checks: { realResponsesAdapter: true, nativeSQLite: true, searchVisibleBeforeText: true,
        terminalSourcesAndCitations: true, stableRow: true, reopenedProjection: true, replayedEncryptedState: true,
        readableSourceFactAfterReopen: true, noRawHostedCallReplay: true,
        noEncryptedStateInUI: true }, network: 'Synthetic HTTP SSE only; no account credentials accessed' };
  } finally {
    for (const restore of restores.reverse()) restore();
    try {
      // The follow-up push has mounted above; restore the original runtime
      // before mounting Home so it immediately displays the saved app data.
      router.replace('/');
      if (fixtureRowId) await until(() => !mountedProps().some((props) => props.testID === `web-search-${fixtureRowId}`),
        'Fixture conversation did not unmount during cleanup');
      await sleep(100);
    } finally {
      await service?.close();
    }
  }
}
