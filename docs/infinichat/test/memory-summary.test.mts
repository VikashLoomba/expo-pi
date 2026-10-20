import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  type HarnessSettings,
} from "@earendil-works/pi-durable";
import {
  MemoryDoc,
  MessageDoc,
  NodeDoc,
  appendMessage,
  renderMain,
  renderCompaction,
  moreDue,
  advanceMessageProgress,
  clipToolText,
  viewBytes,
  type NodeRef,
} from "../src/memory.mjs";
import { BuildNode, BuildScratchDoc, ConfigDoc, prefixUtf8, pumpBuilds } from "../src/summary.mjs";
async function fixture(settings?: HarnessSettings) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(
    defineExtension({ name: "memory-tests", tasks: [BuildNode] }),
  );
  const h = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings },
    ctx,
  );
  const model = { provider: "faux", modelId: faux.getModel().id };
  const root = await h.root(ctx, {
    agent: { instructions: "Shared static system" },
    init: async (tx, id) => {
      await tx.doc(MemoryDoc, id);
      (await tx.doc(ConfigDoc, id)).summary = { model, thinkingLevel: "off" };
    },
  });
  const add = async (text: string, kind: "user" | "echo" = "user") =>
    h.commit(
      (tx) =>
        appendMessage(tx, root.id, {
          kind,
          text,
          date: "2026-10-15",
          source: "test",
          images: [],
        }),
      ctx,
    );
  const pump = async () => h.commit((tx) => pumpBuilds(tx, root.id), ctx);
  const drain = async () => {
    for (;;) {
      const ids = await pump();
      if (!ids.length) return;
      await Promise.all(ids.map((id) => h.waitForTask(id, ctx)));
    }
  };
  return { h, root, faux, add, pump, drain };
}
test("native tasks build exact leaves/parents; references persist and context excludes future", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 10; i++) await f.add(`message ${i}`);
    await f.drain();
    assert.equal(f.faux.state.callCount, 0);
    // A merge's input is its two lines, each flattened, as UniiChat's is.
    const lines = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => `user: message ${from + i}`).join(" ");
    assert.equal(
      (await f.h.snapshot(NodeDoc, f.root.id, "3:0", ctx))?.value?.text,
      `${lines(0, 4)}\n${lines(4, 4)}`,
    );
    const s = await f.h.snapshot(MemoryDoc, f.root.id, ctx);
    assert.equal(s?.frontier, 10);
    assert.equal(s?.viewThrough, 10);
    assert.equal(s?.main.refs.length, 10);
    assert.equal(s?.pendingLeaves.length, 0);
    assert.equal(s?.readyParents.length, 0);
    const view = await f.h.commit((tx) => renderMain(tx, f.root.id), ctx);
    assert.ok(view.includes("9+1|user: message 9"));
    const cut = await f.h.commit(
      (tx) => renderCompaction(tx, f.root.id, 4),
      ctx,
    );
    assert.ok(cut.includes("3+1|"));
    assert.ok(!cut.includes("4+1|"));
    assert.equal(moreDue([0, 8], [2, 0], 10), true);
  } finally {
    await f.h.close(ctx);
  }
});
test("lossless scalar chunking and exact complete echo clipping", async () => {
  const f = await fixture();
  try {
    const text = "😀".repeat(30001);
    const ids = await f.add(text);
    assert.equal(ids.length, 2);
    const a = await f.h.snapshot(MessageDoc, f.root.id, String(ids[0]), ctx),
      b = await f.h.snapshot(MessageDoc, f.root.id, String(ids[1]), ctx);
    assert.equal(a!.text + b!.text, text);
    assert.equal(a!.bytes, 120000);
    // UniiChat's clip: half the limit from the head, the tail 64 less, and the marker counts what it cut.
    const clipped = clipToolText(text);
    assert.equal(clipped, "😀".repeat(15000) + "\n[... 65 characters cut ...]\n" + "😀".repeat(14936));
    assert.ok(Array.from(clipped).length <= 30000);
    assert.equal(clipToolText("😀".repeat(30000)), "😀".repeat(30000));
  } finally {
    await f.h.close(ctx);
  }
});
test("five native responses retain shortest, resend only the last line's size note, freeze cutoff", async () => {
  const f = await fixture();
  try {
    await f.add("old");
    await f.drain();
    await f.add("source ".repeat(200));
    const seen: TranscriptContext[] = [];
    f.faux.setResponses(
      [350, 330, 300, 340, 320].map((n, i) => async (request) => {
        seen.push(structuredClone(request));
        if (i === 0) await f.add("FUTURE MUST NOT LEAK");
        return fauxAssistantMessage([
          { type: "thinking", thinking: "reasoning", thinkingSignature: "sig" },
          fauxText("é".repeat(n)),
        ]);
      }),
    );
    const ids = await f.pump();
    await Promise.all(ids.map((id) => f.h.waitForTask(id, ctx)));
    const n = (await f.h.snapshot(NodeDoc, f.root.id, "0:1", ctx))?.value;
    assert.equal(n?.bytes, 600);
    assert.equal(seen.length, 5);
    assert.deepEqual(seen[0]!.messages[0], {
      role: "system",
      content: "",
      sections: {
        instructions: "<instructions>\nShared static system\n</instructions>",
      },
      toolsAdded: [],
      timestamp: 0,
    });
    assert.ok(!JSON.stringify(seen).includes("FUTURE MUST NOT LEAK"));
    // Never a try's words or thoughts: each retry is the view, the task and one note on the last line.
    for (const request of seen.slice(1)) {
      assert.equal(request.messages.length, 2);
      assert.ok(!JSON.stringify(request).includes("reasoning"));
    }
    assert.ok(JSON.stringify(seen[1]).includes("your last line for this <input> was 700 bytes"));
    assert.ok(JSON.stringify(seen[2]).includes("was 660 bytes"));
    assert.ok(!JSON.stringify(seen[2]).includes("700 bytes"));
  } finally {
    await f.h.close(ctx);
  }
});
test("with the Harness's retries off, failed leaves keep their places until the next message", async () => {
  const f = await fixture({ retry: { enabled: false } });
  try {
    for (let i = 0; i < 70; i++) await f.add("long ".repeat(200));
    f.faux.setResponses(
      Array.from({ length: 64 }, () => () => {
        throw new Error("offline");
      }),
    );
    const ids = await f.pump();
    assert.equal(ids.length, 64);
    await Promise.all(ids.map((id) => f.h.waitForTask(id, ctx)));
    // Released, not retried: the 65th leaf stays outside the window the failed ones hold.
    assert.equal((await f.pump()).length, 0);
    const s = await f.h.snapshot(MemoryDoc, f.root.id, ctx);
    assert.equal(s?.frontier, 0);
    assert.equal(s?.pendingLeaves.length, 70);
    await f.h.commit((tx) => advanceMessageProgress(tx, f.root.id), ctx);
    f.faux.setResponses(
      Array.from({ length: 64 }, () =>
        fauxAssistantMessage([fauxText("fixed")]),
      ),
    );
    const retried = await f.pump();
    assert.equal(retried.length, 64);
    await Promise.all(retried.map((id) => f.h.waitForTask(id, ctx)));
    assert.equal((await f.h.snapshot(MemoryDoc, f.root.id, ctx))?.frontier, 64);
  } finally {
    await f.h.close(ctx);
  }
});
test("64 builds start at once, up to the 64th unbuilt leaf, in message order, a merge first at a tie", async () => {
  const f = await fixture();
  try {
    // Two long messages built: their merge's context ends where the next leaf's does.
    await f.add("first ".repeat(200));
    await f.add("second ".repeat(200));
    f.faux.setResponses([fauxAssistantMessage("a".repeat(300)), fauxAssistantMessage("b".repeat(300))]);
    const leaves = await f.pump();
    await Promise.all(leaves.map((id) => f.h.waitForTask(id, ctx)));
    assert.deepEqual((await f.h.snapshot(MemoryDoc, f.root.id, ctx))?.readyParents, [[1, 0]]);
    for (let i = 0; i < 70; i++) await f.add("long ".repeat(200));
    f.faux.setResponses(Array.from({ length: 64 }, () => fauxAssistantMessage([fauxText("built")])));
    const ids = await f.pump();
    assert.equal(ids.length, 64);
    const s = await f.h.snapshot(MemoryDoc, f.root.id, ctx);
    const refOf = new Map(Object.entries(s?.active ?? {}).map(([k, id]) => [id, k]));
    const started = ids.map((id) => refOf.get(id));
    assert.deepEqual(started, ["1:0", ...Array.from({ length: 63 }, (_, i) => `0:${i + 2}`)]);
    assert.equal((await f.pump()).length, 0);
    await Promise.all(ids.map((id) => f.h.waitForTask(id, ctx)));
  } finally {
    await f.h.close(ctx);
  }
});
test("a merge's input is each line flattened, as UniiChat's is", async () => {
  const f = await fixture();
  try {
    await f.add("line one\n  line two");
    await f.add("line three");
    await f.drain();
    assert.equal(f.faux.state.callCount, 0);
    assert.equal((await f.h.snapshot(NodeDoc, f.root.id, "0:0", ctx))?.value?.text, "user: line one\n  line two");
    assert.equal(
      (await f.h.snapshot(NodeDoc, f.root.id, "1:0", ctx))?.value?.text,
      "user: line one line two\nuser: line three",
    );
    const view = await f.h.commit((tx) => renderMain(tx, f.root.id), ctx);
    assert.ok(view.includes("0+1|user: line one line two\n"));
  } finally {
    await f.h.close(ctx);
  }
});
test("sawtooth views measure their lines' UTF-8 text and preserve prefixes between batches", async () => {
  const f = await fixture();
  try {
    f.faux.setResponses(
      Array.from({ length: 600 }, () =>
        fauxAssistantMessage([fauxText("s".repeat(500))]),
      ),
    );
    let prior = "";
    let batched = false;
    for (let i = 0; i < 270; i++) {
      await f.add("m".repeat(490));
      await f.drain();
      const view = await f.h.commit((tx) => renderMain(tx, f.root.id), ctx);
      const state = (await f.h.snapshot(MemoryDoc, f.root.id, ctx))!;
      if (i < 250 && prior) {
        assert.ok(view.startsWith(prior.slice(0, -8)));
      }
      if (state.main.refs.length < i + 1) batched = true;
      // As UniiChat counts a view: its lines' text, without heads, newlines or tags.
      const size = (refs: NodeRef[]) => f.h.commit((tx) => viewBytes(tx, f.root.id, refs), ctx);
      assert.ok((await size(state.main.refs)) <= 128000);
      assert.ok((await size(state.compact.refs)) <= 32000);
      prior = view;
    }
    assert.equal(batched, true);
    const state = (await f.h.snapshot(MemoryDoc, f.root.id, ctx))!;
    assert.ok(state.main.refs.length < 200);
    assert.ok(state.compact.refs.length < 64);
  } finally {
    await f.h.close(ctx);
  }
});

test("a cut reply publishes the source, newlines flattened, cut to 512 bytes", async () => {
  const f = await fixture();
  try {
    await f.add("source\n".repeat(200));
    const partial = fauxAssistantMessage([fauxText("unfinished summary")]);
    partial.stopReason = "length";
    f.faux.setResponses([partial]);
    const [id] = await f.pump();
    assert.ok(id);
    const settled = await f.h.waitForTask(id, ctx);
    assert.equal(settled.state.outcome.status, "completed");
    const flat = ("user: " + "source\n".repeat(200)).replace(/\s*\n\s*/g, " ");
    assert.equal(
      (await f.h.snapshot(NodeDoc, f.root.id, "0:0", ctx))?.value?.text,
      prefixUtf8(flat, 512),
    );
    assert.equal(f.faux.state.callCount, 1);
  } finally {
    await f.h.close(ctx);
  }
});

test("a provider's failure that is not the model's own waits and asks again, never clipping the source", async () => {
  const f = await fixture({ retry: { baseDelayMs: 1, maxRetries: 0 } });
  try {
    await f.add("source ".repeat(200));
    // A thrown error and a missing credential, as UniiChat's patient calls ask again till one is answered.
    f.faux.setResponses([
      () => {
        throw new Error("offline");
      },
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "No API key for provider: faux" }),
      fauxAssistantMessage([fauxText("summary")]),
    ]);
    const [id] = await f.pump();
    assert.ok(id);
    assert.equal((await f.h.waitForTask(id, ctx)).state.outcome.status, "completed");
    assert.equal((await f.h.snapshot(NodeDoc, f.root.id, "0:0", ctx))?.value?.text, "summary");
    assert.equal(f.faux.state.callCount, 3);
  } finally {
    await f.h.close(ctx);
  }
});

test("an unavailable summary model waits to be asked again rather than failing", async () => {
  const f = await fixture({ retry: { baseDelayMs: 1, maxRetries: 0 } });
  try {
    await f.h.commit(async (tx) => {
      (await tx.doc(ConfigDoc, f.root.id)).summary = {
        model: { provider: "faux", modelId: "missing" },
        thinkingLevel: "off",
      };
    }, ctx);
    await f.add("source ".repeat(200));
    const [id] = await f.pump();
    assert.ok(id);
    f.h.resume();
    for (let tries = 0; ; tries++) {
      const checkpoint = (await f.h.getTask(id, ctx))?.state.checkpoint;
      const retries = typeof checkpoint === "object" && checkpoint !== null && !Array.isArray(checkpoint)
        ? checkpoint.retries
        : undefined;
      if (typeof retries === "number" && retries >= 3) break;
      assert.ok(tries < 2000, "the build never asked again");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal((await f.h.snapshot(NodeDoc, f.root.id, "0:0", ctx))?.value ?? null, null);
    assert.equal(f.faux.state.callCount, 0);
  } finally {
    await f.h.close(ctx);
  }
});

test("a retryable provider error waits pi-ai's backoff and asks again past pi-durable's bound", async () => {
  const f = await fixture({ retry: { baseDelayMs: 1, maxRetries: 0 } });
  try {
    await f.add("source ".repeat(200));
    const overloaded = () =>
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded" });
    f.faux.setResponses([overloaded(), overloaded(), fauxAssistantMessage([fauxText("summary")])]);
    const [id] = await f.pump();
    assert.ok(id);
    const settled = await f.h.waitForTask(id, ctx);
    assert.equal(settled.state.outcome.status, "completed");
    assert.equal(
      (await f.h.snapshot(NodeDoc, f.root.id, "0:0", ctx))?.value?.text,
      "summary",
    );
    assert.equal(f.faux.state.callCount, 3);
  } finally {
    await f.h.close(ctx);
  }
});

test("an earlier memory, build scratch and checkpoint migrate as pi-durable reads them", () => {
  const memory = {
    nextMessage: 3, frontier: 2, viewThrough: 2, revision: 7, messageProgress: 3, pendingLeaves: [2],
    readyParents: [[1, 0]], active: {}, failed: {}, main: { refs: [[1, 0]], reducing: false },
    compact: { refs: [[1, 0]], reducing: false },
  };
  // Version 1 took leaves and parents in turn.
  assert.deepEqual(MemoryDoc.definition.migrate?.({ ...memory, nextQueue: "parent" }, 1), memory);
  const scratch = { source: "s", task: "t", view: "v", selection: null, shortest: "b" };
  // The next try needs only the last too-long line.
  assert.deepEqual(
    BuildScratchDoc.definition.migrate?.({ ...scratch, replies: [{ text: "a" }, { text: "b" }] }, 1),
    { ...scratch, last: "b" },
  );
  assert.deepEqual(BuildScratchDoc.definition.migrate?.({ ...scratch, replies: [] }, 1), { ...scratch, last: null });
  assert.deepEqual(
    BuildNode.definition.migrate?.({ ref: [0, 1] }, { phase: "request", attempt: 2 }, 1)?.checkpoint,
    { phase: "request", attempt: 2, retries: 0 },
  );
});
