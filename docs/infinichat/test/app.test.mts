import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { MemoryStorage, configure, type ModelRef } from "@earendil-works/pi-durable";
import { openOptChat, AppDoc, InputDoc, type OptChat } from "../src/app.mjs";
import { MessageDoc, MemoryDoc } from "../src/memory.mjs";
import { ConfigDoc } from "../src/summary.mjs";

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
    const chat = await openOptChat(
      new MemoryStorage(),
      { models, hasDeviceTools: true },
      context,
    );
    try {
      await selectModels(chat, model);
      await chat.accept({
        requestId: "devices-one",
        content: "first",
        turnState: "Available device: mac",
      });
      await chat.waitForAnswer("devices-one");
      await chat.accept({
        requestId: "devices-two",
        content: "second",
        turnState: "Available device: linux",
      });
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
      assert.ok(
        text.indexOf("</chat>") < text.indexOf("Available device: linux"),
      );
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
