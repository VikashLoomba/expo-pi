// Serialized into a development Hermes runtime (or a browser's Metro runtime).
// The shell, Pi service, SQLite and crypto are real; model transport is scripted.
export default async function nativeBashProbe({ namespace, stage, platform }) {
  function requireModule(suffix) {
    const matches = [...globalThis.__r.getModules()].filter(([, value]) => {
      const path = (value.verboseName || '').replace(/\\/g, '/');
      return path === suffix || path.endsWith(`/${suffix}`);
    });
    if (matches.length !== 1) throw new Error(`Expected one module: ${suffix}, got ${matches.length}`);
    return globalThis.__r(matches[0][0]);
  }
  const ai = requireModule('@earendil-works/pi-ai/dist/index.js');
  const { anthropicProvider } = requireModule('@earendil-works/pi-ai/dist/providers/anthropic.js');
  const { DurableChatService } = requireModule('src/pi/chat-service.ts');
  const { openExpoSqliteStorage } = requireModule('src/pi/storage/index.ts');
  const { createDeviceWorkspaces } = requireModule('src/pi/workspace/device-storage.ts');
  const { Directory, File, Paths } = requireModule('expo-file-system/build/index.js');
  const { deleteDatabaseAsync } = requireModule('expo-sqlite/build/index.js');
  const databaseName = `${namespace}-chats.db`;
  const rootName = `${namespace}-workspaces`;
  const root = new Directory(Paths.document, rootName);
  const models = ai.createModels({ credentials: new ai.InMemoryCredentialStore(),
    authContext: { env: async () => undefined, fileExists: async () => false } });
  const command = stage === 'seed' ? [
    'set -e',
    'mkdir -p one/sub two',
    "printf 'héllo 世界\\n' > one/value",
    'printf AP9B | base64 -d > binary',
    'printf session > /tmp/ephemeral',
    'cp -r one two/copy',
    "printf '{\"value\":42}' > data.json",
    'md5sum binary',
    'echo SEEDED',
  ].join('\n') : [
    'set -e',
    'if test -e /tmp/ephemeral; then echo TEMP_LEAK; exit 91; fi',
    'cat one/value two/copy/value',
    'base64 binary',
    'md5sum binary',
    'for hash in sha1sum sha256sum; do if $hash binary 2>/dev/null; then echo HASH_OFFERED; exit 93; fi; done',
    'mktemp /workspace/tmp.XXXXXX | grep -c tmp',
    'printf Z >> binary',
    'test "$(base64 binary)" = AP9BWg==',
    'mv two/copy two/moved && test ! -e two/copy',
    'ls two | sort | tr "\\n" " "; echo',
    'grep -rl héllo . | sort',
    "sed -n 's/héllo/bonjour/p' one/value",
    'jq -r .value data.json',
    'test -f /bin/cat',
    'rm -r two',
    'echo VERIFIED',
  ].join('\n');
  let providerCalls = 0;
  let offered = false;
  const dispatch = (model, context) => {
    offered ||= ai.getCurrentTools(context.messages).some((tool) => tool.name === 'bash');
    const isTool = ++providerCalls === 1;
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: isTool ? [{ type: 'toolCall', id: `bash-${stage}`, name: 'bash', arguments: { command, timeout: 30 } }]
        : [{ type: 'text', text: 'Native bash validation finished.' }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: isTool ? 'toolUse' : 'stop', timestamp: Date.now() };
    const stream = ai.createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: message.stopReason, message });
    return stream;
  };
  models.setProvider({ ...anthropicProvider(), auth: { apiKey: {
    name: 'Scripted local validation', check: async () => ({ type: 'api_key' }),
    resolve: async () => ({ auth: { apiKey: 'synthetic-no-network' } }),
  } }, stream: dispatch, streamSimple: dispatch });
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
  const service = await DurableChatService.open({ models,
    storage: await openExpoSqliteStorage(databaseName), workspaces: createDeviceWorkspaces(rootName) });
  let finished = false;
  try {
    const id = stage === 'seed' ? await service.createChat() : service.getSnapshot().chats[0]?.id;
    if (!id) throw new Error('The seed conversation did not survive restart.');
    const receipt = await service.waitForSubmission(await service.send(id, `Run ${stage} validation.`));
    const rows = (await readChat(service, id)).messages.filter((row) => row.tool?.name === 'bash');
    const output = rows[rows.length - 1]?.tool.output ?? '';
    const expected = stage === 'seed' ? ['SEEDED']
      : ['héllo 世界\nhéllo 世界', 'AP9B', 'd396e6af3f0989f28c5be42adadb290f  binary', 'moved',
        'one/value\ntwo/moved/value', 'bonjour 世界', '42', 'VERIFIED'];
    const status = rows[rows.length - 1]?.tool.status;
    if (receipt.status !== 'done' || !offered || status !== 'completed'
      || expected.some((value) => !output.includes(value))) {
      throw new Error(`Shell validation failed: ${JSON.stringify({ receipt, offered, status, output })}`);
    }
    // The seeded files are real files in the chat's workspace directory.
    const workspaceDirectory = root.list().find((entry) => entry instanceof Directory);
    const binary = workspaceDirectory && new File(workspaceDirectory, 'binary');
    const onDisk = binary?.exists ? [...await binary.bytes()] : undefined;
    if (stage === 'seed' && JSON.stringify(onDisk) !== '[0,255,65]') throw new Error(`Workspace bytes on disk: ${onDisk}`);
    finished = true;
    return { ok: true, stage, namespace, conversationId: id, platform,
      hermes: typeof globalThis.HermesInternal === 'object', providerCalls, output, onDisk,
      network: 'Scripted provider transport; no model HTTP request' };
  } finally {
    await service.close();
    // Seeded fixtures stay for the verify stage; every other outcome removes them.
    if (stage !== 'seed' || !finished) {
      if (root.exists) root.delete();
      await deleteDatabaseAsync(databaseName).catch(() => {});
    }
  }
}
