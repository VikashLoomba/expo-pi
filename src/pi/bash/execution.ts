import type { WorkspaceInvocation } from '../workspace/runtime';
import { type Context } from '@earendil-works/chord';
import { uuidv7 } from '@earendil-works/pi-ai';
import { ExecutionError, err, ok, toError, type Result, type ShellExecOptions, type ShellExecResult } from '@earendil-works/pi-durable/env';
import { createMountedFileSystem } from '../workspace/mounted-filesystem';
import { joinVirtualPath } from '../workspace/mounted-paths';
import { BASH_CAPABILITIES, createBashEngine } from './engine/index';

type ShellInvocation = Pick<WorkspaceInvocation, 'mounted' | 'signal'> & Partial<WorkspaceInvocation>;
const encoder = new TextEncoder();

/** The interpreter runs only its allowlisted programs; argv values bypass shell parsing. */
export async function executeWorkspaceCommand(invocation: ShellInvocation, cwd: string, command: string | readonly string[],
  options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
  const controller = new AbortController();
  const signals = [invocation.signal, context.abortSignal].filter((signal): signal is AbortSignal => !!signal);
  const forwardAbort = () => {
    const aborted = signals.find((signal) => signal.aborted);
    if (aborted) controller.abort(aborted.reason);
  };
  for (const signal of signals) signal.addEventListener('abort', forwardAbort, { once: true });
  forwardAbort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let started = false;
  let completedExitCode: number | undefined;
  try {
    if (controller.signal.aborted) return err(new ExecutionError('aborted', 'Shell execution was aborted.'));
    const requested = options?.timeout ?? 10;
    if (!Number.isFinite(requested) || requested <= 0) return err(new ExecutionError('spawn_error', 'Shell timeout must be a positive number of seconds.'));
    const timeoutMs = Math.min(30_000, Math.max(1, Math.ceil(requested * 1000)));
    const argv = typeof command === 'string' ? undefined : command;
    if (argv && (!argv.length || !BASH_CAPABILITIES.includes(argv[0] as typeof BASH_CAPABILITIES[number]))) {
      return err(new ExecutionError('spawn_error', `Program is unavailable in the local virtual shell: ${argv?.[0] ?? '(empty argv)'}`));
    }
    const script = typeof command === 'string' ? command : command[0];
    if (encoder.encode(typeof command === 'string' ? command : command.join('\0')).length > 65536) {
      return err(new ExecutionError('spawn_error', 'Shell command exceeds the 64 KiB source limit.'));
    }
    const mounted = invocation.files && invocation.system
      ? createMountedFileSystem(invocation.system, invocation.files.forInvocation(controller.signal), controller.signal)
      : invocation.mounted;
    const targetCwd = await mounted.realpath(joinVirtualPath(cwd, options?.cwd ?? cwd));
    if (!(await mounted.stat(targetCwd)).isDirectory) return err(new ExecutionError('spawn_error', 'Shell cwd is not a directory.'));
    const deadline = Date.now() + timeoutMs;
    const expire = () => { timedOut = true; controller.abort(new Error(`Bash timed out after ${timeoutMs / 1000} seconds.`)); };
    timer = setTimeout(expire, timeoutMs);
    const bash = createBashEngine(mounted, timeoutMs);
    // Once execution starts, failure must not invite a consumer to retry another
    // command form: earlier filesystem mutations may already have committed.
    started = true;
    const result = await bash.exec(script, {
      signal: controller.signal, rawScript: true, cwd: targetCwd,
      // Never inherit phone process variables. inheritEnv controls the virtual defaults only.
      replaceEnv: options?.inheritEnv === false,
      env: options?.env,
      ...(argv ? { args: [...argv.slice(1)] } : {}),
    });
    completedExitCode = result.exitCode;
    if (Date.now() >= deadline) expire();
    clearTimeout(timer); timer = undefined;
    if (timedOut) return err(new ExecutionError('timeout',
      `Bash timed out after ${timeoutMs / 1000} seconds. Output produced before interruption may be unavailable because this shell buffers output.`));
    if (controller.signal.aborted) return err(new ExecutionError('aborted', 'Shell execution was aborted.'));
    try {
      // The bounded engine buffers each stream, so arrival order between streams is
      // not observable. Each callback truthfully identifies its buffered stream.
      for (const stream of ['stdout', 'stderr'] as const) {
        const text = result[stream];
        // No window elision is used; every decoded character reaches the callback.
        if (text) options?.onOutput?.(text, context, { stream });
      }
    } catch (cause) { return err(new ExecutionError('callback_error', toError(cause).message, toError(cause))); }
    let spillPath: string | undefined;
    if (options?.spill) {
      const output = result.stdout + result.stderr;
      const bytes = encoder.encode(output).length;
      const lines = output ? output.split('\n').length - (output.endsWith('\n') ? 1 : 0) : 0;
      if (bytes > options.spill.afterBytes || lines > options.spill.afterLines) {
        spillPath = `/tmp/bash-${uuidv7()}.txt`;
        await mounted.createExclusive!(spillPath, { directory: false, mode: 0o600 });
        try { await mounted.writeFile(spillPath, output); }
        catch (cause) {
          // A failed spill is not a complete-output artifact. Best-effort removal
          // also avoids exhausting direct callers' temporary entry quota.
          await mounted.rm(spillPath, { force: true }).catch(() => undefined);
          throw cause;
        }
      }
    }
    return ok({ exitCode: result.exitCode, ...(spillPath ? { spillPath } : {}) });
  } catch (cause) {
    if (timedOut) return err(new ExecutionError('timeout', 'Bash timed out. Output produced before interruption may be unavailable because this shell buffers output.', toError(cause)));
    if (controller.signal.aborted) return err(new ExecutionError('aborted', 'Shell execution was aborted.', toError(cause)));
    const failure = toError(cause);
    if (completedExitCode !== undefined) {
      return err(new ExecutionError('unknown',
        `Shell command completed with exit code ${completedExitCode}, but its output could not be preserved: ${failure.message}`, failure));
    }
    return err(new ExecutionError(started ? 'unknown' : 'spawn_error', failure.message, failure));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    for (const signal of signals) signal.removeEventListener('abort', forwardAbort);
    // Cancels only this command's filesystem facade, never its environment owner.
    controller.abort(new Error('Shell command has ended.'));
  }
}
