import type { Extension, HarnessOptions } from '@earendil-works/pi-durable';

import { BASH_CAPABILITY_DESCRIPTION } from '../bash/engine/index';
import { WorkspaceDoc } from '../workspace/document';
import { WorkspaceExecutionEnv } from '../workspace/execution-env';
import type { Workspaces } from '../workspace/storage';
import type { SharedToolPolicy } from './types';

/** The service owns this composition; Pi owns neither environments nor their cleanup. */
export interface ExecutionComposition {
  /** Builds the environment for one use. Select cwd through this resolver, never by mutating a shared value. */
  readonly resolve: NonNullable<HarnessOptions['env']>;
  readonly toolPolicy: SharedToolPolicy;
  /** Optional application documents and tasks. */
  readonly extensions?: readonly Extension[];
  stop(): void;
  close(): Promise<void>;
}

/**
 * Each chat's own workspace directory, as a fresh environment per use like pi's sandbox-per-conversation example.
 * Without `workspaces` there is no local environment, and the tools fail with Pi's ordinary error result.
 * The environments hold no handles between calls, so there is nothing to stop or close.
 */
export function createLocalExecution(workspaces: Workspaces | undefined): ExecutionComposition {
  return {
    async resolve({ conversationId, cwd, read }, context) {
      if (!workspaces) return undefined;
      const workspace = await read.snapshot(WorkspaceDoc, conversationId, context);
      if (!workspace?.id) throw new Error('This conversation has no committed workspace identity.');
      return new WorkspaceExecutionEnv(workspaces.workspace(workspace.id), workspace.id, cwd);
    },
    toolPolicy: {
      promptFacts({ env }) {
        if (!(env instanceof WorkspaceExecutionEnv)) return [];
        return [
          'The read, write, edit and bash tools share this chat’s own /workspace on this device. ' +
            'It persists across app restarts; HOME and the default cwd resolve there. ' +
            'File tools reach only /workspace.',
          BASH_CAPABILITY_DESCRIPTION,
        ];
      },
    },
    stop() {},
    async close() {},
  };
}
