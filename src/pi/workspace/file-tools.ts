import { withoutAbortSignal } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, wrapTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools';
import type { SharedToolPolicy } from '../execution/types';
import { EditExecutionEnv } from './edit-budget';
import { finalizeEditResult } from './file-details';

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

/** Keep Pi's schemas and argument repairs; constrain paging to meaningful line numbers. */
export function createWorkspaceFileTools(policy: SharedToolPolicy) {
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
  const tools = [
    defineTool({ ...readTool, replay: 'safe', executionMode: 'sequential' }),
    defineTool({ ...writeTool, replay: 'unsafe', executionMode: 'sequential' }),
    defineTool({ ...editTool, replay: 'unsafe', executionMode: 'sequential' }),
  ];
  const editPolicy = wrapTool(editTool as ToolRegistration<typeof editTool.parameters>, (tool) => ({
    ...tool,
    async execute(args, api, context) {
      if (!api.env) throw new Error('No execution environment is configured.');
      const environment = new EditExecutionEnv(api.env, args.edits);
      try {
        const result = await tool.execute(args, { ...api, env: environment }, context);
        return await finalizeEditResult(result, context, policy.artifacts?.(api.env));
      } finally {
        await environment.cleanup(withoutAbortSignal(context));
      }
    },
  }));
  return { tools, wraps: [editPolicy] };
}
