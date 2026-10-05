// Runs inside Metro's actual Hermes/browser runtime. Only model transport is scripted.
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
  const { openaiCodexProvider } = requireModule('@earendil-works/pi-ai/dist/providers/openai-codex.js');
  const { DurableChatService } = requireModule('src/pi/chat-service.ts');
  const { openExpoSqliteStorage } = requireModule('src/pi/storage/index.ts');
  const { openWorkspaceDatabase } = requireModule('src/pi/workspace/database.ts');
  const { WorkspaceRuntime } = requireModule('src/pi/workspace/runtime.ts');
  const { WorkspaceExecutionEnv } = requireModule('src/pi/workspace/execution-env.ts');
  const { BACKGROUND_CONTEXT: context } = requireModule('@earendil-works/chord/dist/context/index.js');
  const fileName = `${namespace}-files.db`;
  const report = { stage, namespace, platform, hermes: typeof globalThis.HermesInternal === 'object',
    network: 'Scripted provider transport; no provider HTTP or credentials', checks: [] };
  const record = (label, condition) => { check(condition, label); report.checks.push(label); };

  if (stage === 'performance') {
    const { createWorkspaceFileTools } = requireModule('src/pi/workspace/file-tools.ts');
    const { EDIT_BUDGET } = requireModule('src/pi/workspace/edit-budget.ts');
    const runtime = new WorkspaceRuntime(() => openWorkspaceDatabase(fileName));
    const edit = createWorkspaceFileTools(runtime).find((tool) => tool.name === 'edit');
    const workspace = { id: 'performance', origin: 'new', capabilityRevision: 1 };
    const api = { conversationId: 1, commit: (action) => action({ doc: async () => workspace }) };
    const cases = [];
    async function measure(name, content, edits, rejected = false) {
      await runtime.run(workspace.id, undefined, ({ mounted }) => mounted.writeFile('/workspace/performance', content));
      let last = performance.now(), delay = 0;
      const timer = setInterval(() => { const now = performance.now(); delay = Math.max(delay, now - last); last = now; }, 8);
      const start = performance.now();
      let error, result;
      try { result = await edit.execute({ path: 'performance', edits }, api, context); } catch (caught) { error = String(caught); }
      const durationMs = performance.now() - start;
      await new Promise((resolve) => setTimeout(resolve, 25));
      clearInterval(timer);
      check(!!error === rejected, `${name}: unexpected admission ${error || 'accepted'}`);
      if (rejected) await runtime.run(workspace.id, undefined, async ({ mounted }) => {
        check(await mounted.readFile('/workspace/performance') === content, `${name}: rejection changed bytes`);
      });
      else await runtime.run(workspace.id, undefined, async ({ mounted }) => {
        const expected = edits.reduce((text, edit) => text.replace(edit.oldText, edit.newText), content);
        check(await mounted.readFile('/workspace/performance') === expected, `${name}: accepted edit changed unexpected bytes`);
        if (result?.details?.patchPath) {
          const patch = await mounted.readFileBuffer(result.details.patchPath);
          check(patch.length === result.details.patchBytes, `${name}: saved full patch bytes differ`);
        }
      });
      cases.push({ name, sourceBytes: new TextEncoder().encode(content).length, edits: edits.length, rejected,
        inputBytes: edits.reduce((total, edit) => total + new TextEncoder().encode(edit.oldText + edit.newText).length, 0),
        durationMs: Math.round(durationMs), longestTimerGapMs: Math.round(delay), ...(error ? { error } : {}),
        ...(result?.details ? { detailsJsonBytes: new TextEncoder().encode(JSON.stringify(result.details)).length,
          diffTruncated: result.details.diffTruncated, patchBytes: result.details.patchBytes, patchSaved: !!result.details.patchPath } : {}) });
    }
    try {
      const lines = Array.from({ length: 65536 }, (_, index) => `${String(index).padStart(6, '0')}:${'x'.repeat(120)}\n`);
      const large = lines.join('');
      const targeted = (index) => ({ oldText: lines[index] + lines[index + 1], newText: lines[index].replace('x', 'Y') + lines[index + 1] });
      await measure('8MiB targeted edit', large, [targeted(32768)]);
      await measure('8MiB ASCII with one nonASCII character', large.slice(0, -2) + '\u00e9', [targeted(32768)]);
      const cjkLines = Array.from({ length: 65536 }, (_, index) => `@${String(index).padStart(6, '0')}${'\u6c49'.repeat(40)}\n`);
      await measure('8MiB UTF8 CJK targeted edit', cjkLines.join(''), [{ oldText: cjkLines[32768] + cjkLines[32769],
        newText: cjkLines[32768].replace('\u6c49', '\u754c') + cjkLines[32769] }]);
      const cjkEdits = (count) => Array.from({ length: count }, (_, index) => 100 + index * 5000)
        .map((index) => ({ oldText: cjkLines[index] + cjkLines[index + 1],
          newText: cjkLines[index].replace('\u6c49', '\u754c') + cjkLines[index + 1] }));
      await measure('8MiB CJK four edits at matching work boundary', cjkLines.join(''), cjkEdits(4));
      await measure('8MiB CJK ten edits exceed matching work budget', cjkLines.join(''), cjkEdits(10), true);
      const positions = [100, 20000, 40000, 65000];
      const distinctive = lines.map((line, index) => positions.includes(index) ? '@' + line.slice(1) : line);
      const distinctiveEdit = (index) => ({ oldText: distinctive[index] + distinctive[index + 1], newText: distinctive[index].replace('x', 'Y') + distinctive[index + 1] });
      await measure('8MiB three distinctive targeted edits', distinctive.join(''), positions.slice(0, 3).map(distinctiveEdit));
      await measure('8MiB four targeted edits exceed diff budget', distinctive.join(''), positions.map(distinctiveEdit), true);
      const small = Array.from({ length: 1000 }, (_, index) => `line-${index}: ${'z'.repeat(60)}\n`);
      await measure('32 scattered edits', small.join(''), Array.from({ length: 32 }, (_, index) => ({ oldText: small[index * 30], newText: small[index * 30].replace('z', 'Y') })));
      for (const [sourceSize, patternSize] of [[8 * 1024, 512], [32 * 1024, 2 * 1024]]) {
        await measure(`${sourceSize / 1024}KiB repeated-prefix matching`, 'a'.repeat(sourceSize - 1) + 'b',
          [{ oldText: 'a'.repeat(patternSize - 1) + 'b', newText: 'b' }]);
      }
      await measure('64KiB repeated-prefix exceeds search budget', 'a'.repeat(64 * 1024 - 1) + 'b',
        [{ oldText: 'a'.repeat(4 * 1024 - 1) + 'b', newText: 'b' }], true);
      await measure('repeated short pattern', 'x'.repeat(8 * 1024 * 1024), [{ oldText: 'x', newText: 'y' }], true);
      await measure('huge minified line', 'a'.repeat(4 * 1024 * 1024) + 'UNIQUE' + 'b'.repeat(4 * 1024 * 1024 - 6), [{ oldText: 'a'.repeat(128) + 'UNIQUE', newText: 'CHANGED' }], true);
      const expansionCount = Math.floor(EDIT_BUDGET.maxNormalizationExpansionUnits / 17);
      const marker = 'Z'.repeat(256);
      const expansionEdit = [{ oldText: marker, newText: marker.slice(0, -1) + 'Y' }];
      await measure('Unicode expansion just under work budget', '\uFDFA'.repeat(expansionCount) + '\n' + marker, expansionEdit);
      await measure('Unicode expansion exceeds work budget', '\uFDFA'.repeat(expansionCount + 1) + '\n' + marker, expansionEdit, true);
      await measure('former pathological Unicode expansion is rejected', '\uFDFA'.repeat(Math.floor((EDIT_BUDGET.maxNormalizedUnits - 257) / 18)) + '\n' + marker, expansionEdit, true);
      const expansionBatchLines = Array.from({ length: EDIT_BUDGET.maxEdits }, (_, index) => `Z${String(index).padStart(3, '0')}-${'x'.repeat(123)}\n`);
      const expansionBatchEdits = expansionBatchLines.map((line) => ({ oldText: line, newText: line.replace('x', 'Y') }));
      const batchExpansionCount = Math.floor(EDIT_BUDGET.maxNormalizationExpansionUnits / (17 * EDIT_BUDGET.maxEdits));
      await measure('32 edits at weighted Unicode expansion boundary', '\uFDFA'.repeat(batchExpansionCount) + '\n' + expansionBatchLines.join(''), expansionBatchEdits);
      await measure('32 edits exceed weighted Unicode expansion budget', '\uFDFA'.repeat(batchExpansionCount + 1) + '\n' + expansionBatchLines.join(''), expansionBatchEdits, true);
      await measure('maximum input Unicode normalization with absent target', 'unchanged\n',
        [{ oldText: '\uFDFA'.repeat(Math.floor(EDIT_BUDGET.maxInputBytes / 3)), newText: '' }], true);
      const combining = '\u0315\u0300'.repeat(Math.floor(EDIT_BUDGET.maxCombiningRun / 2));
      await measure('combining run at admitted boundary', combining + '\n' + marker, expansionEdit);
      await measure('combining run exceeds budget', combining + '\u0315\n' + marker, expansionEdit, true);
      await measure('compatibility combining run exceeds budget', '\uFF9E'.repeat(EDIT_BUDGET.maxCombiningRun + 1) + '\n' + marker, expansionEdit, true);
      const combiningBlock = 'a' + combining + '\n';
      const combiningRuns = Math.floor(EDIT_BUDGET.maxCombiningWork / (combining.length ** 2));
      await measure('aggregate combining work at admitted boundary', combiningBlock.repeat(combiningRuns) + marker, expansionEdit);
      await measure('aggregate combining work exceeds budget', combiningBlock.repeat(combiningRuns + 1) + marker, expansionEdit, true);
      const blockBytes = new TextEncoder().encode(combiningBlock).length;
      const denseRuns = Math.floor((8 * 1024 * 1024 - marker.length) / blockBytes);
      const denseText = combiningBlock.repeat(denseRuns) + marker + 'b'.repeat(8 * 1024 * 1024 - denseRuns * blockBytes - marker.length);
      await measure('8MiB dense legal combining runs rejected', denseText, expansionEdit, true);
      await measure('near maximum diff materialization', 'x'.repeat(2 * 1024 * 1024 - 4096) + 'T'.repeat(128),
        [{ oldText: 'T'.repeat(128), newText: 'Y'.repeat(128) }]);
      const lineMarker = 'Z'.repeat(128) + '\n';
      await measure('maximum admitted line count', 'a\n'.repeat(EDIT_BUDGET.maxLines - 1) + lineMarker,
        [{ oldText: lineMarker, newText: lineMarker.replace('Z', 'Y') }]);
      await measure('line count exceeds budget', 'a\n'.repeat(EDIT_BUDGET.maxLines) + lineMarker,
        [{ oldText: lineMarker, newText: lineMarker.replace('Z', 'Y') }], true);
      report.performance = cases;
      report.policy = EDIT_BUDGET;
      report.ok = true;
      return report;
    } finally { await runtime.close(); }
  }

  const models = ai.createModels({ credentials: new ai.InMemoryCredentialStore(),
    authContext: { env: async () => undefined, fileExists: async () => false } });
  const call = (name, args) => ({ name, arguments: args });
  const calls = stage === 'seed' ? [
    call('write', { path: 'nested/原稿.txt', content: '\uFEFF\uFEFFalpha\r\n世界 😀\r\n' }),
    call('bash', { command: "ln 'nested/原稿.txt' alias; ln -s /workspace/alias linked; printf temporary > /tmp/session; printf AP9B | base64 -d > binary; echo SHELL_SEEDED" }),
    call('edit', { path: 'linked', edits: [{ oldText: 'alpha', newText: 'edited' }] }),
    call('read', { path: 'nested/原稿.txt', offset: 2, limit: 1 }),
    call('edit', { path: 'alias', edits: [{ oldText: 'edited', newText: 'incorrect' }, { oldText: 'absent', newText: 'invalid' }] }),
    call('read', { path: 'alias' }),
    call('edit', { path: 'binary', edits: [{ oldText: 'A', newText: 'B' }] }),
    call('bash', { command: 'test ! -e /tmp/session && echo FRESH_TMP; base64 binary; base64 alias' }),
  ] : [
    call('read', { path: 'linked' }),
    call('bash', { command: 'test ! -e /tmp/session && echo FRESH_TMP; base64 binary; base64 alias' }),
    call('write', { path: 'alias', content: 'reopened 世界 😀\n' }),
    call('read', { path: 'nested/原稿.txt' }),
  ];
  let providerCalls = 0;
  let offered = [];
  const dispatch = (model, request) => {
    offered = ai.getCurrentTools(request.messages).map((tool) => tool.name);
    const first = ++providerCalls === 1;
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: first ? calls.map((item, index) => ({ type: 'toolCall', id: `${stage}-${index}`, ...item })) : [{ type: 'text', text: 'Workspace validation finished.' }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now() };
    const stream = ai.createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: message.stopReason, message });
    return stream;
  };
  models.setProvider({ ...openaiCodexProvider(), auth: { apiKey: { name: 'Local verification',
    check: async () => ({ type: 'api_key' }), resolve: async () => ({ auth: { apiKey: 'synthetic-no-network' } }) } },
    stream: dispatch, streamSimple: dispatch });
  const storage = await openExpoSqliteStorage(`${namespace}-chats.db`);
  const service = await DurableChatService.open({ storage, models, platform, openWorkspaceDatabase: () => openWorkspaceDatabase(fileName) });
  try {
    const id = stage === 'seed' ? await service.createChat() : service.getSnapshot().chats[0]?.id;
    check(id, 'Seed conversation must survive process restart');
    const previous = service.getConversation(id).messages.filter((row) => row.tool);
    if (stage === 'verify') record('committed edit diff survives restart', previous.some((row) => row.tool.name === 'edit' && row.tool.file?.diff?.includes('edited')));
    const receipt = await service.waitForSubmission(await service.send(id, `Run ${stage} verification.`));
    const rows = service.getConversation(id).messages.filter((row) => row.tool).slice(previous.length);
    record('real durable submission completed', receipt.status === 'done');
    record('all four tools offered', ['read', 'write', 'edit', 'bash'].every((name) => offered.includes(name)));
    record('expected tool outcomes', rows.length === calls.length && rows.every((row, index) => row.tool.status === (stage === 'seed' && [4, 6].includes(index) ? 'error' : 'completed')));
    const output = rows.map((row) => row.tool.output).join('\n');
    record('Unicode shared across all tools', output.includes('世界 😀'));
    record('temporary state resets and binary bytes survive', output.includes('FRESH_TMP') && output.includes('AP9B'));
    if (stage === 'seed') {
      record('failed edit batch preserves original bytes', rows[5].tool.output.includes('edited') && !rows[5].tool.output.includes('incorrect'));
      record('typed edit details projected', rows[2].tool.file.diff.includes('edited'));
    } else record('hard link retains shared bytes after reopen', rows[3].tool.output === 'reopened 世界 😀\n');
    const doc = await storage.findDocument({ kind: 'app.bash.workspace', scope: { kind: 'conversation', conversationId: Number(id) } }, 'current', context);
    const workspace = (await storage.document(doc.id, 'current', context)).value;
    const runtime = new WorkspaceRuntime(() => openWorkspaceDatabase(fileName));
    try {
      await runtime.run(workspace.id, undefined, async (invocation) => {
        const env = new WorkspaceExecutionEnv(invocation);
        try {
          if (stage === 'seed') {
            const bytes = await invocation.mounted.readFileBuffer('/workspace/alias');
            const expected = new TextEncoder().encode('\uFEFF\uFEFFedited\r\n世界 😀\r\n');
            record('exact edited BOM CRLF and Unicode bytes', bytes.length === expected.length && bytes.every((byte, index) => byte === expected[index]));
          }
          const samples = ['', '\uFEFFx', '\uFEFF\uFEFFx', '😀\r\n世界', '\uFFFD'];
          for (const text of samples) {
            await invocation.mounted.writeFile('/workspace/encoding-check', new TextEncoder().encode(text));
            const result = await env.readTextFile('encoding-check', context);
            check(result.ok && result.value === text, 'Strict UTF8 valid sample');
          }
          for (const malformed of [[0x80], [0xc0,0xaf], [0xe0,0x80,0x80], [0xed,0xa0,0x80], [0xf0,0x80,0x80,0x80], [0xf4,0x90,0x80,0x80], [0xf5,0x80,0x80,0x80], [0xe2,0x82]]) {
            await invocation.mounted.writeFile('/workspace/encoding-check', Uint8Array.from(malformed));
            const result = await env.readTextFile('encoding-check', context);
            check(!result.ok && result.error.code === 'invalid', 'Strict UTF8 invalid sample');
          }
          record('actual runtime strict UTF8 decoder boundaries', true);
        } finally { await env.cleanup(context); }
      });
    } finally { await runtime.close(); }
    report.conversationId = id;
    report.providerCalls = providerCalls;
    report.results = rows.map((row) => ({ name: row.tool.name, status: row.tool.status, output: row.tool.output.slice(0, 500), file: row.tool.file }));
  } finally { await service.close(); }
  if (platform === 'web') {
    record('browser SQLite prerequisites', globalThis.crossOriginIsolated && !!navigator.locks && !!navigator.storage?.getDirectory);
    const a = await openWorkspaceDatabase(fileName);
    const b = await openWorkspaceDatabase(fileName);
    try {
      await a.exec('CREATE TABLE IF NOT EXISTS validation_pool (id INTEGER PRIMARY KEY, value TEXT)');
      await Promise.all([a.run('INSERT OR REPLACE INTO validation_pool VALUES (?, ?)', 1, 'first'), b.run('INSERT OR REPLACE INTO validation_pool VALUES (?, ?)', 2, 'second')]);
      await a.close();
      record('production web pooled lease remains usable', (await b.all('SELECT * FROM validation_pool')).length === 2);
    } finally { await a.close(); await b.close(); }
    const reopened = await openWorkspaceDatabase(fileName);
    try { record('production web lock released and data persists', (await reopened.all('SELECT * FROM validation_pool')).length === 2); }
    finally { await reopened.close(); }
  }
  report.ok = true;
  return report;
}
