import type { Extension, HarnessOptions } from '@earendil-works/pi-durable';
import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import { BASH_CAPABILITY_DESCRIPTION } from '../bash/engine/index';
import { WorkspaceDoc } from '../workspace/document';
import {
  WorkspaceExecutionEnv, acquireWorkspaceExecutionScope, createWorkspaceExecutionEnv, workspaceInvocation,
} from '../workspace/execution-env';
import { WorkspaceRuntime } from '../workspace/runtime';
import { createWorkspaceArtifactWriter } from './local-artifacts';
import type { SharedToolPolicy } from './types';

/** The service owns this composition; Pi owns neither environments nor their cleanup. */
export interface ExecutionComposition {
  readonly resolve: NonNullable<HarnessOptions['env']>;
  readonly toolPolicy: SharedToolPolicy;
  /** Optional application documents/tasks and transactional creation inheritance. */
  readonly extensions?: readonly Extension[];
  readonly conversationCreated?: HarnessOptions['conversationCreated'];
  stop(): void;
  close(): Promise<void>;
}

/**
 * Production defaults to local execution. A custom composition replaces resolve,
 * while keeping the same tool registrations. Missing selections never fall back.
 * Resolving prompt metadata creates no database connection, queue lease or reader.
 */
export function createLocalExecution(openDatabase: () => Promise<SqliteDatabase>): ExecutionComposition {
  const runtime = new WorkspaceRuntime(openDatabase);
  return {
    async resolve({ conversationId, cwd, read }, context) {
      const workspace = await read.snapshot(WorkspaceDoc, conversationId, context);
      if (!workspace?.id) throw new Error('This conversation has no committed workspace identity.');
      return createWorkspaceExecutionEnv(runtime, workspace.id, cwd ?? '/workspace');
    },
    toolPolicy: {
      async scope(env, context) {
        if (env instanceof WorkspaceExecutionEnv) return acquireWorkspaceExecutionScope(env, context);
        // Plain public environments need no application-specific interface. Their
        // owner supplies any request scope it needs and closes the backend itself.
        return { env, context, async release() {} };
      },
      artifacts(env) {
        if (!(env instanceof WorkspaceExecutionEnv)) return undefined;
        const invocation = workspaceInvocation(env);
        return invocation ? createWorkspaceArtifactWriter(invocation) : undefined;
      },
      async promptFacts({ env, conversationId, read }, context) {
        if (!(env instanceof WorkspaceExecutionEnv)) return [];
        const workspace = await read.snapshot(WorkspaceDoc, conversationId, context);
        return [
          'The read, write, edit and bash tools share this chat’s local filesystem. /workspace persists across app restarts; HOME and the default cwd resolve there.',
          '/tmp and the system filesystem are recreated for every tool invocation. Bash starts with fresh shell variables and functions; only /workspace files persist.',
          'Large edit patches are saved under /workspace/.edit-output when space permits. Larger textual shell output is saved under /workspace/.bash-output when space permits.',
          ...(workspace?.origin === 'fork' ? ['This conversation fork started with an empty workspace. Files mentioned in inherited messages were NOT copied or restored.'] : []),
          BASH_CAPABILITY_DESCRIPTION,
        ];
      },
    },
    stop: () => runtime.stop(),
    close: () => runtime.close(),
  };
}
