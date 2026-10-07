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
  // The production native factory is a lazy Metro chunk. Reuse its installed
  // connection/driver boundary so the probe can name an isolated validation DB.
  const { openDatabaseAsync } = requireModule('expo-sqlite/build/index.js');
  const { createExpoSqliteDatabase } = requireModule('src/pi/storage/expo-sqlite.ts');
  const openWorkspaceDatabase = async (name) => createExpoSqliteDatabase(
    await openDatabaseAsync(name, { useNewConnection: true }));
  const models = ai.createModels({ credentials: new ai.InMemoryCredentialStore(),
    authContext: { env: async () => undefined, fileExists: async () => false } });
  const command = stage === 'seed' ? [
    'set -e',
    'mkdir -p one/sub two',
    "printf 'héllo 世界\\n' > one/value",
    'printf AP9B | base64 -d > binary',
    'ln binary alias',
    'ln -s /workspace/one/value absolute',
    'ln -s ../one/sub two/link',
    'chmod 640 binary',
    'gzip -c binary > bytes.gz',
    'printf session > /tmp/ephemeral',
    'sha256sum binary',
    'echo SEEDED',
  ].join('\n') : [
    'set -e',
    'if test -e /tmp/ephemeral; then echo TEMP_LEAK; exit 91; fi',
    'cat absolute two/link/../value',
    'readlink absolute',
    'od -An -tu1 binary',
    'gzip -dc bytes.gz | base64',
    'sha256sum alias',
    'printf Z >> alias',
    'test "$(base64 binary)" = AP9BWg==',
    'printf AP9B | base64 -d > alias',
    'stat -c %a binary',
    'test -f /bin/cat',
    'test -f /proc/self/status',
    'rm -f dangling dangling-copy dangling-moved',
    'ln -s missing-for-link-test dangling',
    'cp dangling dangling-copy',
    'mv dangling-copy dangling-moved',
    'test "$(readlink dangling-moved)" = missing-for-link-test',
    'rm dangling dangling-moved',
    "printf '{\"value\":42}' | jq -r .value",
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
    storage: await openExpoSqliteStorage(`${namespace}-chats.db`),
    openWorkspaceDatabase: () => openWorkspaceDatabase(`${namespace}-files.db`) });
  try {
    const id = stage === 'seed' ? await service.createChat() : service.getSnapshot().chats[0]?.id;
    if (!id) throw new Error('The seed conversation did not survive restart.');
    const receipt = await service.waitForSubmission(await service.send(id, `Run ${stage} validation.`));
    const rows = (await readChat(service, id)).messages.filter((row) => row.tool?.name === 'bash');
    const output = rows[rows.length - 1]?.tool.output ?? '';
    const expected = stage === 'seed' ? ['SEEDED']
      : ['héllo 世界', '/workspace/one/value', 'AP9B', '640', '42', 'VERIFIED'];
    if (receipt.status !== 'done' || !offered || !output.includes('Exit code: 0')
      || expected.some((value) => !output.includes(value))) {
      throw new Error(`Shell validation failed: ${JSON.stringify({ receipt, offered, output })}`);
    }
    return { ok: true, stage, namespace, conversationId: id, platform,
      hermes: typeof globalThis.HermesInternal === 'object', providerCalls, output,
      network: 'Scripted provider transport; no model HTTP request' };
  } finally { await service.close(); }
}
