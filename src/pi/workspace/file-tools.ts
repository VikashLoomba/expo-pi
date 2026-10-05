import type { JsonValue } from '@earendil-works/chord';
import { withAbortSignal, withoutAbortSignal } from '@earendil-works/chord/context';
import { Type, type Static, type TSchema } from '@earendil-works/pi-ai';
import { defineTool, type ToolExecutionResult, type ToolRegistration } from '@earendil-works/pi-durable';
import { createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools';
import { ensureWorkspaceDoc } from './document';
import { WorkspaceExecutionEnv } from './execution-env';
import { EditExecutionEnv } from './edit-budget';
import { finalizeEditResult } from './file-details';
import type { WorkspaceInvocation, WorkspaceRuntime } from './runtime';

function prepareReadArguments(input: unknown) {
  if (!input || typeof input !== 'object' || !('path' in input) || typeof input.path !== 'string') {
    throw new Error('read requires a string path.');
  }
  const paging = (value: unknown, name: string) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new Error(`read ${name} must be a positive safe integer.`);
    }
    return value;
  };
  const offset = paging('offset' in input ? input.offset : undefined, 'offset');
  const limit = paging('limit' in input ? input.limit : undefined, 'limit');
  return { path: input.path, ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) };
}

/** The entire SDK execution shares the same queue as bash, including edit's read/modify/write. */
function inWorkspace<P extends TSchema, D extends JsonValue>(
  tool: ToolRegistration<P, D>, workspaces: WorkspaceRuntime, replay: 'safe' | 'unsafe',
  policy?: {
    environment(invocation: WorkspaceInvocation, args: Static<P>): WorkspaceExecutionEnv;
    finalize(result: ToolExecutionResult<D>, invocation: WorkspaceInvocation): Promise<ToolExecutionResult>;
  },
): ToolRegistration<P> {
  return defineTool<P, JsonValue>({
    ...tool,
    replay,
    executionMode: 'sequential',
    async execute(args, api, context) {
      context.abortSignal?.throwIfAborted();
      const workspace = await api.commit((tx) => ensureWorkspaceDoc(tx, api.conversationId), context);
      return workspaces.run(workspace.id, context.abortSignal, async (invocation) => {
        const env = policy?.environment(invocation, args) ?? new WorkspaceExecutionEnv(invocation);
        try {
          const result = await tool.execute(args, { ...api, env }, withAbortSignal(invocation.signal, context));
          return policy ? await policy.finalize(result, invocation) : result;
        } catch (error) {
          // SDK tools sometimes replace an abort with a generic Error after an await.
          invocation.signal.throwIfAborted();
          throw error;
        } finally {
          await env.cleanup(withoutAbortSignal(context));
        }
      });
    },
  });
}

/** Keep Pi's schemas and argument repairs; constrain paging to meaningful line numbers. */
export function createWorkspaceFileTools(workspaces: WorkspaceRuntime) {
  const read = createReadTool();
  const write = createWriteTool();
  const edit = createEditTool();
  const path = Type.String({ ...read.parameters.properties.path, minLength: 1, maxLength: 4096 });
  const readTool = defineTool({
    ...read,
    // Pi's schema converter rounds numeric fractions for Integer. Reject them before conversion.
    prepareArguments: prepareReadArguments,
    parameters: Type.Object({
      path,
      offset: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
        description: 'Line number to start reading from (1-indexed)' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
        description: 'Maximum number of lines to read' })),
    }),
  });
  const writeTool = defineTool({ ...write, parameters: Type.Object({ ...write.parameters.properties, path }) });
  const editTool = defineTool({ ...edit, parameters: Type.Object({ ...edit.parameters.properties, path }) });
  return [inWorkspace(readTool, workspaces, 'safe'), inWorkspace(writeTool, workspaces, 'unsafe'),
    inWorkspace(editTool, workspaces, 'unsafe', {
      environment: (invocation, args) => new EditExecutionEnv(invocation, args.edits),
      finalize: finalizeEditResult,
    })];
}
