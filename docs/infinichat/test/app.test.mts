import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type Context as ModelContext,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { LiveDoc, MemoryStorage, configure, type ModelRef } from "@earendil-works/pi-durable";
import { openOptChat, AppDoc, InputDoc, type OptChat } from "../src/app.mjs";
import { MessageDoc, MemoryDoc } from "../src/memory.mjs";
import { ConfigDoc } from "../src/summary.mjs";
import { AgentDirectoryDoc, PrivateAgentDoc, agentWork } from "../src/agents.mjs";

const model = { provider: "faux", modelId: "faux-1" };
/** The host's one settings commit: main model through configure, summary model in ConfigDoc. */
async function selectModels(chat: OptChat, selected: ModelRef, summary: ModelRef = selected) {
  await chat.root.commit(async (tx) => {
    await configure(tx, chat.root.id, { model: selected });
    (await tx.doc(ConfigDoc, chat.root.id)).summary = { model: summary, thinkingLevel: "off" };
  }, context);
}
test(
  "two fresh turns retain only saved memory, append canonical originals once, notes never run",
  { timeout: 15000 },
  async () => {
    const seen: ModelContext[] = [];
    const faux = fauxProvider({
      models: [{ id: "faux-1", contextWindow: 100_000 }],
    });
    faux.setResponses(
      Array.from({ length: 20 }, () => (input: ModelContext) => {
        seen.push(structuredClone(input));
        return fauxAssistantMessage(`answer ${seen.length}`);
      }),
    );
    const models = createModels();
    models.setProvider(faux.provider);
    const reports: unknown[] = [];
    const chat = await openOptChat(
      new MemoryStorage(),
      { models, onReport: (e) => reports.push(e) },
      context,
    );
    try {
      await selectModels(chat, model);
      await chat.accept({ requestId: "one", content: "hello" });
      assert.equal((await chat.waitForAnswer("one")).status, "done");
      await chat.accept({ requestId: "two", content: "again" });
      assert.equal((await chat.waitForAnswer("two")).status, "done");
      assert.equal(seen.length, 2);
      const second = seen[1]!;
      assert.equal(
        second.messages.filter((x) => x.role === "assistant").length,
        0,
      );
      assert.match(JSON.stringify(second), /user: hello/);
      assert.match(JSON.stringify(second), /unii: answer 1/);
      assert.equal(
        (
          JSON.stringify(
            second.messages.filter((m) => m.role === "user"),
          ).match(/again/g) ?? []
        ).length,
        1,
      );
      await chat.accept({ requestId: "two", content: "again" });
      await chat.accept({
        requestId: "note",
        content: "imported older fact",
        kind: "note",
      });
      const noteWatch = (await chat.harness.watchDoc(
        InputDoc,
        chat.root.id,
        "note",
        context,
      ))!;
      await new Promise<void>((resolve) => {
        const inspect = (value: typeof noteWatch.value) => {
          if (value?.value?.phase === "submitted") resolve();
        };
        noteWatch.start(async (value) => {
          inspect(value);
        });
        inspect(noteWatch.value);
      });
      await noteWatch.stop();
      assert.equal(seen.length, 2);
      const memory = await chat.harness.snapshot(
        MemoryDoc,
        chat.root.id,
        context,
      );
      const messages = [];
      for (let i = 0; i < memory!.nextMessage; i++)
        messages.push(
          await chat.harness.snapshot(
            MessageDoc,
            chat.root.id,
            String(i),
            context,
          ),
        );
      assert.equal(messages.filter((m) => m?.text === "hello").length, 1);
      assert.equal(messages.filter((m) => m?.text === "again").length, 1);
      assert.equal(messages.filter((m) => m?.kind === "note").length, 1);
      assert.equal(
        (await chat.harness.snapshot(AppDoc, chat.root.id, context))!.epoch,
        2,
      );
      assert.deepEqual(reports, []);
    } finally {
      await chat.close();
    }
  },
);

test(
  "coordinator native fault surfaces instead of hanging pending answer",
  { timeout: 10000 },
  async () => {
    const faux = fauxProvider({
      models: [{ id: "faux-1", contextWindow: 100_000 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const chat = await openOptChat(new MemoryStorage(), { models }, context);
    try {
      await selectModels(chat, model);
      const app = (await chat.harness.snapshot(AppDoc, chat.root.id, context))!;
      await chat.harness.abortTask(app.coordinator!, context);
      await chat.harness.waitForTask(app.coordinator!, context);
      await chat.accept({
        requestId: "pending",
        content: "pending after stopped coordinator",
      });
      await assert.rejects(
        chat.waitForAnswer("pending"),
        /coordinator ended.*aborted/,
      );
    } finally {
      await chat.close();
    }
  },
);

test(
  "abort withdraws accepted queued input and allows a new fresh turn",
  { timeout: 10000 },
  async () => {
    const faux = fauxProvider({
      models: [{ id: "faux-1", contextWindow: 100_000 }],
    });
    faux.setResponses(
      Array.from({ length: 10 }, () => fauxAssistantMessage("answer")),
    );
    const models = createModels();
    models.setProvider(faux.provider);
    const chat = await openOptChat(new MemoryStorage(), { models }, context);
    try {
      await selectModels(chat, model);
      await chat.accept({
        requestId: "cancel-me",
        content: "withdrawn words never enter memory",
      });
      await chat.abort();
      const memory = (await chat.harness.snapshot(
        MemoryDoc,
        chat.root.id,
        context,
      ))!;
      const messages = [];
      for (let i = 0; i < memory.nextMessage; i++)
        messages.push(
          await chat.harness.snapshot(
            MessageDoc,
            chat.root.id,
            String(i),
            context,
          ),
        );
      assert.equal(
        messages.filter(
          (m) => m?.text === "withdrawn words never enter memory",
        ).length,
        0,
      );
      await chat.accept({ requestId: "after-stop", content: "continue now" });
      assert.equal((await chat.waitForAnswer("after-stop")).status, "done");
    } finally {
      await chat.close();
    }
  },
);

test(
  "dynamic device state stays after view and outside canonical text and static system",
  { timeout: 10000 },
  async () => {
    const seen: ModelContext[] = [];
    const faux = fauxProvider({
      models: [{ id: "faux-1", contextWindow: 100_000 }],
    });
    faux.setResponses(
      Array.from({ length: 5 }, () => (input: ModelContext) => {
        seen.push(structuredClone(input));
        return fauxAssistantMessage("ok");
      }),
    );
    const models = createModels();
    models.setProvider(faux.provider);
    // The host's turn state, read as each turn starts.
    let devices = "Devices open now:\n- mac";
    const chat = await openOptChat(
      new MemoryStorage(),
      { models, hasDeviceTools: true, turnState: async () => devices },
      context,
    );
    try {
      await selectModels(chat, model);
      await chat.accept({ requestId: "devices-one", content: "first" });
      await chat.waitForAnswer("devices-one");
      devices = "Devices open now:\n- linux";
      await chat.accept({ requestId: "devices-two", content: "second" });
      await chat.waitForAnswer("devices-two");
      const systems = seen.map((c) =>
        c.messages
          .filter((m) => m.role === "system")
          .map((m) => ({
            content: m.content,
            ...("sections" in m ? { sections: m.sections } : {}),
          })),
      );
      assert.deepEqual(systems[0], systems[1]);
      const input = seen[1]!.messages.find((m) => m.role === "user")!;
      const text =
        typeof input.content === "string"
          ? input.content
          : input.content
              .filter((x) => x.type === "text")
              .map((x) => x.text)
              .join("");
      // The view, the turn state, the agents at work, then the head that tells a turn from a compaction.
      const order = [
        "</chat>",
        "- linux",
        "Agents at work now: none.",
        "Turn: the user's new message:\n\nsecond",
      ].map((part) => text.indexOf(part));
      assert.ok(order.every((at, i) => at >= 0 && (i === 0 || order[i - 1] < at)));
      assert.ok(!text.includes("- mac"));
      assert.ok(!text.includes("<turn"));
      const first = await chat.harness.snapshot(
        MessageDoc,
        chat.root.id,
        "0",
        context,
      );
      assert.equal(first!.text, "first");
    } finally {
      await chat.close();
    }
  },
);

test("earlier application and input documents migrate as pi-durable reads them", () => {
  const v2 = {
    promptVersion: 2, epoch: 4, open: false, started: false, requests: [], pending: [], cursor: null,
    coordinator: null, revision: 9, stop: 1, stopped: 1, stopPending: [],
  };
  // Version 2 logged a call with its assistant message, so none waits for its result, and noted no stop.
  assert.deepEqual(AppDoc.definition.migrate?.(v2, 2), { ...v2, endNote: null, held: {}, cut: null });
  const { promptVersion: _current, ...v1 } = v2;
  assert.equal(AppDoc.definition.migrate?.(v1, 1)?.promptVersion, 1);
  // Version 3's stop note is the turn's end note, and it held no cut attempt.
  const held = { call: { text: "zoom {\"id\":0}", date: "d", source: "e:0" } };
  const v3 = { ...v2, stopNote: "Stopped by the user: OptChat's turn.", held };
  assert.deepEqual(AppDoc.definition.migrate?.(v3, 3), {
    ...v2, endNote: "Stopped by the user: OptChat's turn.", held, cut: null,
  });
  const admission = {
    requestId: "a", kind: "user", content: "hi", date: "d", epoch: 1, fresh: true, phase: "submitted", envelope: null,
  } as const;
  // Versions 1 and 2 submitted each input once: its first attempt.
  assert.deepEqual(
    InputDoc.definition.migrate?.({ value: { ...admission, turnState: "Devices" } }, 1),
    { value: { ...admission, attempt: 0 } },
  );
  assert.deepEqual(InputDoc.definition.migrate?.({ value: admission }, 2), { value: { ...admission, attempt: 0 } });
  assert.deepEqual(InputDoc.definition.migrate?.({ value: null }, 2), { value: null });
});

/** Storage that outlives the Harness closing it, as the app's database outlives a restart. */
class KeptStorage extends MemoryStorage {
  override async close(): Promise<void> {}
}

test("a conversation that stored its first tool list is offered the tools added since", async () => {
  const storage = new KeptStorage();
  const models = createModels();
  const offered = async (chat: OptChat) => (await chat.root.agent(context)).tools.map((tool) => tool.name);
  const before = await openOptChat(storage, { models }, context);
  try {
    // Version 1 stored the tools the conversation was created with, which had no spawn or tell.
    const first = (await before.root.agent(context)).tools.filter((t) => t.name !== "spawn" && t.name !== "tell");
    await before.root.commit(async (tx) => {
      await configure(tx, before.root.id, { modelTools: first });
      await before.setInstructions(tx, "The user's own text");
      (await tx.doc(AppDoc, before.root.id)).promptVersion = 2;
    }, context);
    assert.ok(!(await offered(before)).includes("spawn"));
  } finally {
    await before.close();
  }
  const after = await openOptChat(storage, { models }, context);
  try {
    assert.ok((await offered(after)).includes("spawn") && (await offered(after)).includes("tell"));
    assert.equal((await after.root.agent(context)).instructions, "The user's own text");
  } finally {
    await after.close();
  }
});

/** OptChat over one scripted model, its main and summary model selected. */
async function chatWith(route: FauxResponseStep, tokensPerSecond?: number) {
  const faux = fauxProvider({
    models: [{ id: "faux-1", contextWindow: 100_000 }],
    ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
  });
  faux.setResponses(Array.from({ length: 40 }, () => route));
  const models = createModels();
  models.setProvider(faux.provider);
  const reports: unknown[] = [];
  const chat = await openOptChat(new MemoryStorage(), { models, onReport: (e) => reports.push(e) }, context);
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
  throw new Error("Timed out waiting for a condition");
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
  const last = request.messages.findLast((message) => message.role === "user");
  if (!last || last.role !== "user") return [];
  return typeof last.content === "string"
    ? [last.content]
    : last.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
}

test("a failed attempt pi-durable retries leaves only the final reply in memory", { timeout: 15000 }, async () => {
  let calls = 0;
  const { chat, reports } = await chatWith(() => {
    calls++;
    return calls === 1
      ? fauxAssistantMessage("PARTIAL", { stopReason: "error", errorMessage: "503 overloaded" })
      : fauxAssistantMessage("  FINAL  ");
  });
  try {
    await chat.accept({ requestId: "one", content: "hello" });
    assert.equal((await chat.waitForAnswer("one")).status, "done");
    assert.equal(calls, 2);
    // Trimmed, as UniiChat logs a reply; the retried try is dropped as UniiChat drops it.
    const lines = await until(() => logged(chat), (all) => all.includes("unii: FINAL"));
    assert.deepEqual(lines, ["user: hello", "unii: FINAL"]);
    assert.deepEqual(reports, []);
  } finally {
    await chat.close();
  }
});

test("a final failure logs what the attempt wrote, cut off, then the note that there is no reply", {
  timeout: 15000,
}, async () => {
  const seen: ModelContext[] = [];
  const { chat, reports } = await chatWith((request) => {
    seen.push(structuredClone(request));
    return seen.length === 1
      ? fauxAssistantMessage("PARTIAL", { stopReason: "error", errorMessage: "400 invalid request." })
      : fauxAssistantMessage("AGAIN OK");
  });
  try {
    await chat.accept({ requestId: "one", content: "hello" });
    const failed = await chat.waitForAnswer("one");
    assert.equal(failed.status, "unanswered");
    const note = "note: No reply: 400 invalid request. Send a message to try again.";
    const lines = await until(() => logged(chat), (all) => all.includes(note));
    assert.deepEqual(lines, ["user: hello", "unii: PARTIAL\n[cut off: 400 invalid request.]", note]);
    // The next turn's view holds them, each line flattened.
    await chat.accept({ requestId: "two", content: "again" });
    assert.equal((await chat.waitForAnswer("two")).status, "done");
    const view = lastUserTexts(seen[1])[0];
    assert.ok(view.includes("|unii: PARTIAL [cut off: 400 invalid request.]\n"));
    assert.ok(view.includes("|note: No reply: 400 invalid request. Send a message to try again.\n"));
    assert.deepEqual(reports, []);
  } finally {
    await chat.close();
  }
});

test("a reply cut at the output limit is logged with the note that there is no reply", { timeout: 15000 }, async () => {
  const { chat } = await chatWith(() => fauxAssistantMessage("CUT REPLY", { stopReason: "length" }));
  try {
    await chat.accept({ requestId: "one", content: "hello" });
    await chat.waitForAnswer("one");
    const note = "note: No reply: stopped: length. Send a message to try again.";
    assert.deepEqual(await until(() => logged(chat), (all) => all.includes(note)), [
      "user: hello", "unii: CUT REPLY", note,
    ]);
  } finally {
    await chat.close();
  }
});

test("a stop logs what the turn wrote, cut off, then the stop note", { timeout: 15000 }, async () => {
  const { chat, reports } = await chatWith(() => fauxAssistantMessage(`STREAMED ${"word ".repeat(2000)}`), 100);
  try {
    await chat.accept({ requestId: "one", content: "hello" });
    // Stopped while the reply streams, once part of it is written.
    await until(
      () => chat.harness.snapshot(LiveDoc, chat.root.id, context),
      (live) => JSON.stringify(live?.generation?.message ?? {}).includes("STREAMED"),
    );
    await chat.abort();
    const note = "note: Stopped by the user: OptChat's turn.";
    const lines = await until(() => logged(chat), (all) => all.includes(note));
    assert.equal(lines.length, 3);
    assert.equal(lines[0], "user: hello");
    assert.ok(lines[1].startsWith("unii: STREAMED"));
    assert.ok(lines[1].endsWith("\n[cut off: stopped]"));
    assert.equal(lines[2], note);
    assert.deepEqual(reports, []);
  } finally {
    await chat.close();
  }
});

test("an input a failed run left queued starts a fresh turn and is answered", { timeout: 15000 }, async () => {
  let started = () => {};
  const began = new Promise<void>((resolve) => { started = resolve; });
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const seen: ModelContext[] = [];
  const { chat, reports } = await chatWith(async (request) => {
    seen.push(structuredClone(request));
    if (seen.length > 1) return fauxAssistantMessage("ANSWER TWO");
    started();
    await gate;
    return fauxAssistantMessage("PARTIAL ONE", { stopReason: "error", errorMessage: "400 bad request" });
  });
  try {
    await chat.accept({ requestId: "one", content: "one" });
    await began;
    // Sent while the turn runs: it waits in pi-durable's queue for the round to end.
    await chat.accept({ requestId: "two", content: "two" });
    await until(
      () => chat.harness.snapshot(InputDoc, chat.root.id, "two", context),
      (stored) => stored?.value?.phase === "submitted",
    );
    release();
    assert.equal((await chat.waitForAnswer("one")).status, "unanswered");
    assert.equal((await chat.waitForAnswer("two")).status, "done");
    const two = (await chat.harness.snapshot(InputDoc, chat.root.id, "two", context))?.value;
    assert.equal(two?.attempt, 1);
    assert.equal(two?.fresh, true);
    assert.equal(two?.epoch, 2);
    // A fresh turn: reset, the view with the failed turn's end, then the turn head and the message.
    assert.equal(seen.length, 2);
    assert.equal(seen[1].messages.filter((message) => message.role === "assistant").length, 0);
    const [view, head, words] = lastUserTexts(seen[1]);
    assert.ok(view.includes("|user: one\n"));
    assert.ok(view.includes("|unii: PARTIAL ONE [cut off: 400 bad request]\n"));
    assert.ok(view.includes("|note: No reply: 400 bad request. Send a message to try again.\n"));
    assert.equal(head, "\nAgents at work now: none.\n\nTurn: the user's new message:\n\n");
    assert.equal(words, "two");
    assert.deepEqual(await until(() => logged(chat), (all) => all.includes("unii: ANSWER TWO")), [
      "user: one",
      "unii: PARTIAL ONE\n[cut off: 400 bad request]",
      "note: No reply: 400 bad request. Send a message to try again.",
      "user: two",
      "unii: ANSWER TWO",
    ]);
    assert.deepEqual(reports, []);
  } finally {
    release();
    await chat.close();
  }
});

test("Stop ends the agents at work, whose reports are logged with no turn", { timeout: 15000 }, async () => {
  const isSubagent = (request: ModelContext) =>
    JSON.stringify(request.messages).includes("You are a subagent of OptChat");
  let mainRequests = 0;
  let working = () => {};
  const atWork = new Promise<void>((resolve) => { working = resolve; });
  const { chat, reports } = await chatWith((request) => {
    if (isSubagent(request)) {
      working();
      return fauxAssistantMessage(`SLOW ${"word ".repeat(4000)}`);
    }
    mainRequests++;
    if (request.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("Started.");
    return fauxAssistantMessage([fauxToolCall("spawn", { tasks: ["Slow job"] })], { stopReason: "toolUse" });
  }, 200);
  try {
    await chat.accept({ requestId: "go", content: "Start an agent." });
    assert.equal((await chat.waitForAnswer("go")).status, "done");
    await atWork;
    const [name] = (await chat.harness.snapshot(AgentDirectoryDoc, chat.root.id, context))?.names ?? [];
    assert.ok(name);
    const before = mainRequests;
    await chat.abort();
    const note = `note: Stopped by the user: ${name}.`;
    const report = `work: [${name}]\nfailed: stopped\n\nFull chat: zoom("${name}")`;
    const lines = await until(() => logged(chat), (all) => all.includes(note) && all.includes(report));
    assert.equal(lines.filter((line) => line.startsWith("work: ")).length, 1);
    assert.deepEqual(await chat.harness.commit((tx) => agentWork(tx, chat.root.id), context), []);
    const agent = await chat.harness.snapshot(PrivateAgentDoc, chat.root.id, name, context);
    assert.ok(agent?.conversationId);
    assert.equal((await chat.harness.snapshot(LiveDoc, agent.conversationId, context))?.run, undefined);
    // Logged, not admitted: no turn answers it.
    const at = lines.indexOf(report);
    const record = await chat.harness.snapshot(MessageDoc, chat.root.id, String(at), context);
    const requestId = record?.source.replace(/^input:/, "") ?? "";
    assert.match(requestId, /^optchat:agent:\d+:report$/);
    assert.equal((await chat.harness.snapshot(InputDoc, chat.root.id, requestId, context))?.value ?? null, null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(mainRequests, before);
    assert.deepEqual(reports, []);
  } finally {
    await chat.close();
  }
});

test("a stop keeps the note a turn left before it, its own after it", { timeout: 15000 }, async () => {
  let started = () => {};
  const began = new Promise<void>((resolve) => { started = resolve; });
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const { chat, reports } = await chatWith(async () => {
    calls++;
    if (calls > 1) return fauxAssistantMessage(`STREAMED ${"word ".repeat(2000)}`);
    started();
    await gate;
    return fauxAssistantMessage("CUT", { stopReason: "length" });
  }, 100);
  try {
    await chat.accept({ requestId: "one", content: "one" });
    await began;
    await chat.accept({ requestId: "two", content: "two" });
    await until(
      () => chat.harness.snapshot(InputDoc, chat.root.id, "two", context),
      (stored) => stored?.value?.phase === "submitted",
    );
    // The reply cut at the output limit leaves its note, and the run goes on with what was sent meanwhile.
    release();
    await until(
      () => chat.harness.snapshot(LiveDoc, chat.root.id, context),
      (live) => JSON.stringify(live?.generation?.message ?? {}).includes("STREAMED"),
    );
    await chat.abort();
    const note = "note: No reply: stopped: length. Send a message to try again.\nStopped by the user: OptChat's turn.";
    const lines = await until(() => logged(chat), (all) => all.includes(note));
    assert.deepEqual(lines.slice(0, 3), ["user: one", "unii: CUT", "user: two"]);
    assert.ok(lines[3].startsWith("unii: STREAMED"));
    assert.ok(lines[3].endsWith("\n[cut off: stopped]"));
    assert.equal(lines[4], note);
    assert.equal(lines.length, 5);
    assert.deepEqual(reports, []);
  } finally {
    release();
    await chat.close();
  }
});

test("an input prepared for a turn that ended before its submission starts a fresh turn", {
  timeout: 15000,
}, async () => {
  const seen: ModelContext[] = [];
  const { chat, reports } = await chatWith((request) => {
    seen.push(structuredClone(request));
    return fauxAssistantMessage(`answer ${seen.length}`);
  });
  try {
    await chat.accept({ requestId: "one", content: "one" });
    assert.equal((await chat.waitForAnswer("one")).status, "done");
    await until(() => logged(chat), (all) => all.includes("unii: answer 1"));
    // As the coordinator leaves an input it prepared for the running turn when the turn ends before the submission:
    // prepared to steer, with no native submission.
    await chat.root.commit(async (tx) => {
      const app = await tx.doc(AppDoc, chat.root.id);
      const stored = await tx.doc(InputDoc, chat.root.id, "two", null);
      stored.value = {
        requestId: "two", kind: "user", content: "two", date: new Date(0).toISOString(), epoch: app.epoch,
        fresh: false, phase: "prepared", envelope: "two", attempt: 0,
      };
      app.open = true;
      app.started = true;
      app.requests = ["one", "two"];
      app.pending = ["two"];
      app.revision++;
    }, context);
    assert.equal((await chat.waitForAnswer("two")).status, "done");
    const two = (await chat.harness.snapshot(InputDoc, chat.root.id, "two", context))?.value;
    assert.equal(two?.fresh, true);
    // Not the old turn's context but a fresh one: reset, the view, then the turn head and the message.
    assert.equal(seen.length, 2);
    assert.equal(seen[1].messages.filter((message) => message.role === "assistant").length, 0);
    const [view, head, words] = lastUserTexts(seen[1]);
    assert.ok(view.includes("|user: one\n"));
    assert.ok(view.includes("|unii: answer 1\n"));
    assert.equal(head, "\nAgents at work now: none.\n\nTurn: the user's new message:\n\n");
    assert.equal(words, "two");
    assert.deepEqual(reports, []);
  } finally {
    await chat.close();
  }
});
