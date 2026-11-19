import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConversationId, DocumentWatch, Harness, TaskGraphWatch } from '@earendil-works/pi-durable';
import { bool, nul, obj, str, union, type Static } from '@earendil-works/pi-schema';

import { ROOT, TreeDoc, type Tree } from './infinichat/agents';

const context = BACKGROUND_CONTEXT;

/** An agent of the tree as the screens list it: `parent` is null for root, and `awake` says its turn runs. */
export const AgentInfoSchema = obj({
  name: str(), description: str(), parent: union([str(), nul()]), awake: bool(),
}, { open: true });
export type AgentInfo = Static<typeof AgentInfoSchema>;

/**
 * The tree of agents as the screens show it, as UniiChat's views list its uniis: root first, each agent before its
 * children in spawn order, a hidden one and its children left out. It follows the tree's document and pi-durable's
 * task graph, where an agent's turn is the live work of its conversation that is not background.
 */
export class AgentList {
  private tree?: DocumentWatch<Tree>;
  private graph?: TaskGraphWatch;
  private agents?: readonly AgentInfo[];
  private readonly listeners = new Set<() => void>();
  private closed = false;

  constructor(private readonly harness: Harness, private readonly root: ConversationId) {}

  async start(): Promise<void> {
    const [tree, graph] = await Promise.all([
      this.harness.watchDoc(TreeDoc, this.root, context), this.harness.watchTaskGraph(context),
    ]);
    if (tree === undefined) {
      await graph.stop();
      throw new Error('The agents of the conversation could not be read.');
    }
    if (this.closed) {
      await Promise.all([tree.stop(), graph.stop()]);
      return;
    }
    this.tree = tree;
    this.graph = graph;
    for (const watch of [tree, graph]) {
      watch.start(async (call) => {
        if (call.kind === 'value') this.read();
      });
    }
    this.read();
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  /** Undefined until the tree is first read. */
  readonly getSnapshot = () => this.agents;

  /** The conversation of the agent the tree names so, a hidden one's too; undefined for no agent, or none read yet. */
  conversation(name: string): ConversationId | undefined {
    const agents = this.tree?.value.agents;
    return agents !== undefined && Object.hasOwn(agents, name) ? agents[name].conversationId : undefined;
  }

  close(): void {
    this.closed = true;
    void this.tree?.stop();
    void this.graph?.stop();
  }

  /** The graph changes with every task, so the list is published only when it differs. */
  private read() {
    const tree = this.tree?.value;
    if (this.closed || tree === undefined) return;
    const working = new Set(Object.values(this.graph?.value.tasks ?? {})
      .flatMap((task) => task.background ? [] : [task.conversationId]));
    const agents: AgentInfo[] = [];
    const visit = (name: string) => {
      const { conversationId, parent, description, children } = tree.agents[name];
      agents.push({ name, description, parent, awake: working.has(conversationId) });
      for (const child of children) if (!child.hidden) visit(child.name);
    };
    visit(ROOT);
    if (JSON.stringify(agents) === JSON.stringify(this.agents)) return;
    this.agents = agents;
    for (const listener of [...this.listeners]) listener();
  }
}
