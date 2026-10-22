import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import {
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Context as ModelContext,
  type FauxResponseStep,
} from '@earendil-works/pi-ai';
import {
  AgentDoc,
  Harness,
  InboxDoc,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  createRegistry,
  defineExtension,
  defineTool,
  section,
  type Extension,
} from '@earendil-works/pi-durable';
import { memoryTools } from '../src/tools.mjs';
import {
  AGENT_TASK,
  AgentAnchor,
  AgentCallDoc,
  AgentDirectoryDoc,
  AgentReportDoc,
  PrivateAgentDoc,
  agentTask,
  agentTools,
  agentWork,
  takeAgentReports,
} from '../src/agents.mjs';
import { MemoryDoc, appendMessage } from '../src/memory.mjs';
import { BuildNode, ConfigDoc, pumpBuilds } from '../src/summary.mjs';
import { subagentPrompt } from '../src/prompt.mjs';

/** The agent task as the app sets it up: its conversation goes without the master and starts with the devices open. */
const AgentTask = agentTask({
  master: () => master,
  prompt: subagentPrompt('OptChat', true),
  turnState: async () => 'Devices open now:\n- mac',
});
/** The master's prompt and the agent tools as their own extension, which a subagent's conversation goes without. */
const master: Extension = defineExtension({
  name: 'optchat.master',
  sections: [section('optchat', () => 'MASTER PROMPT ONLY', { tag: false })],
  tools: agentTools(ROOT_CONVERSATION_ID, AgentTask),
});

/** Polls a committed read until it holds, as pi-durable's background-subagent example waits. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let tries = 0; tries < 2000; tries++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for a condition');
}

/** The text blocks of a request's last user message. */
function lastUserTexts(request: ModelContext): string[] {
  const last = request.messages.findLast((message) => message.role === 'user');
  if (!last || last.role !== 'user') return [];
  return typeof last.content === 'string'
    ? [last.content]
    : last.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
}
const isSubagent = (request: ModelContext) =>
  JSON.stringify(request.messages).includes('You are a subagent of OptChat');
const toolResults = (request: ModelContext) =>
  request.messages.flatMap((message) =>
    message.role === 'toolResult'
      ? message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
      : [],
  );

/** The root conversation with the agent tools and tasks, memory, `zoom`, and a `work` tool its agents can wait in. */
async function agentHarness(route: FauxResponseStep, work: () => Promise<void> = async () => {}) {
  const faux = fauxProvider({ models: [{ id: 'agent', contextWindow: 200_000 }] });
  faux.setResponses(Array.from({ length: 30 }, () => route));
  const models = createModels();
  models.setProvider(faux.provider);
  const storage = new MemoryStorage();
  const workTool = defineTool({
    name: 'work',
    description: 'Work for a while.',
    parameters: Type.Object({}),
    async execute() {
      await work();
      return { output: [{ type: 'text' as const, text: 'worked' }] };
    },
  });
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: 'optchat',
      tools: [...memoryTools(ROOT_CONVERSATION_ID), workTool],
      tasks: [AgentTask, AgentAnchor, BuildNode],
    }),
  );
  registry.install(master);
  const reports: unknown[] = [];
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      onReport: (error) => reports.push(error),
      // As openOptChat sets them.
      settings: {
        toolExecution: 'sequential', steeringMode: 'all', followUpMode: 'all', afterFailedRun: 'withdraw',
        restartLimit: Infinity,
      },
    },
    context,
  );
  const root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'agent' }, instructions: 'Same immutable system' },
    init: async (tx, id) => {
      await tx.doc(MemoryDoc, id);
      await tx.doc(AgentDirectoryDoc, id);
    },
  });
  const say = async (text: string) => {
    const settled = await (await root.submit({ type: 'input', content: text }, context)).wait(context);
    assert.equal(settled.status, 'done');
  };
  const names = async () => (await harness.snapshot(AgentDirectoryDoc, root.id, context))?.names ?? [];
  const agent = async (name: string) => {
    const found = await harness.snapshot(PrivateAgentDoc, root.id, name, context);
    if (!found?.conversationId) throw new Error(`No conversation for ${name}`);
    return { ...found, conversationId: found.conversationId };
  };
  /** The calls of agents ever started, one task each. */
  const calls = async () =>
    (await harness.commit((tx) => tx.scanTasks({ conversationId: root.id, kind: AGENT_TASK }, 100), context)).items;
  /** Every call of an agent ended: no call task left. */
  const settled = () =>
    until(
      () => harness.commit((tx) => agentWork(tx, root.id), context),
      (work) => work.length === 0,
    );
  const pendingReports = async () => {
    const keys = (await harness.snapshot(AgentDirectoryDoc, root.id, context))?.pendingReports ?? [];
    const found = [];
    for (const key of keys) found.push(await harness.snapshot(AgentReportDoc, root.id, key, context));
    return found;
  };
  return { faux, storage, harness, root, reports, say, names, agent, calls, settled, pendingReports };
}

test('spawn names agents, which start from the view, the devices and their log, and report in full', async () => {
  const requests: ModelContext[] = [];
  const fullText = 'report '.repeat(6000);
  const route: FauxResponseStep = (request) => {
    requests.push(structuredClone(request));
    const text = lastUserTexts(request).join('');
    if (isSubagent(request) && text.endsWith('user: Investigate the question.')) {
      return fauxAssistantMessage([
        { type: 'thinking', thinking: 'private reasoning', thinkingSignature: 'retained-signature' },
        fauxText(`  ${fullText}  `),
      ]);
    }
    if (isSubagent(request)) return fauxAssistantMessage('Many.');
    if (request.messages.at(-1)?.role === 'toolResult') return fauxAssistantMessage('MAIN DONE');
    return fauxAssistantMessage(
      [fauxToolCall('spawn', { tasks: ['Investigate the question.', 'Count the stars.'], effort: 'high' })],
      { stopReason: 'toolUse' },
    );
  };
  const f = await agentHarness(route);
  try {
    await f.say('Start two agents.');
    const names = await f.names();
    assert.equal(names.length, 2);
    assert.notEqual(names[0], names[1]);
    for (const name of names) assert.match(name, /^[A-Z][a-z]+[A-Z][a-z]+$/);
    const [investigator, counter] = names;
    // The call answers at once with the names, as UniiChat's spawn does; the main agent never waits for the work.
    const mainAfter = requests.find(
      (request) => !isSubagent(request) && request.messages.at(-1)?.role === 'toolResult',
    );
    assert.ok(mainAfter);
    assert.deepEqual(toolResults(mainAfter), [
      `Started ${investigator}, ${counter}. Each one's report will reach you as a message when it finishes.`,
    ]);
    await f.settled();
    const agent = await f.agent(investigator);
    assert.equal(agent.effort, 'high');
    // Configured as pi-durable's subagent example configures one, its folder its name and its effort the spawn's.
    const configured = await f.harness.snapshot(AgentDoc, agent.conversationId, context);
    assert.equal(configured?.cwd, investigator);
    assert.equal(configured?.thinkingLevel, 'high');
    assert.ok(configured?.instructions?.startsWith('You are a subagent of OptChat'));
    assert.ok(configured?.instructions?.endsWith('\n\nSame immutable system'));
    // An anchor task that ended at once owns the conversation, so it outlives the message that started it.
    const record = await f.storage.conversation(agent.conversationId, context);
    const owner = record?.owner?.taskId;
    assert.ok(owner !== undefined);
    assert.equal((await f.harness.getTask(owner, context))?.kind, 'optchat.agent-anchor');
    const subagentRequest = requests.find(
      (request) => isSubagent(request) && lastUserTexts(request).join('').endsWith('user: Investigate the question.'),
    );
    assert.ok(subagentRequest);
    const serialized = JSON.stringify(subagentRequest);
    assert.ok(!serialized.includes('MASTER PROMPT ONLY'));
    assert.ok(!serialized.includes('"name":"spawn"'));
    assert.ok(JSON.stringify(requests[0]).includes('"name":"spawn"'));
    // The view, the devices open now, then its log, numbered, ending with its task.
    assert.deepEqual(lastUserTexts(subagentRequest), [
      '<chat>\n</chat>',
      '\nDevices open now:\n- mac\n\n',
      '0|note: subagent at effort high\n\n1|user: Investigate the question.',
    ]);
    const native = await (await f.harness.conversation(agent.conversationId, context))?.context(context);
    assert.ok(JSON.stringify(native).includes('retained-signature'));
    // Each report is the whole reply, trimmed, under the agent's name and the zoom that opens its chat.
    const reports = await f.pendingReports();
    assert.equal(reports.length, 2);
    const full = reports.find((report) => report?.text.startsWith(`[${investigator}]`));
    assert.equal(full?.text, `[${investigator}]\n${fullText.trim()}\n\nFull chat: zoom("${investigator}")`);
    assert.equal(full?.stopped, false);
    assert.ok(!full?.text.includes('private reasoning'));
    assert.ok(reports.some((report) => report?.text === `[${counter}]\nMany.\n\nFull chat: zoom("${counter}")`));
    const taken = await f.harness.commit((tx) => takeAgentReports(tx, f.root.id), context);
    assert.equal(taken.length, 2);
    assert.deepEqual(await f.harness.commit((tx) => takeAgentReports(tx, f.root.id), context), []);
    assert.deepEqual(f.reports, []);
  } finally {
    await f.harness.close(context);
  }
});

test('tell steers an agent at work through its call, whose one report answers both messages', async () => {
  let started = () => {};
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release = () => {};
  const go = new Promise<void>((resolve) => {
    release = resolve;
  });
  let name = '';
  const requests: ModelContext[] = [];
  const route: FauxResponseStep = (request) => {
    requests.push(structuredClone(request));
    const text = lastUserTexts(request).join('');
    if (isSubagent(request)) {
      if (request.messages.at(-1)?.role === 'user' && text.endsWith('user: Long job')) {
        return fauxAssistantMessage([fauxToolCall('work', {})], { stopReason: 'toolUse' });
      }
      return fauxAssistantMessage('FINAL ANSWER');
    }
    if (request.messages.at(-1)?.role === 'toolResult') return fauxAssistantMessage('ok');
    if (text === 'Steer it.')
      return fauxAssistantMessage([fauxToolCall('tell', { name, message: 'STEER: check B too' })], {
        stopReason: 'toolUse',
      });
    if (text === 'Zoom it.') {
      return fauxAssistantMessage([fauxToolCall('zoom', { id: name }), fauxToolCall('zoom', { id: 'Nobody' })], {
        stopReason: 'toolUse',
      });
    }
    return fauxAssistantMessage([fauxToolCall('spawn', { tasks: ['Long job'] })], { stopReason: 'toolUse' });
  };
  const f = await agentHarness(route, async () => {
    started();
    await go;
  });
  try {
    await f.say('Start a long job.');
    await began;
    [name] = await f.names();
    const agent = await f.agent(name);
    await f.say('Steer it.');
    const tellResult = requests.findLast(
      (request) => !isSubagent(request) && request.messages.at(-1)?.role === 'toolResult',
    );
    assert.ok(tellResult);
    assert.deepEqual(
      toolResults(tellResult).at(-1),
      `Sent. ${name} reads it between its tool calls, and its report answers it.`,
    );
    // The call steers the message in: it waits in the agent's queue until the round's tool call finishes.
    await until(
      () => f.harness.snapshot(InboxDoc, agent.conversationId, context),
      (inbox) => (inbox?.items.length ?? 0) > 0,
    );
    release();
    await f.settled();
    const last = requests.findLast((request) => isSubagent(request));
    assert.ok(last);
    const roles = last.messages.map((message) => message.role).filter((role) => role !== 'system');
    assert.deepEqual(roles, ['user', 'assistant', 'toolResult', 'user']);
    assert.deepEqual(lastUserTexts(last), ['STEER: check B too']);
    // One call, as UniiChat's agent runs one: both messages end in its one answer, reported once.
    const reports = await f.pendingReports();
    assert.deepEqual(
      reports.map((report) => report?.text),
      [`[${name}]\nFINAL ANSWER\n\nFull chat: zoom("${name}")`],
    );
    assert.equal((await f.calls()).length, 1);
    const after = await f.agent(name);
    assert.equal(after.calling, null);
    assert.deepEqual(after.waiting, []);
    // zoom("Name") renders the agent's log, its lines "i|kind: text", and an unknown agent is an answer.
    await f.say('Zoom it.');
    const zoomed = requests.findLast(
      (request) => !isSubagent(request) && request.messages.at(-1)?.role === 'toolResult',
    );
    assert.ok(zoomed);
    assert.deepEqual(toolResults(zoomed).slice(-2), [
      `Page 1/1\n${[
        'note: subagent',
        'user: Long job',
        'tool: work {}',
        'echo: worked',
        'user: STEER: check B too',
        'unii: FINAL ANSWER',
      ]
        .map((line, i) => `${i}|${line}`)
        .join('\n\n')}`,
      'No agent Nobody.',
    ]);
    assert.deepEqual(f.reports, []);
  } finally {
    release();
    await f.harness.close(context);
  }
});

test('tell sends an idle agent its log anew, in a context started over with the view and the devices', async () => {
  let name = '';
  const requests: ModelContext[] = [];
  const route: FauxResponseStep = (request) => {
    requests.push(structuredClone(request));
    const text = lastUserTexts(request).join('');
    if (isSubagent(request))
      return fauxAssistantMessage(text.endsWith('user: Second task') ? 'SECOND REPORT' : 'FIRST REPORT');
    if (request.messages.at(-1)?.role === 'toolResult') return fauxAssistantMessage('ok');
    if (text === 'Tell it more.')
      return fauxAssistantMessage([fauxToolCall('tell', { name, message: 'Second task' })], { stopReason: 'toolUse' });
    if (text === 'Tell a stranger.')
      return fauxAssistantMessage([fauxToolCall('tell', { name: 'Nobody', message: 'hi' })], { stopReason: 'toolUse' });
    return fauxAssistantMessage([fauxToolCall('spawn', { tasks: ['First task'] })], { stopReason: 'toolUse' });
  };
  const f = await agentHarness(route);
  try {
    await f.say('Start an agent.');
    [name] = await f.names();
    await f.settled();
    await f.say('Tell it more.');
    const told = requests.findLast((request) => !isSubagent(request) && request.messages.at(-1)?.role === 'toolResult');
    assert.ok(told);
    assert.equal(toolResults(told).at(-1), `Sent. ${name}'s reply will reach you as a message.`);
    await f.settled();
    const second = requests.findLast((request) => isSubagent(request));
    assert.ok(second);
    // A reset: its first answer is not in the context, only in the log it is sent.
    assert.equal(second.messages.filter((message) => message.role === 'assistant').length, 0);
    assert.deepEqual(lastUserTexts(second), [
      '<chat>\n</chat>',
      '\nDevices open now:\n- mac\n\n',
      '0|note: subagent\n\n1|user: First task\n\n2|unii: FIRST REPORT\n\n3|user: Second task',
    ]);
    const reports = await f.pendingReports();
    assert.deepEqual(
      reports.map((report) => report?.text),
      [
        `[${name}]\nFIRST REPORT\n\nFull chat: zoom("${name}")`,
        `[${name}]\nSECOND REPORT\n\nFull chat: zoom("${name}")`,
      ],
    );
    await f.say('Tell a stranger.');
    const stranger = requests.findLast(
      (request) => !isSubagent(request) && request.messages.at(-1)?.role === 'toolResult',
    );
    assert.ok(stranger);
    assert.equal(toolResults(stranger).at(-1), 'No agent Nobody to tell.');
    assert.deepEqual(f.reports, []);
  } finally {
    await f.harness.close(context);
  }
});

test('a call that ended without clearing its place leaves the agent idle: a tell calls it, with what it was told', async () => {
  let name = '';
  const requests: ModelContext[] = [];
  const route: FauxResponseStep = (request) => {
    requests.push(structuredClone(request));
    const text = lastUserTexts(request).join('');
    if (isSubagent(request)) return fauxAssistantMessage(text.endsWith('user: Second task') ? 'SECOND' : 'FIRST');
    if (request.messages.at(-1)?.role === 'toolResult') return fauxAssistantMessage('ok');
    if (text === 'Tell it more.')
      return fauxAssistantMessage([fauxToolCall('tell', { name, message: 'Second task' })], { stopReason: 'toolUse' });
    return fauxAssistantMessage([fauxToolCall('spawn', { tasks: ['First task'] })], { stopReason: 'toolUse' });
  };
  const f = await agentHarness(route);
  try {
    await f.say('Start an agent.');
    [name] = await f.names();
    await f.settled();
    // As a call that faulted leaves it: its place still held, and a message told to it never delivered.
    const [first] = await f.calls();
    await f.harness.commit(async (tx) => {
      const agent = await tx.doc(PrivateAgentDoc, f.root.id, name, null);
      agent.calling = first.id;
      agent.waiting = ['Lost before'];
    }, context);
    await f.say('Tell it more.');
    const told = requests.findLast((request) => !isSubagent(request) && request.messages.at(-1)?.role === 'toolResult');
    assert.ok(told);
    assert.equal(toolResults(told).at(-1), `Sent. ${name}'s reply will reach you as a message.`);
    await f.settled();
    const second = requests.findLast((request) => isSubagent(request));
    assert.ok(second);
    assert.equal(
      lastUserTexts(second).at(-1),
      '0|note: subagent\n\n1|user: First task\n\n2|unii: FIRST\n\n3|user: Lost before\n\n4|user: Second task',
    );
    const after = await f.agent(name);
    assert.equal(after.calling, null);
    assert.deepEqual(after.waiting, []);
    assert.deepEqual(f.reports, []);
  } finally {
    await f.harness.close(context);
  }
});

test('a message told before the call reaches the agent joins its log, in the one call and its one report', async () => {
  const subagentCalls: ModelContext[] = [];
  let names: () => Promise<string[]> = async () => [];
  const route: FauxResponseStep = async (request) => {
    if (isSubagent(request)) {
      subagentCalls.push(structuredClone(request));
      return fauxAssistantMessage('BOTH DONE');
    }
    const results = request.messages.filter((message) => message.role === 'toolResult').length;
    if (results === 0) {
      return fauxAssistantMessage([fauxToolCall('spawn', { tasks: ['first'] })], { stopReason: 'toolUse' });
    }
    if (results === 1) {
      const [name] = await names();
      return fauxAssistantMessage([fauxToolCall('tell', { name, message: 'second' })], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  };
  const f = await agentHarness(route);
  names = f.names;
  try {
    // A message not summarized yet holds the call before it reaches the agent.
    await f.harness.commit(
      (tx) =>
        appendMessage(tx, f.root.id, { kind: 'user', text: 'earlier', date: '2026-10-15', source: 'one', images: [] }),
      context,
    );
    await f.say('Start an agent and tell it more.');
    const [name] = await f.names();
    const main = await f.root.context(context);
    const answers = main.messages.flatMap((message) =>
      message.role === 'toolResult'
        ? message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : [],
    );
    assert.equal(answers.at(-1), `Sent. ${name} reads it between its tool calls, and its report answers it.`);
    assert.deepEqual((await f.harness.snapshot(PrivateAgentDoc, f.root.id, name, context))?.waiting, ['second']);
    await f.harness.commit(async (tx) => {
      const model = { provider: 'faux', modelId: 'agent' };
      (await tx.doc(ConfigDoc, f.root.id)).summary = { model, thinkingLevel: 'off' };
      await pumpBuilds(tx, f.root.id);
    }, context);
    await f.settled();
    // What it was told before the call began ends its log, in the call's one message to a new conversation.
    assert.equal(subagentCalls.length, 1);
    assert.equal(lastUserTexts(subagentCalls[0]).at(-1), '0|note: subagent\n\n1|user: first\n\n2|user: second');
    const agent = await f.agent(name);
    const entries = await f.harness.commit(
      (tx) => tx.scanEntries({ conversationId: agent.conversationId, order: 'ascending' }, 100),
      context,
    );
    assert.ok(!entries.items.some((entry) => entry.kind === 'pi.reset'));
    assert.equal((await f.calls()).length, 1);
    assert.deepEqual(
      (await f.pendingReports()).map((report) => report?.text),
      [`[${name}]\nBOTH DONE\n\nFull chat: zoom("${name}")`],
    );
    assert.deepEqual(f.reports, []);
  } finally {
    await f.harness.close(context);
  }
});

test('a call whose run fails reports the failure, and what it was told meanwhile is withdrawn', async () => {
  let started = () => {};
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release = () => {};
  const go = new Promise<void>((resolve) => {
    release = resolve;
  });
  let name = '';
  const subagentCalls: ModelContext[] = [];
  const route: FauxResponseStep = async (request) => {
    const text = lastUserTexts(request).join('');
    if (isSubagent(request)) {
      subagentCalls.push(structuredClone(request));
      started();
      await go;
      return fauxAssistantMessage('PARTIAL', { stopReason: 'error', errorMessage: '400 bad request' });
    }
    if (request.messages.at(-1)?.role === 'toolResult') return fauxAssistantMessage('ok');
    if (text === 'Tell it.') {
      return fauxAssistantMessage([fauxToolCall('tell', { name, message: 'MORE' })], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage([fauxToolCall('spawn', { tasks: ['Fragile job'] })], { stopReason: 'toolUse' });
  };
  const f = await agentHarness(route);
  try {
    await f.say('Start a fragile job.');
    await began;
    [name] = await f.names();
    const agent = await f.agent(name);
    await f.say('Tell it.');
    // Steered in while the reply is under way, it waits in the queue for a boundary the failed run never reaches.
    await until(
      () => f.harness.snapshot(InboxDoc, agent.conversationId, context),
      (inbox) => (inbox?.items.length ?? 0) > 0,
    );
    release();
    await f.settled();
    assert.deepEqual(
      (await f.pendingReports()).map((report) => report?.text),
      [`[${name}]\nfailed: 400 bad request\n\nFull chat: zoom("${name}")`],
    );
    assert.equal(subagentCalls.length, 1);
    assert.deepEqual((await f.harness.snapshot(InboxDoc, agent.conversationId, context))?.items, []);
    const [call] = await f.calls();
    assert.ok(call);
    const steer = await f.harness.commit(
      (tx) => tx.submissionByRequest(agent.conversationId, `optchat:agent:${call.id}:1`),
      context,
    );
    // pi-durable withdrew it with the failed run (`afterFailedRun: 'withdraw'`).
    assert.equal(steer?.status === 'unanswered' ? steer.reason : steer?.status, 'run_failed');
    const after = await f.agent(name);
    assert.equal(after.calling, null);
    assert.deepEqual(after.waiting, []);
    assert.deepEqual(f.reports, []);
  } finally {
    release();
    await f.harness.close(context);
  }
});

test('a message to an agent waits for the summaries of the messages before it, never later ones', async () => {
  const subagentCalls: ModelContext[] = [];
  const route: FauxResponseStep = (request) => {
    if (isSubagent(request)) {
      subagentCalls.push(structuredClone(request));
      return fauxAssistantMessage('done');
    }
    if (request.messages.at(-1)?.role === 'toolResult') return fauxAssistantMessage('ok');
    return fauxAssistantMessage([fauxToolCall('spawn', { tasks: ['work'] })], { stopReason: 'toolUse' });
  };
  const f = await agentHarness(route);
  try {
    await f.harness.commit(
      (tx) =>
        appendMessage(tx, f.root.id, {
          kind: 'user',
          text: 'earlier content',
          date: '2026-10-15',
          source: 'one',
          images: [],
        }),
      context,
    );
    await f.say('Start an agent.');
    await f.harness.commit(
      (tx) =>
        appendMessage(tx, f.root.id, {
          kind: 'user',
          text: 'future content',
          date: '2026-10-15',
          source: 'two',
          images: [],
        }),
      context,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(subagentCalls.length, 0);
    // A summary model selected: the short sources build without a call and the message goes on.
    await f.harness.commit(async (tx) => {
      (await tx.doc(ConfigDoc, f.root.id)).summary = {
        model: { provider: 'faux', modelId: 'agent' },
        thinkingLevel: 'off',
      };
      await pumpBuilds(tx, f.root.id);
    }, context);
    await f.settled();
    assert.equal(subagentCalls.length, 1);
    const sent = JSON.stringify(subagentCalls);
    assert.ok(sent.includes('0+1|user: earlier content'));
    assert.ok(!sent.includes('future content'));
  } finally {
    await f.harness.close(context);
  }
});

test('earlier agent tasks and documents migrate as pi-durable reads them', () => {
  const migrate = AgentTask.definition.migrate;
  const input = { name: 'Old', task: 'Investigate.', cutoff: 3 };
  // Version 2 was an agent's one task: a saved `create` prepares the message, a saved `run` delivers what it froze.
  assert.deepEqual(migrate?.(input, { phase: 'create' }, 2), {
    input: { name: 'Old', message: 'Investigate.', cutoff: 3 },
    checkpoint: { phase: 'prepare' },
  });
  const run = { phase: 'run', conversationId: 7, requestId: 'optchat:agent:4:initial', frozenView: '<chat>\n</chat>' };
  assert.deepEqual(migrate?.(input, { ...run, turnState: 'Devices open now:\n- mac' }, 2)?.checkpoint, {
    phase: 'deliver',
    conversationId: 7,
    requestId: 'optchat:agent:4:initial',
    content: ['<chat>\n</chat>', '\nDevices open now:\n- mac\n\n', 'Investigate.'],
    words: ['Investigate.'],
    steers: [],
  });
  // Version 1 gave its first message no device list.
  assert.deepEqual(migrate?.(input, run, 1)?.checkpoint, {
    phase: 'deliver',
    conversationId: 7,
    requestId: 'optchat:agent:4:initial',
    content: ['<chat>\n</chat>', 'Investigate.'],
    words: ['Investigate.'],
    steers: [],
  });
  assert.deepEqual(PrivateAgentDoc.definition.migrate?.({ taskId: 4, conversationId: 7, status: 'completed' }, 1), {
    conversationId: 7,
    effort: null,
    calling: null,
    waiting: [],
  });
  // One still under way goes on as the agent's call, so a message told to it joins that call.
  assert.deepEqual(PrivateAgentDoc.definition.migrate?.({ taskId: 4, conversationId: 7, status: 'running' }, 1), {
    conversationId: 7,
    effort: null,
    calling: 4,
    waiting: [],
  });
  assert.deepEqual(AgentReportDoc.definition.migrate?.({ text: '[Old] done', requestId: 'r', consumed: true }, 1), {
    text: '[Old] done',
    requestId: 'r',
    consumed: true,
    stopped: false,
  });
  assert.deepEqual(AgentCallDoc.definition.migrate?.({ taskId: 4, name: 'Old' }, 1), {
    result: 'Started Old. Its report will arrive automatically.',
  });
  assert.deepEqual(AgentCallDoc.definition.migrate?.({ taskId: null, name: '' }, 1), { result: null });
});
