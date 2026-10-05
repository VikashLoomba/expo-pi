import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';
import { ensureWorkspaceDoc } from '../workspace/document';
import type { WorkspaceRuntime } from '../workspace/runtime';
import { createBashEngine } from './engine/index';
import { withBashDeadline } from './execution';
import { presentOutput, TOOL_OUTPUT_BYTES } from './output';

export function createBashTool(workspaces: WorkspaceRuntime) {
  return defineTool({
    name: 'bash',
    description: 'Execute a bounded local bash script in this chat’s persistent /workspace. Returns buffered stdout, stderr and exit status. Optional timeout is in seconds (default 10, maximum 30). No external binaries, JavaScript/Python runtimes or networking.',
    parameters: Type.Object({ command: Type.String({ maxLength: 65536 }), timeout: Type.Optional(Type.Number({ minimum: 0.1, maximum: 30 })) }),
    replay: 'unsafe', executionMode: 'sequential',
    outputLimits: { maxBytes: TOOL_OUTPUT_BYTES + 4096, maxLines: 2000 },
    async execute({ command, timeout = 10 }, api, context) {
      context.abortSignal?.throwIfAborted();
      const workspace = await api.commit((tx) => ensureWorkspaceDoc(tx, api.conversationId), context);
      const timeoutMs = Math.ceil(timeout * 1000);
      return workspaces.run(workspace.id, context.abortSignal, (invocation) =>
        withBashDeadline(invocation, timeoutMs, async ({ files, mounted, signal, finishExecution }) => {
          const bash = createBashEngine(mounted, timeoutMs);
          const result = await bash.exec(command, { signal, rawScript: true });
          const timedOut = finishExecution();
          if (!timedOut) signal.throwIfAborted();
          const presented = timedOut ? {
            ...result,
            exitCode: 124,
            stderr: `${result.stderr}${result.stderr && !result.stderr.endsWith('\n') ? '\n' : ''}`
              + `Bash timed out after ${timeoutMs / 1000} seconds. Files may have been partially changed; inspect before retrying. `
              + 'Output produced before interruption may be unavailable because this shell buffers output.\n',
          } : result;
          const output = await presentOutput(files, presented, { allowSpill: !timedOut });
          return { content: [{ type: 'text' as const, text: output.text }], details: output.details, isError: presented.exitCode !== 0 };
        }));
    },
  });
}
