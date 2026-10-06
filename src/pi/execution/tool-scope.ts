import { wrapTool, type ToolRegistration } from '@earendil-works/pi-durable';
import type { SharedToolPolicy } from './types';

/** Resource admission belongs to execute, never wrapper construction or lifecycle hooks. */
export function scopeTool<T extends ToolRegistration>(tool: T, policy: SharedToolPolicy) {
  return wrapTool(tool, (inner) => ({
    ...inner,
    async execute(args, api, context) {
      context.abortSignal?.throwIfAborted();
      if (!api.env) throw new Error('No execution environment is configured.');
      const scope = await policy.scope(api.env, context);
      try {
        const result = await inner.execute(args, { ...api, env: scope.env }, scope.context);
        context.abortSignal?.throwIfAborted();
        scope.context.abortSignal?.throwIfAborted();
        return result;
      } catch (cause) {
        // SDK tools may replace cancellation after an await. Preserve the caller's reason.
        context.abortSignal?.throwIfAborted();
        scope.context.abortSignal?.throwIfAborted();
        throw cause;
      } finally {
        await scope.release();
      }
    },
  }));
}
