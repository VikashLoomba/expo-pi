import { uuidv7 } from '@earendil-works/pi-ai';
import { AgentDoc, defineDoc, type AgentState, type ConversationId, type Tx } from '@earendil-works/pi-durable';

// These persisted identities deliberately retain their original names.
export const WORKSPACE_EXTENSION = 'local-bash';
export const WORKSPACE_TOOLS = ['bash', 'read', 'write', 'edit'] as const;
export const WORKSPACE_CAPABILITY_REVISION = 1;
export type WorkspaceState = { id: string; origin: 'new' | 'existing' | 'fork'; capabilityRevision: number };

/** Identity belongs to the conversation; file bytes belong to the workspace database. */
export const WorkspaceDoc = defineDoc<WorkspaceState>({
  kind: 'app.bash.workspace', version: 2, scope: 'conversation', history: 'latest', fork: 'initial',
  // Reads of a missing document must not invent an uncommitted identity.
  initial: () => ({ id: '', origin: 'new', capabilityRevision: 0 }),
  migrate(value, fromVersion) {
    if (fromVersion !== 1 || typeof value.id !== 'string' ||
        !['new', 'existing', 'fork'].includes(String(value.origin))) {
      throw new Error('Cannot migrate an invalid workspace identity.');
    }
    const origin = value.origin === 'fork' ? 'fork' : value.origin === 'existing' ? 'existing' : 'new';
    return { id: value.id, origin, capabilityRevision: 0 };
  },
});

export async function ensureWorkspaceDoc(tx: Tx, conversationId: ConversationId, origin: WorkspaceState['origin'] = 'new') {
  const workspace = await tx.doc(WorkspaceDoc, conversationId);
  if (!workspace.id) {
    workspace.id = uuidv7();
    workspace.origin = origin;
  }
  // Chord document proxies are valid only while their transaction is active.
  return { id: workspace.id, origin: workspace.origin, capabilityRevision: workspace.capabilityRevision };
}

function includeTools(agent: AgentState): void {
  if (Array.isArray(agent.extensions)) {
    if (!agent.extensions.includes(WORKSPACE_EXTENSION)) agent.extensions.push(WORKSPACE_EXTENSION);
  } else if (agent.extensions?.remove) {
    agent.extensions.remove = agent.extensions.remove.filter((name) => name !== WORKSPACE_EXTENSION);
  }
  if (Array.isArray(agent.tools)) {
    for (const name of WORKSPACE_TOOLS) if (!agent.tools.includes(name)) agent.tools.push(name);
  } else if (agent.tools?.remove) {
    agent.tools.remove = agent.tools.remove.filter((name) => !WORKSPACE_TOOLS.some((tool) => tool === name));
  }
}

/** Apply each capability rollout once; later explicit user exclusions remain authoritative. */
export async function migrateWorkspaceCapabilities(tx: Tx, conversationId: ConversationId, origin: WorkspaceState['origin']) {
  await ensureWorkspaceDoc(tx, conversationId, origin);
  const workspace = await tx.doc(WorkspaceDoc, conversationId);
  if (workspace.capabilityRevision >= WORKSPACE_CAPABILITY_REVISION) return;
  includeTools(await tx.doc(AgentDoc, conversationId));
  workspace.capabilityRevision = WORKSPACE_CAPABILITY_REVISION;
}
