// Serialized into a development Hermes runtime. No app source instrumentation.
export default async function nativeStreamingProbe({ database, durationMs = 8_000, manual = false, seedTurns = 0 }) {
  const modules = globalThis.__r?.getModules?.();
  const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!modules || !hook?.getFiberRoots) throw new Error('A connected Hermes development build with React DevTools is required.');
  function requireSuffix(suffix) {
    const matches = [...modules].filter(([, module]) => {
      const path = (module.verboseName || '').replace(/\\/g, '/');
      return path === suffix || path.endsWith(`/${suffix}`);
    });
    if (matches.length !== 1) throw new Error(`Expected one Metro module matching ${suffix}; found ${matches.length}`);
    return globalThis.__r(matches[0][0]);
  }
  const ai = requireSuffix('@earendil-works/pi-ai/dist/index.js');
  const { anthropicProvider } = requireSuffix('@earendil-works/pi-ai/dist/providers/anthropic.js');
  const { openExpoSqliteStorage } = requireSuffix('src/pi/storage/index.ts');
  const { DurableChatService } = requireSuffix('src/pi/chat-service.ts');
  const { buildModelCatalog } = requireSuffix('src/pi/model-catalog.ts');
  const providerModule = requireSuffix('src/chat/chat-provider.tsx');
  const { router } = requireSuffix('expo-router/build/exports.js');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (predicate, description) => {
    const limit = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() > limit) throw new Error(`Timed out: ${description}`);
      await sleep(20);
    }
  };
  const markdown = Array.from({ length: 18 }, (_, index) => `\n\n## Section ${index + 1}\n\n`
    + 'Streaming **bold text**, _emphasis_, and `inline code` should stay readable as the response grows. '
    + 'A paragraph wraps over multiple lines to exercise dynamic measurement.\n\n'
    + '- First point with **an unfinished marker**\n- Second point with a [link](https://example.com)\n\n'
    + '```js\nconst answer = 19 + 23;\nconsole.log(answer);\n```\n').join('');
  const models = ai.createModels({ credentials: new ai.InMemoryCredentialStore(),
    authContext: { env: async () => undefined, fileExists: async () => false } });
  let mode = 'seed';
  let providerCalls = 0;
  let emittedChunks = 0;
  let generationTask;
  const makeMessage = (model, text, stopReason = 'stop') => ({
    role: 'assistant', content: [{ type: 'text', text }], api: model.api,
    provider: model.provider, model: model.id, stopReason, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const dispatch = (model, _context, options) => {
    providerCalls++;
    const stream = ai.createAssistantMessageEventStream();
    generationTask = (async () => {
      if (mode === 'seed') {
        const message = makeMessage(model, '## Earlier conversation\n\n'
          + 'Earlier saved context stays in place while the next response streams. '.repeat(70));
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: 'stop', message });
        return;
      }
      let text = '';
      stream.push({ type: 'start', partial: makeMessage(model, text) });
      const count = Math.ceil(durationMs / 16);
      const size = Math.ceil(markdown.length / count);
      const streamStartedAt = Date.now();
      for (let cursor = 0; cursor < markdown.length; cursor += size) {
        if (options.signal.aborted) {
          stream.push({ type: 'error', reason: 'aborted', error: makeMessage(model, text, 'aborted') });
          return;
        }
        const delta = markdown.slice(cursor, cursor + size);
        text += delta;
        emittedChunks++;
        stream.push({ type: 'text_delta', contentIndex: 0, delta, partial: makeMessage(model, text) });
        const nextAt = streamStartedAt + Math.min(1, (cursor + size) / markdown.length) * durationMs;
        await sleep(Math.max(0, nextAt - Date.now()));
      }
      stream.push({ type: 'done', reason: 'stop', message: makeMessage(model, text) });
    })();
    return stream;
  };
  models.setProvider({ ...anthropicProvider(),
    auth: { apiKey: { name: 'Streaming validation only', check: async () => ({ type: 'api_key' }),
      resolve: async () => ({ auth: { apiKey: 'synthetic-no-network' } }) } },
    stream: dispatch, streamSimple: dispatch });
  const service = await DurableChatService.open({ storage: await openExpoSqliteStorage(database), models });
  const restores = [];
  let frameRequest;
  let sampling = false;
  let previousFrame;
  let list;
  let listFiber;
  let phase = 'setup';
  let rootCommits = 0;
  let watched;
  let stopWatching = () => {};
  const frameIntervals = [];
  const commands = [];
  const offsets = [];
  /** Assistant row IDs in render order, and the IDs seen while their row was streaming. */
  const renderedIds = new Set();
  const streamingIds = new Set();
  const patched = new WeakMap();
  function walk(fiber, visit) {
    if (!fiber) return;
    const stack = [fiber];
    while (stack.length) {
      const next = stack.pop();
      visit(next);
      for (let child = next.child; child; child = child.sibling) stack.push(child);
    }
  }
  function roots() {
    const result = new Set();
    const rendererIds = hook.renderers ? [...hook.renderers.keys()] : [1];
    for (const id of rendererIds) hook.getFiberRoots(id)?.forEach((root) => result.add(root));
    return result;
  }
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
  // Evaluated source runs without per-iteration loop bindings, so each restore captures its own parameters.
  function override(target, name, value) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { configurable: true, writable: true, value });
    restores.push(() => { if (descriptor) Object.defineProperty(target, name, descriptor); else delete target[name]; });
  }
  function patchMethod(target, name, category) {
    if (!target || typeof target[name] !== 'function') return;
    const names = patched.get(target) || new Set();
    if (names.has(name)) return;
    names.add(name); patched.set(target, names);
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    const original = target[name];
    try {
      target[name] = function (...args) {
        if (sampling) commands.push({ method: `${category}.${name}`, phase, time: performance.now(),
          offset: args[0]?.offset ?? args[0]?.y, animated: args[0]?.animated });
        return original.apply(this, args);
      };
      restores.push(() => { if (descriptor) Object.defineProperty(target, name, descriptor); else delete target[name]; });
    } catch { /* A readonly native method cannot be instrumented. */ }
  }
  function collect() {
    for (const root of roots()) walk(root.current, (fiber) => {
      if (fiber.memoizedProps?.testID === 'message-list' && typeof fiber.stateNode?.scrollToOffset === 'function') {
        list = fiber.stateNode; listFiber = fiber;
      }
    });
    if (!list) return;
    patchMethod(list, 'scrollToEnd', 'FlatList');
    patchMethod(list, 'scrollToOffset', 'FlatList');
    const native = list.getNativeScrollRef?.() || list.getScrollRef?.() || list.getScrollResponder?.();
    patchMethod(native, 'scrollTo', 'ScrollView');
    patchMethod(native, 'scrollToEnd', 'ScrollView');
    walk(listFiber, (fiber) => {
      const message = fiber.memoizedProps?.message;
      if (!message || message.role !== 'assistant') return;
      renderedIds.add(message.id);
      if (message.streaming) streamingIds.add(message.id);
    });
  }
  function metrics() {
    const virtual = list?._scrollMetrics ? list : list?._listRef;
    const scroll = virtual?._scrollMetrics;
    return { offset: scroll?.offset ?? 0, height: scroll?.visibleLength ?? 0,
      content: virtual?._listMetrics?.getContentLength?.() ?? 0 };
  }
  function tick(now) {
    if (!sampling) return;
    if (previousFrame !== undefined) frameIntervals.push(now - previousFrame);
    previousFrame = now;
    offsets.push({ time: now, phase, ...metrics() });
    frameRequest = requestAnimationFrame(tick);
  }
  const messages = () => watched?.getMessages() ?? [];
  const originalCommit = hook.onCommitFiberRoot;
  try {
    const id = await service.createChat();
    await service.waitForSubmission(await service.send(id, 'Seed an earlier long response.'));
    if (seedTurns > 0) {
      // Saved history for measuring a long chat: earlier turns committed directly, no model requests.
      const { BACKGROUND_CONTEXT: context } = requireSuffix('@earendil-works/chord/dist/context/index.js');
      const conversation = await service.harness.conversation(id, context);
      const model = anthropicProvider().getModels()[0];
      await conversation.commit(async (tx) => {
        for (let turn = 0; turn < seedTurns; turn++) {
          await tx.appendEntry(id, { kind: 'pi.user', model: [{ role: 'user', content: `Earlier question ${turn}.`,
            timestamp: Date.now() }] });
          await tx.appendEntry(id, { kind: 'pi.assistant', model: [makeMessage(model,
            `**Earlier answer ${turn}.** ` + 'Saved context with a [link](https://example.com) and `code`. '.repeat(6))] });
        }
      }, context);
    }
    watched = service.chat(id, { transcript: true });
    stopWatching = watched.subscribe(() => {});
    const probeDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__PI_STREAMING_PROBE__');
    const inspect = () => ({ phase, sampling, ...metrics(), emittedChunks, jsCommands: commands.length,
      streamingCharacters: messages().find((message) => message.streaming)?.text.length ?? 0 });
    globalThis.__PI_STREAMING_PROBE__ = {
      snapshot: inspect,
      markPhase: (name) => { phase = String(name); return inspect(); },
    };
    restores.push(() => {
      if (probeDescriptor) Object.defineProperty(globalThis, '__PI_STREAMING_PROBE__', probeDescriptor);
      else delete globalThis.__PI_STREAMING_PROBE__;
    });
    // Keep every original hook call; only the mounted runtime's chat methods use the isolated service, and the
    // fixture provider counts as connected.
    const catalog = buildModelCatalog(models);
    const runtime = mountedRuntime(hook);
    override(runtime, 'findChat', (key) => service.findChat(key));
    override(runtime, 'chat', (chatId, options) => service.chat(chatId, options));
    override(runtime, 'send', (chatId, text) => service.send(chatId, text));
    override(runtime, 'cancel', (chatId) => service.cancel(chatId));
    const originalApp = providerModule.useChatApp;
    const appDescriptor = Object.getOwnPropertyDescriptor(providerModule, 'useChatApp');
    providerModule.useChatApp = () => ({ ...originalApp(), ready: true, catalog,
      providerAccess: () => ({ ready: true, connected: true }) });
    restores.push(() => Object.defineProperty(providerModule, 'useChatApp', appDescriptor));
    hook.onCommitFiberRoot = function (...args) {
      const result = originalCommit?.apply(this, args);
      if (sampling) rootCommits++;
      collect();
      return result;
    };
    router.push(`/chat/${id}`);
    await until(() => { collect(); return list && renderedIds.size > 0; }, 'fixture conversation to mount');
    const seededIds = [...renderedIds];
    await sleep(500);
    phase = 'following'; sampling = true;
    frameRequest = requestAnimationFrame(tick);
    mode = 'stream';
    const submission = await service.send(id, 'Write a detailed Markdown answer with headings, lists, code, and links.');
    // Reanimated installs callable JS event wrappers that are not gesture handlers.
    // Exercise native drag delivery externally; never invoke these wrappers as a synthetic gesture.
    const receipt = await service.waitForSubmission(submission);
    await generationTask;
    await until(() => messages().at(-1)?.text === markdown && !messages().at(-1)?.streaming, 'the saved answer');
    await sleep(500);
    collect();
    sampling = false; cancelAnimationFrame(frameRequest);
    const finalRow = messages().at(-1);
    const sorted = frameIntervals.slice().sort((a, b) => a - b);
    const quantile = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
    const byMethod = {};
    for (const command of commands) byMethod[command.method] = (byMethod[command.method] || 0) + 1;
    const offsetDeltas = offsets.slice(1).map((value, index) => value.offset - offsets[index].offset);
    const phases = {};
    for (const sample of offsets) {
      const current = phases[sample.phase];
      if (!current) phases[sample.phase] = { startOffset: sample.offset, endOffset: sample.offset,
        minOffset: sample.offset, maxOffset: sample.offset, startContent: sample.content, endContent: sample.content };
      else {
        current.endOffset = sample.offset;
        current.endContent = sample.content;
        current.minOffset = Math.min(current.minOffset, sample.offset);
        current.maxOffset = Math.max(current.maxOffset, sample.offset);
      }
    }
    const streamedIds = [...streamingIds].filter((rowId) => !seededIds.includes(rowId));
    const report = {
      ok: receipt.status === 'done', hermes: typeof globalThis.HermesInternal === 'object', database,
      providerCalls, emittedChunks, markdownCharacters: markdown.length,
      scrolling: { changedFrames: offsetDeltas.filter((delta) => Math.abs(delta) > 0.5).length,
        maxForwardStep: Math.max(0, ...offsetDeltas), maxBackwardStep: Math.min(0, ...offsetDeltas), final: metrics(), phases },
      rows: { seededIds, streamedIds, finalId: finalRow?.id, renderedAssistantIds: [...renderedIds] },
      manualGesture: { requested: manual, syntheticEvents: false,
        readingHistory: phases['reading-history'] ? {
          contentGrowth: phases['reading-history'].endContent - phases['reading-history'].startContent,
          offsetDrift: phases['reading-history'].endOffset - phases['reading-history'].startOffset,
          offsetRange: phases['reading-history'].maxOffset - phases['reading-history'].minOffset,
        } : null },
      // Diagnostic only: JS rAF timing measures JS responsiveness, not UI-thread frames, and is not a pass criterion.
      diagnostics: { rootCommits, jsScrollCommands: byMethod,
        pacing: { frames: sorted.length, medianMs: quantile(0.5), p95Ms: quantile(0.95), p99Ms: quantile(0.99),
          maxMs: sorted.at(-1) ?? 0, over34Ms: sorted.filter((ms) => ms > 34).length,
          over50Ms: sorted.filter((ms) => ms > 50).length } },
      limitations: 'Reanimated UI-thread commands bypass JS counters. Native gestures are checked only when the '
        + 'reading-history phase is marked externally.',
    };
    report.checks = {
      measuredViewport: report.scrolling.final.content > report.scrolling.final.height && report.scrolling.final.height > 0,
      followedGrowingContent: !!phases.following && phases.following.endContent > phases.following.startContent
        && phases.following.maxOffset > phases.following.minOffset + 1,
      // The streamed row and the saved answer are one row: the same ID, rendered from the first delta to the end.
      stableFinalRow: streamedIds.length === 1 && streamedIds[0] === finalRow?.id && renderedIds.has(finalRow.id),
      earlierRowsKept: seededIds.every((rowId) => messages().some((message) => message.id === rowId)),
      endedAtBottom: Math.abs(Math.max(0, report.scrolling.final.content
        - report.scrolling.final.height) - report.scrolling.final.offset) <= 2,
    };
    if (manual) {
      report.checks.readerStayedPut = !!report.manualGesture.readingHistory
        && report.manualGesture.readingHistory.contentGrowth > 0
        && report.manualGesture.readingHistory.offsetRange <= 2;
      const jumped = phases['jump-to-latest'];
      report.checks.followedAfterJump = !!jumped && jumped.endContent > jumped.startContent
        && jumped.endOffset > jumped.startOffset + 1;
    }
    report.ok = report.ok && Object.values(report.checks).every(Boolean);
    return report;
  } finally {
    // Cleanup must not replace an error from the checks above.
    sampling = false;
    if (frameRequest !== undefined) cancelAnimationFrame(frameRequest);
    hook.onCommitFiberRoot = originalCommit;
    for (const restore of restores.reverse()) {
      try { restore(); } catch { /* Keep restoring the rest. */ }
    }
    try { router.replace('/'); } catch { /* The app may already be home. */ }
    stopWatching();
    await service.close().catch(() => {});
    await generationTask?.catch(() => {});
  }
}
