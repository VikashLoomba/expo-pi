import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';
import type { SharedToolPolicy } from '../execution/types';
import { BashOutput, presentOutput, TOOL_OUTPUT_BYTES } from './output';

/**
 * Pi's stock factory combines streams, keeps the tail, and advertises temporary spill files.
 * This thin public adapter preserves historic split-stream heads, exit status and durable artifacts.
 */
export function createBashTool(policy: Pick<SharedToolPolicy, 'artifacts'> = {}) {
  return defineTool({
    name: 'bash',
    description: 'Execute a bash script in the selected execution environment and its current directory. Returns bounded stdout, stderr and exit status. Optional timeout is in seconds (default 10, maximum 30). Available programs and filesystem behavior are described in the execution context.',
    parameters: Type.Object({ command: Type.String({ maxLength: 65536 }), timeout: Type.Optional(Type.Number({ minimum: 0.1, maximum: 30 })) }),
    replay: 'unsafe', executionMode: 'sequential',
    outputLimits: { maxBytes: TOOL_OUTPUT_BYTES + 4096, maxLines: 2000 },
    async execute({ command, timeout = 10 }, api, context) {
      context.abortSignal?.throwIfAborted();
      if (!api.env) throw new Error('No execution environment is configured.');
      if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Bash timeout must be a positive finite number of seconds.');
      const effectiveTimeout = Math.min(30, Math.max(0.1, timeout));
      const artifacts = policy.artifacts?.(api.env);
      const output = new BashOutput(artifacts !== undefined);
      const result = await api.env.exec(command, {
        cwd: api.env.cwd, timeout: Math.ceil(effectiveTimeout * 1000) / 1000, inheritEnv: true,
        // No coalesced window: stream identity is needed for the persisted presentation.
        onOutput: (text, _context, info) => output[info.stream].append(text),
      }, context);
      context.abortSignal?.throwIfAborted();
      const timedOut = !result.ok && result.error.code === 'timeout';
      let exitCode: number;
      let failure: string | undefined;
      if (result.ok) exitCode = result.value.exitCode;
      else {
        exitCode = timedOut ? 124 : 1;
        // Keep failure visible even when stderr already exhausted its preview.
        failure = `${result.error.message.slice(0, 512)}\nFiles may have been partially changed; inspect before retrying.`;
      }
      const presented = await presentOutput(output, exitCode, context, artifacts, { allowSpill: !timedOut, failure });
      return { content: [{ type: 'text' as const, text: presented.text }], details: presented.details, isError: exitCode !== 0 };
    },
  });
}
