import { uuidv7 } from '@earendil-works/pi-ai';
import { defineDoc, type ConversationId, type Tx } from '@earendil-works/pi-durable';

export const WORKSPACE_EXTENSION = 'local-bash';
export type WorkspaceState = { id: string; origin: 'new' | 'fork' };

/** Identity belongs to the conversation; file bytes belong to the workspace database. */
export const WorkspaceDoc = defineDoc<WorkspaceState>({
  kind: 'app.bash.workspace', version: 2, scope: 'conversation', history: 'latest', fork: 'initial',
  // Reads of a missing document must not invent an uncommitted identity.
  initial: () => ({ id: '', origin: 'new' }),
});

export async function ensureWorkspaceDoc(tx: Tx, conversationId: ConversationId, origin: WorkspaceState['origin'] = 'new') {
  const workspace = await tx.doc(WorkspaceDoc, conversationId);
  if (!workspace.id) {
    workspace.id = uuidv7();
    workspace.origin = origin;
  }
  // Chord document proxies are valid only while their transaction is active.
  return { id: workspace.id, origin: workspace.origin };
}
