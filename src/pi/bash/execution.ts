import type { WorkspaceInvocation } from '../workspace/runtime';

type BashInvocation = WorkspaceInvocation & {
  /** End the script deadline before formatting output; true means it expired. */
  finishExecution(): boolean;
};

/** Bash owns its deadline and handled timeout result; the workspace owns sealing and draining. */
export async function withBashDeadline<T>(invocation: WorkspaceInvocation, timeoutMs: number,
  execute: (invocation: BashInvocation) => Promise<T>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let timedOut = false;
  let executionFinished = false;
  const expire = () => {
    if (invocation.signal.aborted) return;
    timedOut = true;
    invocation.abort(new Error(`Bash timed out after ${timeoutMs / 1000} seconds.`));
  };
  const timer = setTimeout(expire, timeoutMs);
  const finishExecution = () => {
    if (!executionFinished) {
      // Microtask-heavy scripts may finish before the timer gets a turn.
      if (Date.now() >= deadline) expire();
      executionFinished = true;
      clearTimeout(timer);
    }
    return timedOut;
  };
  try {
    const result = await execute({ ...invocation, finishExecution });
    if (!timedOut || !executionFinished) invocation.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
  }
}
