import { defineDoc } from '@earendil-works/pi-durable';

/** Identity belongs to the conversation; file bytes belong to the workspace directory it names. */
export const WorkspaceDoc = defineDoc<{ id?: string }>({
  kind: 'app.bash.workspace', version: 2, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({}),
});
