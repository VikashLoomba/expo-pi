// Runs inside Metro's actual Hermes runtime. Only model transport is scripted. Each namespace gets its own chat
// database and workspace directory; the verify stage deletes them when it finishes.
export default async function workspaceToolsProbe({ namespace, stage, platform }) {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const requireModule = (suffix) => {
    const matches = [...globalThis.__r.getModules()].filter(([, value]) => {
      const path = (value.verboseName || '').replace(/\\/g, '/');
      return path === suffix || path.endsWith(`/${suffix}`);
    });
    check(matches.length === 1, `Expected one module ${suffix}; got ${matches.length}`);
    return globalThis.__r(matches[0][0]);
  };
  const ai = requireModule('@earendil-works/pi-ai/dist/index.js');
  const { anthropicProvider } = requireModule('@earendil-works/pi-ai/dist/providers/anthropic.js');
  const { BACKGROUND_CONTEXT: context } = requireModule('@earendil-works/chord/dist/context/index.js');
  const { DurableChatService } = requireModule('src/pi/chat-service.ts');
  const { openExpoSqliteStorage } = requireModule('src/pi/storage/index.ts');
  const { createDeviceWorkspaces } = requireModule('src/pi/workspace/device-storage.ts');
  const { WorkspaceExecutionEnv } = requireModule('src/pi/workspace/execution-env.ts');
  const { Directory, File, Paths } = requireModule('expo-file-system/build/index.js');
  const { deleteDatabaseAsync } = requireModule('expo-sqlite/build/index.js');

  const databaseName = `${namespace}-chats.db`;
  const rootName = `${namespace}-workspaces`;
  const root = new Directory(Paths.document, rootName);
  const workspaces = createDeviceWorkspaces(rootName);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const value = (result) => { if (!result.ok) throw result.error; return result.value; };
  const sameBytes = (left, right) => left.length === right.length && left.every((byte, index) => byte === right[index]);
  const report = { stage, namespace, platform, hermes: typeof globalThis.HermesInternal === 'object',
    network: 'Scripted provider transport; no provider HTTP or credentials', checks: [] };
  const record = (label, condition) => { check(condition, label); report.checks.push(label); };
  const removeFixtures = async () => {
    if (root.exists) root.delete();
    await deleteDatabaseAsync(databaseName).catch(() => {});
    report.cleanedUp = !root.exists;
  };

  // Each element is one model turn: a list of tool calls, or the final text answer.
  const script = stage === 'seed' ? [[
    ['write', { path: 'nested/原稿.txt', content: '\uFEFFalpha\r\n世界 😀\r\n' }],
    ['bash', { command: [
      'printf AP9B | base64 -d > binary', 'printf temporary > /tmp/session', 'cat /tmp/session; echo',
      'mkdir -p deep/a/b', 'printf \'{"n":2}\' > deep/a/b/d.json', 'jq .n deep/a/b/d.json',
      "ls nested | grep -c txt", "sed -n 2p nested/原稿.txt", 'echo SHELL_SEEDED',
    ].join('\n') }],
    ['edit', { path: 'nested/原稿.txt', edits: [{ oldText: 'alpha', newText: 'edited' }] }],
    ['read', { path: 'nested/原稿.txt', offset: 2, limit: 1 }],
    ['edit', { path: 'nested/原稿.txt', edits: [{ oldText: 'edited', newText: 'wrong' }, { oldText: 'absent', newText: 'x' }] }],
    ['read', { path: 'nested/原稿.txt' }],
    ['edit', { path: 'binary', edits: [{ oldText: 'A', newText: 'B' }] }],
    ['bash', { command: 'test ! -e /tmp/session && echo FRESH_TMP; base64 binary' }],
  ], 'text', [
    ['read', { path: 'binary' }],
    ['bash', { command: 'test ! -e binary && test ! -e nested && echo ISOLATED' }],
  ], 'text'] : [[
    ['read', { path: 'nested/原稿.txt' }],
    ['bash', { command: 'test ! -e /tmp/session && echo FRESH_TMP; base64 binary; jq .n deep/a/b/d.json' }],
    ['write', { path: 'binary', content: 'reopened 世界 😀\n' }],
    ['read', { path: 'binary' }],
  ], 'text'];
  const models = ai.createModels({ credentials: new ai.InMemoryCredentialStore(),
    authContext: { env: async () => undefined, fileExists: async () => false } });
  let providerCalls = 0;
  let offered = [];
  const dispatch = (model, request) => {
    offered = ai.getCurrentTools(request.messages).map((tool) => tool.name);
    const turn = script[providerCalls++] ?? 'text';
    const calls = turn === 'text' ? [] : turn;
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: calls.length ? calls.map(([name, args], index) => ({ type: 'toolCall', id: `${stage}-${providerCalls}-${index}`, name, arguments: args }))
        : [{ type: 'text', text: 'Workspace validation finished.' }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: calls.length ? 'toolUse' : 'stop', timestamp: Date.now() };
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
  const storage = await openExpoSqliteStorage(databaseName);
  const workspaceOf = async (chatId) => {
    const doc = await storage.findDocument({ kind: 'app.bash.workspace', scope: { kind: 'conversation', conversationId: Number(chatId) } }, 'current', context);
    return (await storage.document(doc.id, 'current', context)).value.id;
  };
  const toolRows = async (chatService, chatId) => (await readChat(chatService, chatId)).messages.filter((row) => row.tool);
  const runTurn = async (chatService, chatId) => {
    const before = (await toolRows(chatService, chatId)).length;
    const receipt = await chatService.waitForSubmission(await chatService.send(chatId, `Run ${stage} verification.`));
    check(receipt.status === 'done', `submission ended ${receipt.status}`);
    return (await toolRows(chatService, chatId)).slice(before);
  };
  const service = await DurableChatService.open({ storage, models, workspaces });
  let finished = false;
  try {
    if (stage === 'seed') {
      const first = await service.createChat();
      const rows = await runTurn(service, first);
      record('all four tools offered', ['read', 'write', 'edit', 'bash'].every((name) => offered.includes(name)));
      record('expected tool outcomes', rows.length === 8 && rows.every((row, index) =>
        row.tool.status === ([4, 6].includes(index) ? 'error' : 'completed')));
      const output = rows.map((row) => row.tool.output).join('\n');
      record('common shell commands ran (redirects, mkdir -p, jq, grep, sed)', /temporary\n2\n1\n世界 😀/.test(rows[1].tool.output) && output.includes('SHELL_SEEDED'));
      record('/tmp starts empty for each command', output.includes('FRESH_TMP'));
      record('failed edit batch preserves original bytes', rows[5].tool.output.includes('edited') && !rows[5].tool.output.includes('wrong'));
      record('edit refuses invalid UTF-8', /Error code: invalid/.test(rows[6].tool.output) && rows[7].tool.output.includes('AP9B'));
      record('edit card shows a bounded diff', rows[2].tool.file?.diff?.includes('edited') && !('patchPath' in rows[2].tool.file));
      const firstId = await workspaceOf(first);
      const stored = await new File(root, firstId, 'nested', '原稿.txt').bytes();
      record('exact BOM, CRLF and Unicode bytes on disk through expo-file-system', sameBytes(stored, encoder.encode('\uFEFFedited\r\n世界 😀\r\n')));
      record('binary bytes on disk', sameBytes(await new File(root, firstId, 'binary').bytes(), Uint8Array.from([0, 255, 65])));

      const second = await service.createChat();
      const isolated = await runTurn(service, second);
      record('chats cannot see each other’s files', isolated[0].tool.status === 'error' && /ENOENT/.test(isolated[0].tool.output)
        && isolated[1].tool.output.includes('ISOLATED'));

      const env = new WorkspaceExecutionEnv(workspaces.workspace(firstId), firstId);
      for (const text of ['', '\uFEFFx', '\uFEFF\uFEFFx', '😀\r\n世界', '�']) {
        value(await env.writeFile('encoding-check', encoder.encode(text), context));
        check(value(await env.readTextFile('encoding-check', context)) === text, `strict UTF-8 sample ${JSON.stringify(text)}`);
      }
      for (const malformed of [[0x80], [0xc0, 0xaf], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xf0, 0x80, 0x80, 0x80],
        [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80], [0xe2, 0x82]]) {
        value(await env.writeFile('encoding-check', Uint8Array.from(malformed), context));
        const result = await env.readTextFile('encoding-check', context);
        check(!result.ok && result.error.code === 'invalid', `strict UTF-8 rejects ${malformed}`);
      }
      record('Hermes strict UTF-8 decoding keeps BOMs and rejects malformed bytes', true);
      const backing = Uint8Array.from([9, 9, 9, 1, 2, 3, 4, 5, 6, 9, 9]);
      value(await env.writeFile('subarray', backing.subarray(3, 9), context));
      record('a typed-array view is written exactly', sameBytes(await new File(root, firstId, 'subarray').bytes(), backing.subarray(3, 9)));
      value(await env.writeFile('reader-original', 'original file', context));
      value(await env.writeFile('reader-replacement', 'replacement file', context));
      const reader = value(await env.openBinaryReader('reader-original', undefined, context));
      try {
        value(await env.renameFile('reader-replacement', 'reader-original', context));
        record('an opened FileHandle keeps reading its file after a replacing rename',
          decoder.decode(value(await reader.read(0, 100, context))) === 'original file'
          && value(await reader.read(100, 10, context)).length === 0);
      } finally { await reader.close(context); }
      let literal = '';
      value(await env.exec(['printf', '%s', 'literal $HOME; echo escaped'], {
        onOutput: (text, _context, info) => { if (info.stream === 'stdout') literal += text; },
      }, context));
      record('argv arguments bypass shell parsing', literal === 'literal $HOME; echo escaped');
      const watcher = await env.watch([], () => {}, context);
      record('watch reports not supported', !watcher.ok && watcher.error.code === 'not_supported');
      report.conversationIds = [first, second];
    } else {
      const chats = service.getSnapshot().chats;
      check(chats.length === 2, `Both seeded chats must survive relaunch; found ${chats.length}`);
      let first;
      for (const chat of chats) {
        if ((await toolRows(service, chat.id)).some((row) => row.tool.name === 'edit' && row.tool.file?.diff?.includes('edited'))) first = chat.id;
      }
      record('committed edit diff survives relaunch', first !== undefined);
      const rows = await runTurn(service, first);
      record('files written before relaunch read back exactly', rows[0].tool.output === '\uFEFFedited\r\n世界 😀\r\n'
        || rows[0].tool.output === 'edited\r\n世界 😀\r\n');
      record('shell sees persisted files and a fresh /tmp after relaunch', /FRESH_TMP\nAP9B\n2/.test(rows[1].tool.output));
      record('write then read after relaunch', rows[2].tool.status === 'completed' && rows[3].tool.output === 'reopened 世界 😀\n');
    }
    report.providerCalls = providerCalls;
    report.ok = true;
    finished = true;
    return report;
  } finally {
    await service.close();
    // Seeded fixtures stay for the verify stage; every other outcome removes them.
    if (stage !== 'seed' || !finished) await removeFixtures();
  }
}
