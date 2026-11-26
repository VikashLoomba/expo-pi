import { obj, opt, str } from '@earendil-works/pi-schema';
import {
  ROOT_CONVERSATION_ID, configure, defineDoc, defineDocFamily, defineTask, defineTool,
  type ConversationId, type Extension, type TaskId, type Tx,
} from '@earendil-works/pi-durable';

/**
 * UniiChat's tree of agents (VictorTaelin/UniiChat ff32319, a commit its author pushed to `main` and withdrew the same
 * day; Server.ts `Unii.tell`, `spawn`, `hide` and `Tools.place`). Every agent is a conversation with a chat of its own
 * that never ends: its memory, its turns' coordinators and its summaries, as the root's are. The user talks to `root`; an
 * agent talks only to its parent and its children, by `tell`, and its final reply stays in its own chat.
 *
 * The owner's changes (2026-11-18): an agent works in a folder of its own on a device, as agents here always have,
 * where UniiChat gives each a git worktree; and a child starts on its parent's model, as pi-durable copies an owner's
 * agent, where UniiChat starts it on the server's default.
 */

/** Root's parent, as `tell` names it. */
export const USER = 'user';
export const ROOT = 'root';
/** Names no child takes: the user's, and `main`, root's folder on a device (`device-tools.ts`). */
const RESERVED = [USER, 'main'];
const NAME = /^[a-z0-9-]{1,16}$/;
const DESCRIPTION = 128;

/** Whether an agent's stored `cwd` names a project directory rather than a bare agent scratch folder name. */
export const isProjectDir = (cwd: string): boolean => cwd === '~' || cwd.startsWith('~/') || cwd.startsWith('/');

/** Validates and normalizes an optional `spawn` project directory (`~`, `~/…`, or `/…`, without `..`). */
function normalizeProjectDir(raw: string): { ok: true; value: string | undefined } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: undefined };
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return { ok: false, error: 'cwd cannot contain control characters' };
  if (!isProjectDir(trimmed)) return { ok: false, error: 'cwd must be an absolute path or start with ~/' };
  const cleaned = trimmed.replace(/\/+$/, '') || '/';
  const body = cleaned === '~' ? '' : cleaned.startsWith('~/') ? cleaned.slice(2) : cleaned.slice(1);
  if (body.split('/').includes('..')) return { ok: false, error: 'cwd cannot contain ".."' };
  return { ok: true, value: cleaned };
}

export type TreeAgent = {
  conversationId: ConversationId;
  /** `null` for root, whose parent is the user. */
  parent: string | null;
  description: string;
  /** Optional project directory (`~`, `~/…`, or `/…`); tools fall back to `<work>/<name>` where absent. */
  cwd?: string;
  /** Its children in spawn order. A hidden one leaves its place's list and the screens' tree; `tell` reaches it. */
  children: { name: string; hidden: boolean }[];
};
export type Tree = {
  /** Every agent by its name, which is unique in the whole tree. */
  agents: Record<string, TreeAgent>;
  /**
   * Set for a chat older than the tree, whose replies went to the user: the first message root's reply is kept for
   * itself from, and when that began. UniiChat's `since`.
   */
  since: { message: number; at: number } | null;
};
/** The tree, one document of the root conversation, so a spawn names its child and lists it in one commit. */
export const TreeDoc = defineDoc<Tree>({
  kind: 'optchat.tree',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  checkpointWhen: () => true,
  initial: () => ({
    agents: { [ROOT]: { conversationId: ROOT_CONVERSATION_ID, parent: null, description: '', children: [] } },
    since: null,
  }),
});

/** The name of the agent a conversation is; none for a conversation that is no agent of the tree. */
export const agentNamed = (agents: Tree['agents'], conversationId: ConversationId): string | undefined =>
  Object.keys(agents).find((name) => agents[name].conversationId === conversationId);

/**
 * An agent's place, which ends each turn's message: its name, its parent and its children, the awake ones marked.
 * It changes as a child is spawned, woken or hidden, so it follows the cached view.
 */
export function place(tree: Tree, name: string, awake: ReadonlySet<string>): string {
  const agent = tree.agents[name];
  const shown = agent.children.filter((child) => !child.hidden);
  const hidden = agent.children.length - shown.length;
  const lines = shown.map((child) => {
    const info = tree.agents[child.name];
    const dir = info.cwd ? ` [${info.cwd}]` : '';
    return `- ${child.name}: ${info.description}${dir}${awake.has(child.name) ? ' (awake)' : ''}`;
  });
  if (hidden > 0) lines.push(`(${hidden} hidden)`);
  const selfDir = agent.cwd ? ` (dir: ${agent.cwd})` : '';
  const up = agent.parent ?? `the user (tell "${USER}")`;
  const old = agent.parent === null && tree.since
    ? ` Your replies before message ${tree.since.message} went to the user, from a chat older than the tree.` : '';
  const list = lines.length ? `\n${lines.join('\n')}` : ' none.';
  return `You are ${name}${selfDir}. Your parent: ${up}.${old} Your children:${list}`;
}

/**
 * As pi-durable's background-subagent example: a background task that ends at once owns each child's conversation,
 * so the conversation outlives its parent's turns and a stop of the parent never reaches it.
 */
export const AgentAnchor = defineTask<null, { phase: 'done' }, null>({
  name: 'optchat.agent-anchor',
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_anchor, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context),
  },
  abort: (_anchor, runtime, context) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
});

/** A tool call's answer, kept so a native replay of the call answers alike without acting twice. */
export const AgentCallDoc = defineDocFamily<{ result: string | null }, null>({
  kind: 'optchat.agent-launch',
  version: 2,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  family: true,
  checkpointWhen: () => true,
  // Version 1 recorded the one agent an `agent` call launched.
  migrate: (value) => {
    const { taskId, name } = value as { taskId: TaskId | null; name: string };
    return { result: taskId === null ? null : `Started ${name}. Its report will arrive automatically.` };
  },
  initial: () => ({ result: null }),
});

/** What the tree's tools need of the chat each agent is (`app.ts`). */
export type AgentSetup = {
  /** The extension only root has, which a child's conversation goes without. */
  master: () => Extension;
  /** Gives a new conversation its chat: its memory and its application state. */
  init: (tx: Tx, conversationId: ConversationId) => Promise<void>;
  /** Admits a message to an agent's chat in the caller's commit: it wakes the agent, or reaches its running turn. */
  admit: (tx: Tx, conversationId: ConversationId, input: {
    requestId: string; kind: 'user' | 'work'; content: string; date: string;
  }) => Promise<void>;
};

const reply = (text: string) => ({ output: [{ type: 'text' as const, text }] });

/**
 * UniiChat's tree tools. `tell` and `spawn` are the model's own calls, never a script's: what an agent says, and whom
 * it starts, is a call of its transcript, which the screens show as its message.
 */
export function agentTools(setup: AgentSetup) {
  const tree = (tx: Tx) => tx.doc(TreeDoc, ROOT_CONVERSATION_ID);
  const spawn = defineTool({
    name: 'spawn',
    description: 'Start a child agent with its own lasting chat, memory tree, and default work folder: name '
      + '(1 to 16 of a-z, 0-9 and -; unique), description (at most 128 characters), task (your first message to it, '
      + 'including any project context it needs), and optional cwd (an existing project directory such as '
      + '"~/my-project" or "/path/to/repo"; falls back to <work>/<name> on devices where it does not exist).',
    replay: 'safe',
    callers: ['model'],
    parameters: obj({
      name: str(),
      description: str(),
      task: str(),
      cwd: opt(str({
        description: 'Optional existing project directory ("~/..." or absolute path) to start tools in on machines '
          + 'where it exists.',
      })),
    }, { open: true }),
    async execute({ name, description, task, cwd }, api, context) {
      return reply(await api.commit(async (tx) => {
        // A native tool task may replay after a lost result commit; its own ID makes it act once.
        const done = await tx.doc(AgentCallDoc, api.conversationId, String(api.taskId), null);
        if (done.result !== null) return done.result;
        const { agents } = await tree(tx);
        const parent = agentNamed(agents, api.conversationId);
        if (parent === undefined) return 'No spawn: this chat is no agent of the tree.';
        const parsedCwd = cwd === undefined ? { ok: true as const, value: undefined } : normalizeProjectDir(cwd);
        const why = !NAME.test(name) ? 'a name is 1 to 16 of a-z, 0-9 and -'
          : RESERVED.includes(name) || Object.hasOwn(agents, name) ? `${name} is taken`
            : description.length > DESCRIPTION ? `a description is at most ${DESCRIPTION} characters`
              : !parsedCwd.ok ? parsedCwd.error : null;
        if (why !== null) return `No spawn: ${why}.`;
        const projectDir = parsedCwd.ok ? parsedCwd.value : undefined;
        // One commit, so a spawn is whole or not at all. The anchor belongs to the parent's conversation and is
        // background: its child starts as a copy of the parent's agent, without what only root has.
        const anchor = await tx.createTask(AgentAnchor, null,
          { ownership: { kind: 'conversation' }, background: true });
        const child = await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } });
        await configure(tx, child.id, { cwd: projectDir ?? name, extensions: { remove: [setup.master()] } });
        await setup.init(tx, child.id);
        agents[name] = {
          conversationId: child.id,
          parent,
          description,
          ...(projectDir === undefined ? {} : { cwd: projectDir }),
          children: [],
        };
        agents[parent].children.push({ name, hidden: false });
        await setup.admit(tx, child.id, {
          requestId: `spawn:${api.taskId}`, kind: 'user', content: task, date: new Date(api.now()).toISOString(),
        });
        done.result = `Spawned ${name}${projectDir ? ` in ${projectDir}` : ''}. Its messages reach you as [${name}].`;
        return done.result;
      }, context));
    },
  });
  const tell = defineTool({
    name: 'tell',
    description: 'Send a message to your parent (root\'s is "user") or to one of your children, by name. It wakes '
      + 'them, or reaches their running turn between tool calls.',
    replay: 'safe',
    callers: ['model'],
    parameters: obj({ name: str(), message: str() }, { open: true }),
    async execute({ name, message }, api, context) {
      return reply(await api.commit(async (tx) => {
        const { agents } = await tree(tx);
        const self = agentNamed(agents, api.conversationId);
        if (self === undefined) return 'Not sent: this chat is no agent of the tree.';
        const { parent, children } = agents[self];
        const up = name === (parent ?? USER);
        const child = children.some((each) => each.name === name) ? agents[name] : undefined;
        if (!up && child === undefined) {
          const reachable = [parent ?? USER, ...children.map((each) => each.name)].join(', ');
          return `${name} is neither your parent nor your child: you tell ${reachable}.`;
        }
        // A replayed call admits under the same request ID, which its recipient's chat takes once. Root's message
        // to the user is the call itself, which the screens show.
        const input = { requestId: `tell:${api.taskId}`, date: new Date(api.now()).toISOString() };
        if (child !== undefined) {
          await setup.admit(tx, child.conversationId, { ...input, kind: 'user', content: message });
        } else if (parent !== null) {
          await setup.admit(tx, agents[parent].conversationId,
            { ...input, kind: 'work', content: `[${self}]\n${message}` });
        }
        return `Sent to ${name}.`;
      }, context));
    },
  });
  /** Hides or shows a child of the caller's; an answer, not a failure, for a name that is none. */
  const visibility = (hidden: boolean) => async (tx: Tx, caller: ConversationId, name: string): Promise<string> => {
    const { agents } = await tree(tx);
    const self = agentNamed(agents, caller);
    const child = self === undefined ? undefined : agents[self].children.find((each) => each.name === name);
    if (child === undefined) return `No child ${name}.`;
    child.hidden = hidden;
    return `${hidden ? 'Hid' : 'Showed'} ${name}.`;
  };
  const hide = defineTool({
    name: 'hide',
    description: 'Hide a child from your list and the user\'s views. Its chat and folder stay; tell still reaches it.',
    replay: 'safe',
    parameters: obj({ name: str() }, { open: true }),
    execute: async ({ name }, api, context) =>
      reply(await api.commit((tx) => visibility(true)(tx, api.conversationId, name), context)),
  });
  const show = defineTool({
    name: 'show',
    description: 'Show a hidden child again.',
    replay: 'safe',
    parameters: obj({ name: str() }, { open: true }),
    execute: async ({ name }, api, context) =>
      reply(await api.commit((tx) => visibility(false)(tx, api.conversationId, name), context)),
  });
  const list = defineTool({
    name: 'list',
    description: 'List your hidden children.',
    replay: 'safe',
    parameters: obj({}, { open: true }),
    async execute(_args, api, context) {
      const agents = (await api.snapshot(TreeDoc, ROOT_CONVERSATION_ID, context))?.agents ?? {};
      const self = agentNamed(agents, api.conversationId);
      const hidden = (self === undefined ? [] : agents[self].children).filter((child) => child.hidden);
      return reply(hidden.length === 0 ? 'None hidden.'
        : hidden.map((child) => `- ${child.name}: ${agents[child.name].description}`).join('\n'));
    },
  });
  return { spawn, tell, hide, show, list };
}
