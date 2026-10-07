import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc, defineExtension, defineTask } from '@earendil-works/pi-durable';
import { err, ExecutionError, getOrThrow, ok } from '@earendil-works/pi-durable/env';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';

// The selector is deliberately test-only. Production has no fake target schema.
export const TestExecutionDoc = defineDoc({
  kind: 'test.execution.selection', version: 1, scope: 'conversation',
  history: 'rewindable', fork: 'asOf', initial: () => ({ kind: 'local' }),
});

export const DirectEnvTask = defineTask({
  name: 'test.direct-execution-env', version: 1, initial: () => ({ phase: 'run' }),
  phases: {
    async run(task, runtime, context) {
      const env = await runtime.env(context);
      if (!env) throw new Error('Task has no selected environment.');
      let result;
      const directory = getOrThrow(await env.createTempDir('pi-env-task-', context));
      try {
        const path = getOrThrow(await env.joinPath([directory, 'result'], context));
        getOrThrow(await env.writeFile(path, 'written through runtime.env()', context));
        const reader = getOrThrow(await env.openBinaryReader(path, undefined, context));
        try { result = new TextDecoder().decode(getOrThrow(await reader.read(0, 100, context))); }
        finally { await reader.close(BACKGROUND_CONTEXT); }
      } finally { getOrThrow(await env.remove(directory, { recursive: true, force: true }, BACKGROUND_CONTEXT)); }
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { text: result, cwd: env.cwd } } }), context);
    },
  },
  async abort(_task, runtime, context) {
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context);
  },
});

export const OwnedConversationTask = defineTask({
  name: 'test.owned-execution-env', version: 1, initial: () => ({ phase: 'run' }),
  phases: {
    async run(task, runtime, context) {
      await runtime.commit(async (tx) => {
        const child = await tx.createConversation({ ownership: { kind: 'task', taskId: task.id } });
        return { status: 'running', checkpoint: { phase: 'check', conversationId: child.id } };
      }, context);
    },
    async check(task, runtime, context) {
      let childTask;
      await runtime.commit(async (tx) => {
        childTask = await tx.createTask(DirectEnvTask, {}, {
          conversationId: task.state.checkpoint.conversationId, ownership: { kind: 'conversation' },
        });
      }, context);
      const direct = await runtime.waitForTask(childTask, context);
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: {
        conversationId: task.state.checkpoint.conversationId, direct: direct.state.outcome,
      } } }), context);
    },
  },
  async abort(_task, runtime, context) {
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context);
  },
});

/**
 * Independent public backend: composition over Pi's Node implementation, with
 * no application filesystem, local execution class or shell engine imports.
 * The actual operations run on an isolated host directory. Instrumentation and
 * controlled shell cases exercise the public contract at the harness boundary.
 */
export async function independentExecution(directory) {
  const root = join(directory, 'independent-host');
  await mkdir(root, { recursive: true });
  const operations = [];
  const environments = new WeakSet();
  const owners = new Set();
  const metrics = { resolutions: 0, scopes: 0, released: 0, cleaned: 0, emittedBytes: 0, active: 0, aborted: 0 };
  const behavior = { holdCancelledDrain: false };
  const drain = Promise.withResolvers();
  const extension = defineExtension({ name: 'test.execution', tasks: [DirectEnvTask, OwnedConversationTask] });

  function environment(cwd) {
    const backend = new NodeExecutionEnv({ cwd });
    let closed = false;
    const env = new Proxy(backend, {
      get(target, key) {
        if (key === 'cleanup') return async (context) => {
          if (closed) return;
          closed = true;
          metrics.cleaned++;
          await target.cleanup(context);
        };
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        return async (...args) => {
          operations.push({ name: key, path: typeof args[0] === 'string' ? args[0] : undefined,
            ...(key === 'exec' ? { command: args[0], timeout: args[1]?.timeout, window: args[1]?.window } : {}) });
          if (closed) throw new Error('Independent environment owner is closed.');
          if (key === 'exec' && args[0] === 'fixture:large-output') {
            const [, options, context] = args;
            // 64 MiB delivered incrementally, never accumulated in this fixture.
            const chunk = `${'x'.repeat(16_383)}\n`;
            for (let index = 0; index < 4096; index++) {
              context.abortSignal?.throwIfAborted();
              options?.onOutput?.(chunk, context, { stream: 'stdout' });
              metrics.emittedBytes += chunk.length;
            }
            options?.onOutput?.('LAST_STDOUT\n', context, { stream: 'stdout' });
            options?.onOutput?.('DISTINCT_STDERR\n', context, { stream: 'stderr' });
            return ok({ exitCode: 7 });
          }
          if (key === 'exec' && args[0] === 'fixture:wait') {
            const context = args[2];
            metrics.active++;
            try {
              await new Promise((resolve) => {
                if (context.abortSignal?.aborted) resolve();
                else context.abortSignal?.addEventListener('abort', resolve, { once: true });
              });
              metrics.aborted++;
              if (behavior.holdCancelledDrain) await drain.promise;
              return err(new ExecutionError('aborted', 'Independent command cancelled.'));
            } finally { metrics.active--; }
          }
          return value.apply(target, args);
        };
      },
      set(target, key, value) { return Reflect.set(target, key, value, target); },
    });
    environments.add(env);
    owners.add(env);
    return env;
  }

  function decorate(local) {
    let stopped = false;
    return {
      extensions: [...(local.extensions ?? []), extension],
      async conversationCreated(tx, conversation) {
        await local.conversationCreated?.(tx, conversation);
        // Pi copies rewindable/asOf state on forks; fresh owned conversations
        // explicitly inherit application state through document APIs.
        const selector = await tx.doc(TestExecutionDoc, conversation.id);
        if (conversation.owner && !conversation.parent) {
          Object.assign(selector, await tx.doc(TestExecutionDoc, conversation.owner.conversationId));
        }
      },
      async resolve(target, context) {
        metrics.resolutions++;
        if (stopped) throw new Error('Independent execution admission is stopped.');
        const selected = await target.read.snapshot(TestExecutionDoc, target.conversationId, context);
        if (selected?.kind === 'local' || !selected) return local.resolve(target, context);
        if (selected.kind === 'missing') return undefined;
        if (selected.kind === 'failing') throw new Error('Selected independent host unavailable.');
        if (selected.kind !== 'independent') throw new Error('Unknown test execution selection.');
        if (!target.cwd?.startsWith(root)) throw new Error('Independent cwd is outside its selected fixture.');
        return environment(target.cwd);
      },
      toolPolicy: {
        async scope(env, context) {
          if (!environments.has(env)) return local.toolPolicy.scope(env, context);
          metrics.scopes++;
          let released = false;
          return { env, context, async release() { if (!released) { released = true; metrics.released++; } } };
        },
        artifacts(env) { return environments.has(env) ? undefined : local.toolPolicy.artifacts?.(env); },
        promptFacts(input, context) {
          return environments.has(input.env)
            ? ['The selected execution environment is an independent test host. Files are stored in its isolated namespace; no local virtual shell is used.']
            : local.toolPolicy.promptFacts(input, context);
        },
      },
      stop() { stopped = true; local.stop(); },
      async close() {
        stopped = true;
        await Promise.all([...owners].map((env) => env.cleanup(BACKGROUND_CONTEXT)));
        await local.close();
      },
    };
  }

  return { root, operations, metrics, decorate, extension, environment, behavior, releaseDrain: drain.resolve };
}
