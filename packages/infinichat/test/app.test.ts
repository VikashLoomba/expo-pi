import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import {
  createModels, fauxAssistantMessage, fauxProvider, type Context as ModelContext, type FauxResponseStep,
} from '@earendil-works/pi-ai';
import { LiveDoc, MemoryStorage, configure, type ModelRef } from '@earendil-works/pi-durable';

import { AppDoc, InputDoc, type OptChat } from '../src/pi/infinichat/app';
import { MemoryDoc, MessageDoc } from '../src/pi/infinichat/memory';
import { ConfigDoc } from '../src/pi/infinichat/summary';
import { openHosted, waitForAnswer, wake } from './host';

const model = { provider: 'faux', modelId: 'faux-1' };
/** The host's one settings commit: main model through configure, summary model in ConfigDoc. */
async function selectModels(chat: OptChat, selected: ModelRef, summary: ModelRef = selected) {
  await chat.root.commit(async (tx) => {
    await configure(tx, chat.root.id, { model: selected });
    (await tx.doc(ConfigDoc, chat.root.id)).summary = { model: summary, thinkingLevel: 'off' };
  }, context);
}

test('two fresh turns retain only saved memory, append canonical originals once, notes never run', {
  timeout: 15000,
}, async () => {
  const seen: ModelContext[] = [];
  const faux = fauxProvider({ models: [{ id: 'faux-1', contextWindow: 100_000 }] });
  faux.setResponses(Array.from({ length: 20 }, () => (input: ModelContext) => {
    seen.push(structuredClone(input));
    return fauxAssistantMessage(`answer ${seen.length}`);
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const reports: unknown[] = [];
  const chat = await openHosted(new MemoryStorage(), { models, onReport: (e) => reports.push(e) });
  try {
    await selectModels(chat, model);
    await chat.accept({ requestId: 'one', content: 'hello' });
    assert.equal((await waitForAnswer(chat, 'one')).status, 'done');
    await chat.accept({ requestId: 'two', content: 'again' });
    assert.equal((await waitForAnswer(chat, 'two')).status, 'done');
    assert.equal(seen.length, 2);
    const second = seen[1];
    assert.equal(second.messages.filter((x) => x.role === 'assistant').length, 0);
    assert.match(JSON.stringify(second), /user: hello/);
    assert.match(JSON.stringify(second), /infinichat: answer 1/);
    assert.equal(
      (JSON.stringify(second.messages.filter((m) => m.role === 'user')).match(/again/g) ?? []).length,
      1,
    );
    await chat.accept({ requestId: 'two', content: 'again' });
    await chat.accept({ requestId: 'note', content: 'imported older fact', kind: 'note' });
    const noteWatch = await chat.harness.watchDoc(InputDoc, chat.root.id, 'note', context);
    assert.ok(noteWatch);
    await new Promise<void>((resolve) => {
      const inspect = (value: typeof noteWatch.value) => {
        if (value.value?.phase === 'submitted') resolve();
      };
      noteWatch.start(async (call) => {
        if (call.kind === 'value') inspect(call.value);
      });
      inspect(noteWatch.value);
    });
    await noteWatch.stop();
    assert.equal(seen.length, 2);
    const memory = await chat.harness.snapshot(MemoryDoc, chat.root.id, context);
    assert.ok(memory);
    const messages = [];
    for (let i = 0; i < memory.nextMessage; i++) {
      messages.push(await chat.harness.snapshot(MessageDoc, chat.root.id, String(i), context));
    }
    assert.equal(messages.filter((m) => m?.text === 'hello').length, 1);
    assert.equal(messages.filter((m) => m?.text === 'again').length, 1);
    assert.equal(messages.filter((m) => m?.kind === 'note').length, 1);
    assert.equal((await chat.harness.snapshot(AppDoc, chat.root.id, context))?.epoch, 2);
    assert.deepEqual(reports, []);
  } finally {
    await chat.close();
  }
});

test('a stop leaves the messages its turn had not taken to start the next turn', { timeout: 15000 }, async () => {
  let turns = 0;
  const { chat, reports } = await chatWith(() =>
    fauxAssistantMessage(++turns === 1 ? `STREAMED ${'word '.repeat(2000)}` : 'read it'), 100);
  try {
    await chat.accept({ requestId: 'one', content: 'hello' });
    await until(
      () => chat.harness.snapshot(LiveDoc, chat.root.id, context),
      (live) => JSON.stringify(live?.generation?.message ?? {}).includes('STREAMED'),
    );
    // A child's message reaches the running turn, which has no tool round to take it at, and the user stops the turn.
    await chat.accept({ requestId: 'report', kind: 'work', content: '[kid]\nits report' });
    await until(
      () => chat.harness.snapshot(InputDoc, chat.root.id, 'report', context),
      (input) => input?.value?.phase === 'submitted',
    );
    await chat.abort();
    // As UniiChat's stopped turn wakes again for the messages it never took: the stop cuts the reply, and the
    // child's message, which the child cannot send again, starts a turn of its own.
    assert.equal((await waitForAnswer(chat, 'report')).status, 'done');
    const lines = await until(() => logged(chat), (all) => all.includes('infinichat: read it'));
    assert.equal(lines.length, 5);
    assert.equal(lines[0], 'user: hello');
    assert.ok(lines[1].startsWith('infinichat: STREAMED') && lines[1].endsWith('\n[cut off: stopped]'));
    assert.deepEqual(lines.slice(2), ['note: Stopped by the user.', 'work: [kid]\nits report', 'infinichat: read it']);
    // A stop of an agent at rest stops nothing and notes nothing.
    await chat.abort();
    await chat.accept({ requestId: 'after-stop', content: 'continue now' });
    assert.equal((await waitForAnswer(chat, 'after-stop')).status, 'done');
    assert.ok(!(await logged(chat)).slice(5).some((line) => line.startsWith('note:')));
    assert.deepEqual(reports, []);
  } finally {
    await chat.close();
  }
});

test('dynamic device state stays after view and outside canonical text and static system', {
  timeout: 10000,
}, async () => {
  const seen: ModelContext[] = [];
  const faux = fauxProvider({ models: [{ id: 'faux-1', contextWindow: 100_000 }] });
  faux.setResponses(Array.from({ length: 5 }, () => (input: ModelContext) => {
    seen.push(structuredClone(input));
    return fauxAssistantMessage('ok');
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  // The host's turn state, read as each turn starts.
  let devices = 'Devices open now:\n- mac';
  const chat = await openHosted(new MemoryStorage(), { models, hasDeviceTools: true, turnState: async () => devices });
  try {
    await selectModels(chat, model);
    await chat.accept({ requestId: 'devices-one', content: 'first' });
    await waitForAnswer(chat, 'devices-one');
    devices = 'Devices open now:\n- linux';
    await chat.accept({ requestId: 'devices-two', content: 'second' });
    await waitForAnswer(chat, 'devices-two');
    const systems = seen.map((c) => c.messages
      .filter((m) => m.role === 'system')
      .map((m) => ({ content: m.content, ...('sections' in m ? { sections: m.sections } : {}) })));
    assert.deepEqual(systems[0], systems[1]);
    const input = seen[1].messages.find((m) => m.role === 'user');
    assert.ok(input);
    const text = typeof input.content === 'string'
      ? input.content
      : input.content.filter((x) => x.type === 'text').map((x) => x.text).join('');
    // The view, the turn state, the agent's place, then the head that tells a turn from a compaction.
    const order = [
      '</chat>',
      '- linux',
      'You are root. Your parent: the user (tell "user"). Your children: none.',
      'Turn: your new messages:\n\nsecond',
    ].map((part) => text.indexOf(part));
    assert.ok(order.every((at, i) => at >= 0 && (i === 0 || order[i - 1] < at)));
    assert.ok(!text.includes('- mac'));
    assert.ok(!text.includes('<turn'));
    const first = await chat.harness.snapshot(MessageDoc, chat.root.id, '0', context);
    assert.equal(first?.text, 'first');
  } finally {
    await chat.close();
  }
});

test('earlier application and input documents migrate as pi-durable reads them', () => {
  const v2 = {
    promptVersion: 2, epoch: 4, open: false, started: false, requests: [], pending: [], cursor: null,
    coordinator: null, revision: 9, stop: 1, stopped: 1, stopPending: [],
  };
  // Up to version 5 the document named its conversation's one coordinator; a turn's own is named apart, and a
  // Continue waits to be submitted here. Up to version 6 it listed the inputs a stop would withdraw.
  const { coordinator: _one, stopPending: _withdrawn, ...kept } = v2;
  // Version 2 logged a call with its assistant message, so none waits for its result, and noted no stop.
  assert.deepEqual(AppDoc.definition.migrate?.(v2, 2), { ...kept, endNote: null, held: {}, cut: null, resume: null });
  const { promptVersion: _current, ...v1 } = v2;
  assert.equal(AppDoc.definition.migrate?.(v1, 1)?.promptVersion, 1);
  // Version 3's stop note is the turn's end note, and it held no cut attempt.
  const held = { call: { text: 'zoom {"id":0}', date: 'd', source: 'e:0' } };
  const v3 = { ...v2, stopNote: 'Stopped by the user: OptChat\'s turn.', held };
  assert.deepEqual(AppDoc.definition.migrate?.(v3, 3), {
    ...kept, endNote: 'Stopped by the user: OptChat\'s turn.', held, cut: null, resume: null,
  });
  const admission = {
    requestId: 'a', kind: 'user', content: 'hi', date: 'd', epoch: 1, fresh: true, phase: 'submitted', envelope: null,
  } as const;
  // Versions 1 and 2 submitted each input once: its first attempt.
  assert.deepEqual(
    InputDoc.definition.migrate?.({ value: { ...admission, turnState: 'Devices' } }, 1),
    { value: { ...admission, attempt: 0 } },
  );
  assert.deepEqual(InputDoc.definition.migrate?.({ value: admission }, 2), { value: { ...admission, attempt: 0 } });
  assert.deepEqual(InputDoc.definition.migrate?.({ value: null }, 2), { value: null });
});

/** Storage that outlives the Harness closing it, as the app's database outlives a restart. */
class KeptStorage extends MemoryStorage {
  override async close(): Promise<void> {}
}

test('a conversation that stored its first tool list is offered the tools added since', async () => {
  const storage = new KeptStorage();
  const models = createModels();
  const offered = async (chat: OptChat) => (await chat.root.agent(context)).tools.map((tool) => tool.name);
  const before = await openHosted(storage, { models });
  try {
    // Version 1 stored the tools the conversation was created with, which had no spawn or tell.
    const first = (await before.root.agent(context)).tools.filter((t) => t.name !== 'spawn' && t.name !== 'tell');
    await before.root.commit(async (tx) => {
      await configure(tx, before.root.id, { modelTools: first });
      await before.setInstructions(tx, 'The user\'s own text');
      (await tx.doc(AppDoc, before.root.id)).promptVersion = 2;
    }, context);
    assert.ok(!(await offered(before)).includes('spawn'));
  } finally {
    await before.close();
  }
  const after = await openHosted(storage, { models });
  try {
    assert.ok((await offered(after)).includes('spawn') && (await offered(after)).includes('tell'));
    assert.equal((await after.root.agent(context)).instructions, 'The user\'s own text');
  } finally {
    await after.close();
  }
});

/** OptChat over one scripted model, its main and summary model selected. */
async function chatWith(route: FauxResponseStep, tokensPerSecond?: number) {
  const faux = fauxProvider({
    models: [{ id: 'faux-1', contextWindow: 100_000 }],
    ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
  });
  faux.setResponses(Array.from({ length: 40 }, () => route));
  const models = createModels();
  models.setProvider(faux.provider);
  const reports: unknown[] = [];
  const chat = await openHosted(new MemoryStorage(), { models, onReport: (e) => reports.push(e) });
  await selectModels(chat, model);
  return { chat, reports };
}

/** Polls a committed read until it holds. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let tries = 0; tries < 4000; tries++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for a condition');
}

/** The permanent log, each record as `kind: text`. */
async function logged(chat: OptChat): Promise<string[]> {
  const count = (await chat.harness.snapshot(MemoryDoc, chat.root.id, context))?.nextMessage ?? 0;
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const message = await chat.harness.snapshot(MessageDoc, chat.root.id, String(i), context);
    if (message) lines.push(`${message.kind}: ${message.text}`);
  }
  return lines;
}

/** The text blocks of a request's last user message. */
function lastUserTexts(request: ModelContext): string[] {
  const last = request.messages.findLast((message) => message.role === 'user');
  if (!last || last.role !== 'user') return [];
  return typeof last.content === 'string'
    ? [last.content]
    : last.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
}

test('a failed attempt pi-durable retries leaves only the final reply in memory', { timeout: 15000 }, async () => {
  let calls = 0;
  const { chat, reports } = await chatWith(() => {
    calls++;
    return calls === 1
      ? fauxAssistantMessage('PARTIAL', { stopReason: 'error', errorMessage: '503 overloaded' })
      : fauxAssistantMessage('  FINAL  ');
  });
  try {
    await chat.accept({ requestId: 'one', content: 'hello' });
    assert.equal((await waitForAnswer(chat, 'one')).status, 'done');
    assert.equal(calls, 2);
    // Trimmed, as UniiChat logs a reply; the retried try is dropped as UniiChat drops it.
    const lines = await until(() => logged(chat), (all) => all.includes('infinichat: FINAL'));
    assert.deepEqual(lines, ['user: hello', 'infinichat: FINAL']);
    assert.deepEqual(reports, []);
  } finally {
    await chat.close();
  }
});

test('a final failure logs what the attempt wrote, cut off, then the note that there is no reply', {
  timeout: 15000,
}, async () => {
  const seen: ModelContext[] = [];
  const { chat, reports } = await chatWith((request) => {
    seen.push(structuredClone(request));
    return seen.length === 1
      ? fauxAssistantMessage('PARTIAL', { stopReason: 'error', errorMessage: '400 invalid request.' })
      : fauxAssistantMessage('AGAIN OK');
  });
  try {
    await chat.accept({ requestId: 'one', content: 'hello' });
    const failed = await waitForAnswer(chat, 'one');
    assert.equal(failed.status, 'unanswered');
    const note = 'note: No reply: 400 invalid request. Send a message to try again.';
    const lines = await until(() => logged(chat), (all) => all.includes(note));
    assert.deepEqual(lines, ['user: hello', 'infinichat: PARTIAL\n[cut off: 400 invalid request.]', note]);
    // The next turn's view holds them, each line flattened.
    await chat.accept({ requestId: 'two', content: 'again' });
    assert.equal((await waitForAnswer(chat, 'two')).status, 'done');
    const view = lastUserTexts(seen[1])[0];
    assert.ok(view.includes('|infinichat: PARTIAL [cut off: 400 invalid request.]\n'));
    assert.ok(view.includes('|note: No reply: 400 invalid request. Send a message to try again.\n'));
    assert.deepEqual(reports, []);
  } finally {
    await chat.close();
  }
});

test('a reply cut at the output limit is logged with the note that there is no reply', { timeout: 15000 }, async () => {
  const { chat } = await chatWith(() => fauxAssistantMessage('CUT REPLY', { stopReason: 'length' }));
  try {
    await chat.accept({ requestId: 'one', content: 'hello' });
    await waitForAnswer(chat, 'one');
    const note = 'note: No reply: stopped: length. Send a message to try again.';
    assert.deepEqual(await until(() => logged(chat), (all) => all.includes(note)), [
      'user: hello', 'infinichat: CUT REPLY', note,
    ]);
  } finally {
    await chat.close();
  }
});

test('a stop logs what the turn wrote, cut off, then the stop note', { timeout: 15000 }, async () => {
  const { chat, reports } = await chatWith(() => fauxAssistantMessage(`STREAMED ${'word '.repeat(2000)}`), 100);
  try {
    await chat.accept({ requestId: 'one', content: 'hello' });
    // Stopped while the reply streams, once part of it is written.
    await until(
      () => chat.harness.snapshot(LiveDoc, chat.root.id, context),
      (live) => JSON.stringify(live?.generation?.message ?? {}).includes('STREAMED'),
    );
    await chat.abort();
    const note = 'note: Stopped by the user.';
    const lines = await until(() => logged(chat), (all) => all.includes(note));
    assert.equal(lines.length, 3);
    assert.equal(lines[0], 'user: hello');
    assert.ok(lines[1].startsWith('infinichat: STREAMED'));
    assert.ok(lines[1].endsWith('\n[cut off: stopped]'));
    assert.equal(lines[2], note);
    assert.deepEqual(reports, []);
  } finally {
    await chat.close();
  }
});

test('an input a failed run left queued starts a fresh turn and is answered', { timeout: 15000 }, async () => {
  let started = () => {};
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: ModelContext[] = [];
  const { chat, reports } = await chatWith(async (request) => {
    seen.push(structuredClone(request));
    if (seen.length > 1) return fauxAssistantMessage('ANSWER TWO');
    started();
    await gate;
    return fauxAssistantMessage('PARTIAL ONE', { stopReason: 'error', errorMessage: '400 bad request' });
  });
  try {
    await chat.accept({ requestId: 'one', content: 'one' });
    await began;
    // Sent while the turn runs: it waits in pi-durable's queue for the round to end.
    await chat.accept({ requestId: 'two', content: 'two' });
    await until(
      () => chat.harness.snapshot(InputDoc, chat.root.id, 'two', context),
      (stored) => stored?.value?.phase === 'submitted',
    );
    release();
    assert.equal((await waitForAnswer(chat, 'one')).status, 'unanswered');
    assert.equal((await waitForAnswer(chat, 'two')).status, 'done');
    const two = (await chat.harness.snapshot(InputDoc, chat.root.id, 'two', context))?.value;
    assert.equal(two?.attempt, 1);
    assert.equal(two?.fresh, true);
    assert.equal(two?.epoch, 2);
    // A fresh turn: reset, the view with the failed turn's end, then the turn head and the message.
    assert.equal(seen.length, 2);
    assert.equal(seen[1].messages.filter((message) => message.role === 'assistant').length, 0);
    const [view, head, words] = lastUserTexts(seen[1]);
    assert.ok(view.includes('|user: one\n'));
    assert.ok(view.includes('|infinichat: PARTIAL ONE [cut off: 400 bad request]\n'));
    assert.ok(view.includes('|note: No reply: 400 bad request. Send a message to try again.\n'));
    assert.equal(head, '\nYou are root. Your parent: the user (tell "user"). Your children: none.\n\n'
      + 'Turn: your new messages:\n\n');
    assert.equal(words, 'two');
    assert.deepEqual(await until(() => logged(chat), (all) => all.includes('infinichat: ANSWER TWO')), [
      'user: one',
      'infinichat: PARTIAL ONE\n[cut off: 400 bad request]',
      'note: No reply: 400 bad request. Send a message to try again.',
      'user: two',
      'infinichat: ANSWER TWO',
    ]);
    assert.deepEqual(reports, []);
  } finally {
    release();
    await chat.close();
  }
});

test('a stop keeps the note a turn left before it, its own after it', { timeout: 15000 }, async () => {
  let started = () => {};
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const { chat, reports } = await chatWith(async () => {
    calls++;
    if (calls > 1) return fauxAssistantMessage(`STREAMED ${'word '.repeat(2000)}`);
    started();
    await gate;
    return fauxAssistantMessage('CUT', { stopReason: 'length' });
  }, 100);
  try {
    await chat.accept({ requestId: 'one', content: 'one' });
    await began;
    await chat.accept({ requestId: 'two', content: 'two' });
    await until(
      () => chat.harness.snapshot(InputDoc, chat.root.id, 'two', context),
      (stored) => stored?.value?.phase === 'submitted',
    );
    // The reply cut at the output limit leaves its note, and the run goes on with what was sent meanwhile.
    release();
    await until(
      () => chat.harness.snapshot(LiveDoc, chat.root.id, context),
      (live) => JSON.stringify(live?.generation?.message ?? {}).includes('STREAMED'),
    );
    await chat.abort();
    const note = 'note: No reply: stopped: length. Send a message to try again.\nStopped by the user.';
    const lines = await until(() => logged(chat), (all) => all.includes(note));
    assert.deepEqual(lines.slice(0, 3), ['user: one', 'infinichat: CUT', 'user: two']);
    assert.ok(lines[3].startsWith('infinichat: STREAMED'));
    assert.ok(lines[3].endsWith('\n[cut off: stopped]'));
    assert.equal(lines[4], note);
    assert.equal(lines.length, 5);
    assert.deepEqual(reports, []);
  } finally {
    release();
    await chat.close();
  }
});

test('an input prepared for a turn that ended before its submission starts a fresh turn', {
  timeout: 15000,
}, async () => {
  const seen: ModelContext[] = [];
  const { chat, reports } = await chatWith((request) => {
    seen.push(structuredClone(request));
    return fauxAssistantMessage(`answer ${seen.length}`);
  });
  try {
    await chat.accept({ requestId: 'one', content: 'one' });
    assert.equal((await waitForAnswer(chat, 'one')).status, 'done');
    await until(() => logged(chat), (all) => all.includes('infinichat: answer 1'));
    // As the coordinator leaves an input it prepared for the running turn when the turn ends before the submission:
    // prepared to steer, with no native submission.
    await chat.root.commit(async (tx) => {
      const app = await tx.doc(AppDoc, chat.root.id);
      const stored = await tx.doc(InputDoc, chat.root.id, 'two', null);
      stored.value = {
        requestId: 'two', kind: 'user', content: 'two', date: new Date(0).toISOString(), epoch: app.epoch,
        fresh: false, phase: 'prepared', envelope: 'two', attempt: 0,
      };
      app.open = true;
      app.started = true;
      app.requests = ['one', 'two'];
      app.pending = ['two'];
      app.revision++;
    }, context);
    // No admission made that state, so nothing woke the agent for it.
    await wake(chat);
    assert.equal((await waitForAnswer(chat, 'two')).status, 'done');
    const two = (await chat.harness.snapshot(InputDoc, chat.root.id, 'two', context))?.value;
    assert.equal(two?.fresh, true);
    // Not the old turn's context but a fresh one: reset, the view, then the turn head and the message.
    assert.equal(seen.length, 2);
    assert.equal(seen[1].messages.filter((message) => message.role === 'assistant').length, 0);
    const [view, head, words] = lastUserTexts(seen[1]);
    assert.ok(view.includes('|user: one\n'));
    assert.ok(view.includes('|infinichat: answer 1\n'));
    assert.equal(head, '\nYou are root. Your parent: the user (tell "user"). Your children: none.\n\n'
      + 'Turn: your new messages:\n\n');
    assert.equal(words, 'two');
    assert.deepEqual(reports, []);
  } finally {
    await chat.close();
  }
});
