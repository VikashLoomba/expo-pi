import { Platform } from 'react-native';
import { BACKGROUND_CONTEXT as context, withAbortSignal } from '@earendil-works/chord/context';
import * as ai from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { AgentDoc, defineExtension, defineTask } from '@earendil-works/pi-durable';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import { createEnvConformance } from '@earendil-works/pi-durable/testing';
import { DurableChatService } from '../../src/pi/chat-service';
import { openExpoSqliteStorage } from '../../src/pi/storage';
import { openWorkspaceDatabase } from '../../src/pi/workspace/database';
import { createLocalExecution } from '../../src/pi/execution/composition';
import { createRemoteExecution } from '../../src/pi/execution/remote/composition';
import { RemoteHostRepository } from '../../src/pi/execution/remote/hosts';
import { ExecutionTargetDoc } from '../../src/pi/execution/document';
import { remoteConformanceAssertions as assertions } from './remote-conformance-assertions';

/** Real native SSH, daemon, composition, service/harness and shared tools; only provider HTTP is scripted. */
export default async function probe({ platform, signal, config }) {
  const checks = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); checks.push(message); };
  check(Platform.OS === platform && typeof globalThis.HermesInternal === 'object', 'native Hermes runtime');
  const namespace = `pi-remote-${Date.now()}`;
  const memory = () => { const map = new Map(); return { getItemAsync: async (k) => map.get(k) ?? null,
    setItemAsync: async (k,v) => { map.set(k,v); }, deleteItemAsync: async (k) => { map.delete(k); } }; };
  const hosts = new RemoteHostRepository(memory(), memory(), () => ai.uuidv7());
  const { name, hostname, port, username } = config.host;
  let host = await hosts.save({ name, hostname, port, username }, { type: 'privateKey', privateKey: config.privateKey });
  host = await hosts.acceptHostKey(host.id, host.revision, config.trustedHostKey);
  check(!('defaultCwd' in host), 'machine metadata has no working directory');
  const fixtureCwd = config.host.defaultCwd;
  let workspaceOpens = 0;
  const openLocal = () => { workspaceOpens++; return openWorkspaceDatabase(`${namespace}-files.db`); };
  const composition = createRemoteExecution(createLocalExecution(openLocal), hosts);
  const resolve = (cwd) => composition.resolve({ conversationId: 1, cwd,
    read: { snapshot: async () => ({ kind: 'ssh', machineId: host.id }) } }, context);
  const base = await resolve(fixtureCwd);
  await base.connection.info();
  const root = `${fixtureCwd}/${namespace}`;
  getOrThrow(await base.createDir(root, { recursive: true }, context));
  let conformanceIndex = 0;
  let service;
  try {
    const cases = createEnvConformance({ assertions, shell: ['sh', '-c'], symlinks: true, withEnv: async (use) => {
      signal.throwIfAborted();
      const cwd = `${root}/case-${conformanceIndex++}`;
      getOrThrow(await base.createDir(cwd, { recursive: true }, context));
      const env = await resolve(cwd);
      try { await use(env); } finally { await env.cleanup(context); }
    } });
    for (const entry of cases) { await entry.run(); checks.push(`Pi conformance: ${entry.name}`); }
    const Direct = defineTask({ name: 'test.remote-direct', version: 1, initial: () => ({ phase: 'run' }), phases: {
      async run(_task, runtime, ctx) {
        const env = await runtime.env(ctx);
        let text;
        try {
          getOrThrow(await env.writeFile('direct.txt', 'DIRECT_TASK', ctx));
          text = getOrThrow(await env.readTextFile('direct.txt', ctx));
        } finally { await env.cleanup(context); }
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { text } } }), ctx);
      },
    }, async abort(_task, runtime, ctx) { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx); } });
    const models = ai.createModels({ credentials: new ai.InMemoryCredentialStore(), authContext: { env: async () => undefined, fileExists: async () => false } });
    const requests = [];
    const calls = [
      { name: 'write', arguments: { path: 'production.txt', content: 'alpha\n世界 😀\n' } },
      { name: 'edit', arguments: { path: 'production.txt', edits: [{ oldText: 'alpha', newText: 'edited' }] } },
      { name: 'read', arguments: { path: 'production.txt' } },
      { name: 'bash', arguments: { command: "printf 'SSH_SHELL\n' > shell.txt; cat production.txt; printf 'DISTINCT_STDERR\n' >&2" } },
    ];
    const dispatch = (model, request) => {
      requests.push(structuredClone(request));
      const first = requests.length === 1;
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: first ? calls.map((item,index) => ({ type: 'toolCall', id: `remote-${index}`, ...item })) : [{ type: 'text', text: 'Remote execution verified.' }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now() };
      const stream = ai.createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message }); return stream;
    };
    models.setProvider({ ...openaiCodexProvider(), auth: { apiKey: { name: 'Remote verification',
      check: async () => ({ type: 'api_key' }), resolve: async () => ({ auth: { apiKey: 'synthetic-no-network' } }) } }, stream: dispatch, streamSimple: dispatch });
    const openService = async () => DurableChatService.open({ storage: await openExpoSqliteStorage(`${namespace}-chats.db`), models, platform,
      openWorkspaceDatabase: openLocal, execution: (local) => { const execution = createRemoteExecution(local, hosts); return { ...execution,
        extensions: [defineExtension({ name: 'test.remote-tasks', tasks: [Direct] })] }; } });
    service = await openService();
    const id = await service.createChat();
    check(service.getConversation(id).execution.target.kind === 'local', 'local execution remains the default');
    await service.updateExecution(id, { target: { kind: 'ssh', machineId: host.id }, cwd: root });
    const receipt = await service.waitForSubmission(await service.send(id, 'Exercise remote shared tools.'));
    check(receipt.status === 'done', 'remote tool generation answered');
    const rows = service.getConversation(id).messages.filter((row) => row.tool);
    check(rows.length === 4 && rows.every((row) => row.tool.status === 'completed'), 'all four shared tools completed through production composition');
    check(JSON.stringify(requests[1]).includes('edited') && JSON.stringify(requests[1]).includes('DISTINCT_STDERR'), 'committed remote tool results reached the following model request');
    check(getOrThrow(await base.readTextFile(`${root}/production.txt`, context)) === 'edited\n世界 😀\n', 'real remote file bytes match shared write/edit');
    check(getOrThrow(await base.readTextFile(`${root}/shell.txt`, context)) === 'SSH_SHELL\n', 'real shell side effect exists');
    const conversation = await service.harness.conversation(Number(id), context);
    const taskId = await conversation.commit((tx) => tx.createTask(Direct, {}, { ownership: { kind: 'conversation' } }), context);
    const task = await service.harness.waitForTask(taskId, context);
    check(task.state.outcome.status === 'completed' && task.state.outcome.result.text === 'DIRECT_TASK', 'direct TaskRuntime.env uses remote selection and awaited cleanup');
    const at = await conversation.commit((tx) => tx.appendEntry(conversation.id, { kind: 'test.remote', data: {} }), context);
    const fork = await conversation.fork(at.id, { ownership: { kind: 'ownerless' } }, context);
    check((await service.harness.snapshot(ExecutionTargetDoc, fork.id, context)).machineId === host.id &&
      (await service.harness.snapshot(AgentDoc, fork.id, context)).cwd === root, 'remote fork inherits target and cwd');
    await service.close(); service = await openService();
    check(service.getConversation(id).execution.cwd === root && service.getConversation(id).execution.target.machineId === host.id, 'remote selection and cwd reopen from native SQLite');
    check(workspaceOpens === 0, 'remote harness and metadata never open local workspace database');
    const cancelled = await resolve(root);
    const controller = new AbortController();
    const result = await cancelled.exec("printf started; sleep 20; printf unexpected", { onOutput: () => controller.abort() }, withAbortSignal(controller.signal, context));
    check(!result.ok && result.error.code === 'aborted', 'remote execution cancellation settles');
    await cancelled.cleanup(context);
    const lost = await resolve(root);
    const oldReader = getOrThrow(await lost.openBinaryReader('production.txt', undefined, context));
    const pid = (await lost.connection.info()).pid;
    const uncertain = await lost.exec(`printf applied >> loss.txt; kill -9 ${pid}`, undefined, context);
    check(!uncertain.ok && uncertain.error.code === 'unknown', 'daemon loss after mutation reports uncertainty');
    check(getOrThrow(await lost.readTextFile('loss.txt', context)) === 'applied', 'subsequent operation reconnects without replaying mutation');
    const stale = await oldReader.read(0, 20, context);
    check(!stale.ok, 'old handles cannot address replacement session');
    await oldReader.close(context); await lost.cleanup(context);
    await hosts.remove(host.id);
    let removed = false;
    try { await resolve(root); } catch { removed = true; }
    check(removed, 'deleted selected host fails without local fallback');
    return { ok: true, hermes: true, platform, namespace, remoteDirectory: root, conformanceCases: cases.length,
      modelTransport: 'scripted; production service/harness, native SSH over Tailscale and real Pi daemon', checks };
  } finally {
    if (service) await service.close();
    // Keep only these small side-effect files for independent Mac-side inspection.
    await base.cleanup(context); await composition.close();
  }
}
