import {
  BACKGROUND_CONTEXT as context, awaitWithContext, withAbortSignal, type Context,
} from '@earendil-works/chord/context';
import {
  createRegistry, type Harness, type SettledSubmissionRecord, type Storage,
} from '@earendil-works/pi-durable';

import {
  InputDoc, openOptChat, optChatParts, type Admission, type OptChat, type OptChatExtensionOptions,
  type OptChatOptions, type OptChatParts,
} from '../src/pi/infinichat/app';
import { CoordinatorDoc } from '../src/pi/infinichat/wake';

type HostOptions = Pick<OptChatOptions, 'models' | 'onReport'>
  & Pick<OptChatExtensionOptions, 'hasDeviceTools' | 'turnState'>;

/**
 * Opens OptChat as its hosts do (`apps/mobile/src/pi/infinichat-phone.ts`): `openOptChat` opens the Harness paused, so
 * the host puts OptChat's extensions in the registry the Harness reads and resumes it.
 */
export async function openHosted(storage: Storage, options: HostOptions): Promise<OptChat> {
  const { models, onReport, ...capabilities } = options;
  let harness: Harness | undefined;
  const parts = optChatParts({ harness: () => harness, ...capabilities });
  const registry = createRegistry();
  for (const extension of parts.extensions) registry.install(extension);
  const chat = await openOptChat(storage, { models, registry, parts, onReport }, context);
  wakes.set(chat, parts.wake);
  harness = chat.harness;
  chat.harness.resume();
  return chat;
}

const wakes = new WeakMap<OptChat, OptChatParts['wake']>();
/**
 * Wakes root's coordinator, or starts one, as every commit that gives an agent work does: for a test that writes the
 * agent's documents itself, which no commit of OptChat's follows.
 */
export const wake = (chat: OptChat) => chat.harness.commit((tx) => {
  const start = wakes.get(chat);
  if (!start) throw new Error('This chat was not opened by openHosted');
  return start(tx, chat.root.id);
}, context);

/** The request ID OptChat submits an input's attempt under: the first attempt's has no number. */
const nativeRequest = ({ requestId, attempt }: Admission): string =>
  attempt === 0 ? `optchat:${requestId}` : `optchat:${requestId}:${attempt}`;

/**
 * Rejects once the turn's coordinator ends any other way than done, since no input is submitted without it. One that
 * is done closed its turn, and the admission's own phase tells of the input.
 */
async function coordinatorFailure(chat: OptChat, waiting: Context): Promise<never> {
  const coordinator = (await chat.harness.snapshot(CoordinatorDoc, chat.root.id, waiting))?.task;
  if (coordinator) {
    const task = await chat.harness.waitForTask(coordinator, waiting);
    if (task.state.outcome.status !== 'completed') {
      throw new Error(`OptChat coordinator ended: ${JSON.stringify(task.state.outcome)}`);
    }
  }
  return new Promise<never>(() => {});
}

/** The admission once an attempt from `attempt` on is submitted, or once a stop cancelled it. */
async function submitted(chat: OptChat, requestId: string, attempt: number): Promise<Admission> {
  const watch = await chat.harness.watchDoc(InputDoc, chat.root.id, requestId, context);
  const accepted = watch?.value.value;
  if (!watch || !accepted || accepted.kind === 'note') {
    await watch?.stop();
    throw new Error(accepted ? 'Notes do not dispatch a model answer'
      : 'Accept the request before waiting for its answer');
  }
  const cancellation = new AbortController();
  const settled = new Promise<void>((resolve) => {
    const inspect = (value: typeof watch.value) => {
      const phase = value.value?.phase;
      if ((phase === 'submitted' && (value.value?.attempt ?? 0) >= attempt) || phase === 'cancelled') resolve();
    };
    watch.start(async (call) => {
      if (call.kind === 'value') inspect(call.value);
    });
    inspect(watch.value);
  });
  try {
    const ended = watch.closed.then((end) => {
      if (end.kind === 'listener_error' || end.kind === 'failed') throw end.error;
      throw new Error(`Admission watch ended: ${end.kind}`);
    });
    const failure = coordinatorFailure(chat, withAbortSignal(cancellation.signal, context));
    await awaitWithContext(Promise.race([settled, ended, failure]), context);
  } finally {
    cancellation.abort();
    await watch.stop();
  }
  const admission = (await chat.harness.snapshot(InputDoc, chat.root.id, requestId, context))?.value;
  if (!admission) throw new Error(`Unknown OptChat request: ${requestId}`);
  return admission;
}

/**
 * How an accepted input was settled, from pi-durable's own submission for it. An input withdrawn after a failed or
 * faulted run is submitted anew as its next attempt, so the wait goes on with that one.
 */
export async function waitForAnswer(chat: OptChat, requestId: string): Promise<SettledSubmissionRecord> {
  let attempt = 0;
  for (;;) {
    const admission = await submitted(chat, requestId, attempt);
    if (admission.phase === 'cancelled') throw new Error('Input was cancelled before native submission');
    const record = await chat.harness.commit(
      (tx) => tx.submissionByRequest(chat.root.id, nativeRequest(admission)),
      context,
    );
    if (!record) throw new Error('Submitted admission is missing its native receipt');
    const submission = await chat.harness.submission(record.id, context);
    if (!submission) throw new Error('Submitted admission is missing its native submission');
    const settled = await submission.wait(context);
    // The coordinator counts the next attempt before its withdrawal settles this one as aborted.
    const now = (await chat.harness.snapshot(InputDoc, chat.root.id, requestId, context))?.value;
    const requeued = settled.status === 'unanswered' && (settled.reason === 'run_failed'
      || (settled.reason === 'aborted' && now !== undefined && now !== null && now.attempt > admission.attempt));
    if (!requeued) return settled;
    attempt = admission.attempt + 1;
  }
}
