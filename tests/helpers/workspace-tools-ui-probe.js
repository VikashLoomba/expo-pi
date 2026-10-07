// Mounts the real native transcript with an isolated fixture it commits first, and removes the fixture afterwards.
export default async function workspaceToolsUiProbe({ namespace, platform, holdMs = 0 }) {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const requireModule = (suffix) => {
    const matches = [...globalThis.__r.getModules()].filter(([, value]) => {
      const path = (value.verboseName || '').replace(/\\/g, '/');
      return path === suffix || path.endsWith(`/${suffix}`);
    });
    check(matches.length === 1, `Expected one module ${suffix}`);
    return globalThis.__r(matches[0][0]);
  };
  const ai = requireModule('@earendil-works/pi-ai/dist/index.js');
  const { anthropicProvider } = requireModule('@earendil-works/pi-ai/dist/providers/anthropic.js');
  const { DurableChatService } = requireModule('src/pi/chat-service.ts');
  const { openExpoSqliteStorage } = requireModule('src/pi/storage/index.ts');
  const { createDeviceWorkspaces } = requireModule('src/pi/workspace/device-storage.ts');
  const { Directory, Paths } = requireModule('expo-file-system/build/index.js');
  const { deleteDatabaseAsync } = requireModule('expo-sqlite/build/index.js');
  const { buildModelCatalog } = requireModule('src/pi/model-catalog.ts');
  const providerModule = requireModule('src/chat/chat-provider.tsx');
  const { router } = requireModule('expo-router/build/exports.js');
  const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  check(hook?.getFiberRoots, 'React development tree required');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function mountedFibers() {
    const fibers = [];
    for (const renderer of hook.renderers.keys()) for (const root of hook.getFiberRoots(renderer)) {
      const stack = [root.current];
      while (stack.length) {
        const fiber = stack.pop();
        if (fiber.memoizedProps?.testID) fibers.push(fiber);
        for (let child = fiber.child; child; child = child.sibling) stack.push(child);
      }
    }
    return fibers;
  }
  const mountedProps = () => mountedFibers().map((fiber) => fiber.memoizedProps);
  async function until(predicate, message) {
    const deadline = Date.now() + 15000;
    while (!predicate()) { check(Date.now() < deadline, message); await sleep(25); }
  }
  const models = ai.createModels({ credentials: new ai.InMemoryCredentialStore(),
    authContext: { env: async () => undefined, fileExists: async () => false } });
  // The fixture's one tool round: write a file and edit it, so the transcript has a committed edit card.
  let providerCalls = 0;
  const dispatch = (model) => {
    const first = providerCalls++ === 0;
    const calls = [{ type: 'toolCall', id: 'ui-write', name: 'write', arguments: { path: 'notes.txt', content: 'alpha\nbeta\n' } },
      { type: 'toolCall', id: 'ui-edit', name: 'edit', arguments: { path: 'notes.txt', edits: [{ oldText: 'alpha', newText: 'edited' }] } }];
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: first ? calls : [{ type: 'text', text: 'Fixture ready.' }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now() };
    const stream = ai.createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: message.stopReason, message });
    return stream;
  };
  models.setProvider({ ...anthropicProvider(), auth: { apiKey: { name: 'Local verification',
    check: async () => ({ type: 'api_key' }), resolve: async () => ({ auth: { apiKey: 'synthetic-no-network' } }) } },
    stream: dispatch, streamSimple: dispatch });
  // Read a chat the way the chat screen does: subscribe to its view until it has loaded.
  const readChat = async (chatService, chatId) => {
    const view = chatService.chat(chatId, { transcript: true });
    const stop = view.subscribe(() => {});
    try {
      const deadline = Date.now() + 5_000;
      while (view.getSnapshot().status === 'loading') {
        if (Date.now() > deadline) throw new Error('The chat view did not load.');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return view.getSnapshot().conversation;
    } finally { stop(); }
  };
  const databaseName = `${namespace}-chats.db`;
  const rootName = `${namespace}-workspaces`;
  const service = await DurableChatService.open({
    storage: await openExpoSqliteStorage(databaseName), models, workspaces: createDeviceWorkspaces(rootName),
  });
  // The route resolves its chat before any screen calls the hook, so bind the mounted runtime up front.
  function mountedRuntime(devtoolsHook) {
    for (const renderer of devtoolsHook.renderers.keys()) for (const root of devtoolsHook.getFiberRoots(renderer)) {
      const stack = [root.current];
      while (stack.length) {
        const fiber = stack.pop();
        const value = fiber.memoizedProps?.value;
        if (value?.runtime && 'chats' in value) return value.runtime;
        for (let child = fiber.child; child; child = child.sibling) stack.push(child);
      }
    }
    throw new Error('The mounted chat runtime was not found.');
  }
  const restores = [];
  function replaceRuntimeMethod(runtime, name, replacement) {
    const descriptor = Object.getOwnPropertyDescriptor(runtime, name);
    Object.defineProperty(runtime, name, { configurable: true, writable: true, value: replacement });
    restores.push(() => { if (descriptor) Object.defineProperty(runtime, name, descriptor); else delete runtime[name]; });
  }
  let row;
  try {
    const id = await service.createChat();
    const receipt = await service.waitForSubmission(await service.send(id, 'Prepare the edit card fixture.'));
    check(receipt.status === 'done', 'Fixture tool round must complete');
    const messages = (await readChat(service, id)).messages;
    row = messages.find((message) => message.tool?.name === 'edit' && message.tool.file?.diff?.includes('edited'));
    check(row, 'Persisted successful edit diff required');
    let boundRuntime;
    function delegate(runtime) {
      if (boundRuntime === runtime) return;
      check(!boundRuntime, 'App runtime changed during fixture');
      boundRuntime = runtime;
      const overrides = {
        findChat: (key) => service.findChat(key),
        chat: (chatId, options) => service.chat(chatId, options),
        send: (chatId, text) => service.send(chatId, text), cancel: (chatId) => service.cancel(chatId),
        updateSettings: (chatId, settings) => service.updateSettings(chatId, settings),
        createChat: () => service.createChat(), renameChat: (chatId, title) => service.renameChat(chatId, title),
        archiveChat: (chatId) => service.archiveChat(chatId),
      };
      for (const [name, replacement] of Object.entries(overrides)) {
        replaceRuntimeMethod(runtime, name, replacement);
      }
    }
    const original = providerModule.useChatApp;
    const descriptor = Object.getOwnPropertyDescriptor(providerModule, 'useChatApp');
    providerModule.useChatApp = () => {
      const app = original();
      delegate(app.runtime);
      return { ...app, ...service.getSnapshot(), ready: true, catalog: buildModelCatalog(models),
        providerAccess: () => ({ ready: true, connected: true }), signingIn: false, hasConnectedProvider: true };
    };
    restores.push(() => Object.defineProperty(providerModule, 'useChatApp', descriptor));
    delegate(mountedRuntime(hook));
    router.push(`/chat/${id}`);
    await until(() => mountedProps().some((props) => props.testID === `tool-${row.id}` && props.onPress), 'Persisted edit card did not mount');
    const card = mountedProps().find((props) => props.testID === `tool-${row.id}` && props.onPress);
    check(!card.accessibilityState.expanded, 'Edit card should start collapsed');
    card.onPress();
    await until(() => mountedProps().some((props) => props.testID === `tool-diff-${row.id}`), 'Expanded diff did not mount');
    const diff = mountedProps().find((props) => props.testID === `tool-diff-${row.id}`);
    check(diff.children === row.tool.file.diff, 'Mounted diff differs from persisted projection');
    const expanded = mountedProps().find((props) => props.testID === `tool-${row.id}` && props.onPress);
    check(expanded.accessibilityState.expanded && expanded.accessibilityLabel.includes('notes.txt'), 'Expanded path-aware accessible card missing');
    if (holdMs) {
      // Use the mounted FlatList's public method to bring the observed row into
      // the screenshot after its expanded height has settled.
      await sleep(350);
      const list = mountedFibers().find((fiber) => fiber.memoizedProps.testID === 'message-list' && fiber.stateNode?.scrollToIndex);
      check(list, 'Mounted transcript list required for screenshot');
      list.stateNode.scrollToIndex({ index: messages.findIndex((message) => message.id === row.id), viewPosition: 0.2, animated: false });
      await sleep(holdMs);
    }
    return { ok: true, hermes: typeof globalThis.HermesInternal === 'object', conversationId: id,
      rowId: row.id, path: row.tool.file.path, diff: diff.children,
      checks: ['persisted edit card mounted', 'collapsed card expanded through actual onPress', 'expanded diff equals persisted projection', 'accessible card includes path and expanded state'] };
  } finally {
    for (const restore of restores.reverse()) restore();
    try {
      router.replace('/');
      if (row) await until(() => !mountedProps().some((props) => props.testID === `tool-${row.id}`), 'Fixture did not unmount');
      await sleep(100);
    } finally {
      await service.close();
      const root = new Directory(Paths.document, rootName);
      if (root.exists) root.delete();
      await deleteDatabaseAsync(databaseName).catch(() => {});
    }
  }
}
