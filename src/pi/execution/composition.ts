import type { Extension, HarnessOptions } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
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
  /** Returns a borrowed environment. Select cwd through this resolver, never by
   * mutating a shared value. Only its composition owner shuts it down. */
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
  const environments = new Map<string, WorkspaceExecutionEnv>();
  let closing: Promise<void> | undefined;
  const assertOpen = () => { if (runtime.isStopped) throw new Error('Execution admission is stopped. Return to the app to continue.'); };
  return {
    async resolve({ conversationId, cwd, read }, context) {
      assertOpen();
      const workspace = await read.snapshot(WorkspaceDoc, conversationId, context);
      context.abortSignal?.throwIfAborted();
      assertOpen();
      if (!workspace?.id) throw new Error('This conversation has no committed workspace identity.');
      const directory = cwd ?? '/workspace';
      const key = JSON.stringify([workspace.id, directory]);
      let env = environments.get(key);
      if (!env) {
        env = createWorkspaceExecutionEnv(runtime, workspace.id, directory);
        environments.set(key, env);
      }
      return env;
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
          '/tmp and the system filesystem are shared across this workspace’s tools and tasks until the chat service closes. Only /workspace persists across service restarts. Bash starts each command with fresh shell variables and functions.',
          'Large edit patches are saved under /workspace/.edit-output when space permits. Larger textual shell output is saved under /workspace/.bash-output when space permits.',
          ...(workspace?.origin === 'fork' ? ['This conversation fork started with an empty workspace. Files mentioned in inherited messages were NOT copied or restored.'] : []),
          BASH_CAPABILITY_DESCRIPTION,
        ];
      },
    },
    stop: () => runtime.stop(),
    close() {
      runtime.stop();
      return closing ??= (async () => {
        // Release environment resources before closing their workspace database.
        // This also invalidates cached metadata-only facades that never registered
        // a resource with the lazy runtime.
        await Promise.allSettled([...environments.values()].map((env) => env.cleanup(BACKGROUND_CONTEXT)));
        environments.clear();
        await runtime.close();
      })();
    },
  };
}
