import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { MemoryStorage, configure } from "@earendil-works/pi-durable";
import {
  openOptChat,
  ConfigDoc,
  MessageDoc,
  MemoryDoc,
} from "../src/index.mjs";

// The same real native Harness, tasks, documents and tools as the production host.
// Only the model provider and physical storage are replaced for this offline demo.
const provider = fauxProvider({
  models: [{ id: "offline", contextWindow: 100_000 }],
});
provider.setResponses([
  fauxAssistantMessage("I will remember your project is a weather station."),
  fauxAssistantMessage("Your project is a weather station."),
]);
const models = createModels();
models.setProvider(provider.provider);
const model = { provider: "faux", modelId: "offline" };
const chat = await openOptChat(new MemoryStorage(), { models }, context);
try {
  // The host selects the main model with pi-durable's configure and the summary model in ConfigDoc, in one commit.
  await chat.root.commit(async (tx) => {
    await configure(tx, chat.root.id, { model });
    (await tx.doc(ConfigDoc, chat.root.id)).summary = {
      model,
      thinkingLevel: "off",
    };
  }, context);
  await chat.accept({
    requestId: "project",
    content: "My project is a weather station.",
  });
  await chat.waitForAnswer("project");
  await chat.accept({ requestId: "recall", content: "What is my project?" });
  const answer = await chat.waitForAnswer("recall");
  console.log("Native answer receipt:", answer.status);
  const transcript = await chat.root.context(context);
  const final = transcript.messages.filter(message => message.role === "assistant").at(-1);
  if (final?.role === "assistant") {
    console.log("Answer:", final.content
      .filter(block => block.type === "text").map(block => block.text).join(""));
  }
  // The native answer is durable before asynchronous semantic projection catches up.

  const memory = await chat.harness.snapshot(MemoryDoc, chat.root.id, context);
  for (let i = 0; i < (memory?.nextMessage ?? 0); i++) {
    const message = await chat.harness.snapshot(
      MessageDoc,
      chat.root.id,
      String(i),
      context,
    );
    if (message) console.log(`${message.i} ${message.kind}: ${message.text}`);
  }
} finally {
  await chat.close();
}
