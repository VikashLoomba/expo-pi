/** Opt-in paid-provider host. This file is compiled, not executed by tests.
 * Environment: ANTHROPIC_API_KEY, OPTCHAT_MODEL, OPTCHAT_SUMMARY_MODEL.
 * Model IDs must be available in the pinned provider catalog.
 * Invocation: node dist/examples/anthropic-node.mjs ./chat "Your message"
 */
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { configure } from "@earendil-works/pi-durable";
import { openOptChat } from "../src/app.mjs";
import { ConfigDoc } from "../src/summary.mjs";
import { openNodeStore } from "../src/node.mjs";

const modelId = process.env.OPTCHAT_MODEL;
const summaryModelId = process.env.OPTCHAT_SUMMARY_MODEL;
const [directory, text] = process.argv.slice(2);
if (
  !modelId ||
  !summaryModelId ||
  !directory ||
  !text ||
  !process.env.ANTHROPIC_API_KEY
) {
  throw new Error(
    "Set ANTHROPIC_API_KEY, OPTCHAT_MODEL and OPTCHAT_SUMMARY_MODEL; supply directory and message.",
  );
}
const models = createModels({
  authContext: {
    // No credential values enter durable documents.
    env: async (name) =>
      name === "ANTHROPIC_API_KEY" ? process.env.ANTHROPIC_API_KEY : undefined,
    fileExists: async () => false,
  },
});
models.setProvider(anthropicProvider());
const store = await openNodeStore(directory);
try {
  const chat = await openOptChat(store.storage, { models }, context);
  try {
    // The host selects the main model with pi-durable's configure and the summary model in ConfigDoc.
    await chat.root.commit(async (tx) => {
      await configure(tx, chat.root.id, {
        model: { provider: "anthropic", modelId },
      });
      (await tx.doc(ConfigDoc, chat.root.id)).summary = {
        model: { provider: "anthropic", modelId: summaryModelId },
        thinkingLevel: "off",
      };
    }, context);
    const requestId = randomUUID();
    await chat.accept({ requestId, content: text });
    const receipt = await chat.waitForAnswer(requestId);
    const transcript = await chat.root.context(context);
    for (const message of transcript.messages)
      if (message.role === "assistant") {
        for (const block of message.content)
          if (block.type === "text") process.stdout.write(block.text + "\n");
      }
    if (receipt.status !== "done") process.exitCode = 1;
  } finally {
    await chat.close();
  }
} finally {
  await store.close(context);
}
