# Portable host and native lifecycle

[Guide index](../README.md) · [Behavioral coverage](09-validation.md) · [Pinned references](10-references.md)

Sources: [native storage specification](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/docs/spec.md#L4849-L5192), [SQLite](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/docs/spec.md#L5125-L5140), [JSONL](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/docs/spec.md#L5142-L5192), [native recovery example](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/examples/13-recovery.ts).

The portable core does not import Expo or React Native. Its host supplies the native Harness/storage, model credentials and selection, native tools, environment/device adapter, and platform lifecycle. These are actual host capabilities, not callbacks that outsource OptChat memory algorithms.

## Exclusive writer and storage

Exactly one process owns a chat. The Linux host below takes an exclusive file lock before opening the runtime and releases it after runtime/storage close; one iOS process owns the Expo host’s file by itself. A database’s ordinary concurrent-write coordination does not by itself establish the product’s single-owner rule.

Native commits are atomic, so a store is consistent after any interruption, and a resubmitted request ID finds the submission that was already admitted. The Expo host opens OptChat’s own database file with the application’s existing `openExpoSqliteStorage` opener and that opener’s defaults, as the application’s chats do. The Linux host adapter sets `PRAGMA synchronous=FULL`; that is its own choice, not a requirement of other hosts. Do not invent application JSONL projections.

## Restart and cancellation

Reopen the same native storage and register the same document/task definitions. Restore exact saved views and native checkpoints; do not rebuild views, rescan all history for work, run duplicate timers, or maintain a second scheduler.

A changed document or task shape gets a new version and a pi-durable `migrate`, which converts a stored record of an older version as it is [read](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/docs/spec.md#L1295-L1305) or [reserved](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/docs/spec.md#L1918-L1922); an existing conversation is never cleared or broken. The migrations cast the stored value to its old shape, as pi-durable’s own built-in migrations do. `AppDoc` 4, `InputDoc` 3, `MemoryDoc` 2, the summary scratch 2, `BuildNode` 2, the agent message task 3, the agent document 2, the agent report 2 and the agent-call record 2 each say what they convert.

Use native cancellation and task ownership. `abort()` records intent for the sole coordinator, which cancels accepted inputs not yet placed, so they never enter canonical memory, before cancelling foreground native work; independent summary tasks remain live. As UniiChat’s stop does, it also aborts every agent at work, whose reports `failed: stopped` are logged with no turn, and leaves a note naming what it stopped once the turn’s run has ended. Native faults surface through the host wait rather than becoming an endless busy state. Interrupted or failed summary work releases policy reservations through its native lifecycle, without claiming exactly-once model billing. Stable request IDs make native submit replay idempotent; they do not make arbitrary external tools exactly-once. Retain native tool recovery semantics rather than claiming recovery of bytes that were never committed.

## Expo host

InfiniChat is a tab of expo-router’s native tabs (`expo-router/native-tabs` in SDK 58; https://docs.expo.dev/router/advanced/native-tabs/), titled InfiniChat with the SF symbol `infinity`. Each tab holds its own native Stack, which the native-tabs documentation requires for headers and pushed screens: the Chats tab keeps the existing chat routes, the InfiniChat tab shows the single conversation and has no list, and the account, chat settings and remote machines modals stay reachable.

The Expo application opens OptChat on its own SQLite database file with its existing `openExpoSqliteStorage` opener and that opener’s defaults, and on its own Harness beside the application’s chat Harness. Harness settings are process-wide run policy: OptChat’s sequential tool execution, steer-all queueing and disabled native compaction must not reach ordinary chats. One iOS process owns the file. The root conversation’s `init` creates the documents the application’s environment resolver reads, as the application’s own chat creation does. The application’s keep-alive controller counts OptChat’s summary builds and private agents as work although they are background tasks, and never the coordinator, which is always live.

Scheduled tasks. The master’s `schedule_task(task, run_after)` creates an `optchat.scheduled-task` background task holding the task and the time. Its one phase sleeps on the Harness clock as pi-durable’s own compaction retry does, so a reopened Harness sleeps again, or starts at once when the time passed while the app was closed; then it starts a subagent on the task exactly as `spawn` does, and the report reaches the main agent as any report does. The keep-alive never counts the waiting task as work, so the phone is not kept awake for it. The Expo host keeps one scheduled local notification per waiting task through expo-notifications, identified by the task id, with a “Run now” action that does not open the app and an “Open” action: scheduled when the task appears, cancelled when it ends, reconciled against what iOS holds whenever the task graph changes, and asking for notification permission at the first one. Nothing handles the tap: opening the app reopens the Harness, and the “Run now” action launches the app in the background, where the wait task starts the subagent and the keep-alive takes over.

The InfiniChat settings screen selects the main model and thinking level with pi-durable’s `configure`, and the summary model and thinking level as the `summary` of `ConfigDoc`, from the user’s configured providers, in one commit on the root conversation. The same commit saves the user’s own instructions from a multiline field, whose placeholder is `prompt.txt`’s description of them, through `setInstructions`. There is no default: nothing is sent and nothing is built until both are set.

InfiniChat’s tools are pi-durable’s bash, read, write and edit with a required `device` argument. Each keeps the built-in registration from the tool factories, adds `device` to the built-in schema, copies its replay, output limits, structured output schema and callers, and calls the built-in’s `execute` with that device’s environment injected, as the Harness does for every call. A device is the phone’s workspace or a configured remote machine, resolved to the environments the application already builds; an unknown device is an error result. Each agent’s device tools run in `<work>/<who>`, as [UniiChat’s](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts#L204-L210) [work dirs](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Machine.ts#L1-L9) do: `<work>` is the device’s work dir, `/workspace` on the phone and `~/.infinichat/work` on an SSH machine, as UniiChat’s is [`~/.unii/work`](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Config.ts#L28); `<who>` is `main` for the main agent and the agent’s name for a subagent, the working directory its conversation is configured with. The folder is created on first use, as [UniiChat creates](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts#L530-L539) an agent’s, and each tool’s description says where it runs. The host’s `turnState` option lists the devices open now, each with its work dir; a turn reads it as it starts and a message to a subagent as it is sent, and both place it after the view. The prompt keeps `prompt.txt`’s device paragraph, so `hasDeviceTools` is true. `callEnv` resolves a completed call’s device, so a spilled output file is read on the machine that produced it, and `nativeContracts` registers bash’s spill and read’s own paging, which is never clipped.

The transcript reuses the application’s chat view over the root conversation. A fresh turn’s input is a native `optchat.delivery` entry whose user message carries the saved view, the turn state, the agents at work and the turn head ahead of the original input; the projection shows the original input from `InputDoc` by the entry’s `requestId`, and does not show the reset entry that begins each fresh turn as a summary notice. Streaming and tool progress come from `pi.live` as for ordinary chats.

The chat view needs the application’s chat metadata document to show a conversation at all, so the root conversation’s `init` creates it with the tab’s title, and it is never marked deleted. The view follows the outcome of the latest input by request rather than by submission, because the coordinator submits the native input later: the host records the latest accepted request ID at acceptance, and the view waits on it through `waitForAnswer`, which resolves the native receipt once the admission is submitted and rejects when a stop cancelled the input first. Inputs accepted while a turn runs are not native entries until they are dispatched; the projection shows them from `AppDoc`’s `pending` list and `InputDoc` as queued user rows, as it shows inbox items for ordinary chats. The conversation shows as working while an input waits or an agent works, read from pi-durable’s live task graph, so Stop reaches the agents. An agent’s report row is headed by its name and shows the report without the `Full chat: zoom(...)` pointer for the model, as [UniiChat’s `report_read`](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Call.ts#L64-L67) reads one.

An InfiniChat service owns the second Harness. The provider opens it beside the chat service in the same open step, reopens it after a storage failure the same way, closes it in the same teardown, and the keep-alive controller observes both task graphs. InfiniChat has its own settings route served by that service, with the main model and effort and the summary model and effort; the chat settings route resolves conversations through the chat service only.

## Runnable hosts

Run `npm run demo` for the offline scripted-model example using the real native runtime. Run `npm run build` before using the opt-in Anthropic host. The latter requires `ANTHROPIC_API_KEY`, `OPTCHAT_MODEL` and `OPTCHAT_SUMMARY_MODEL`, and accepts the chat directory and new message as command arguments. It can make paid model calls; the test suite compiles it without executing it.

Model IDs must exist in the pinned provider catalog. The examples show provider registration, storage opening, app construction, model selection, input acceptance, native result waiting and ordered shutdown.

## Linux storage implementation and host source

The included Node host adapter uses Linux `flock` and a local SQLite database. Other platforms implement the same host boundary; the portable policy modules do not import this adapter.

<!-- implementation:start -->

### `src/node.mts`

[Complete source](../src/node.mts)

```typescript
/** Linux host adapter. Portable OptChat modules do not import this module. */
import { closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Context } from '@earendil-works/chord';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';

function syncDirectory(directory: string): void {
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function createDurableDirectory(directory: string): void {
  const firstCreated = mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (firstCreated === undefined) return;
  const existingParent = dirname(resolve(firstCreated));
  for (let current = directory;; current = dirname(current)) {
    syncDirectory(current);
    if (current === existingParent) break;
  }
}

/**
 * One writer per local directory. Linux flock attaches to the open file description:
 * its inherited descriptor and ours refer to the same lock. After flock exits, our
 * descriptor retains ownership. Process death releases it without stale-lock repair.
 * Never unlink .writer.lock: replacing that inode could create two independent locks.
 */
function acquireWriter(directory: string): () => void {
  const fd = openSync(join(directory, '.writer.lock'), 'a+', 0o600);
  try {
    const result = spawnSync('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'], {
      stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8',
    });
    if (result.error) throw result.error;
    if (result.status === 73) throw new Error('This OptChat directory already has a writer.');
    if (result.status !== 0) throw new Error(`flock failed: ${result.stderr || result.signal || result.status}`);
    syncDirectory(directory);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  let released = false;
  return () => { if (!released) { closeSync(fd); released = true; } };
}

export type NodeStore = {
  storage: SqliteStorage;
  /** Stop/close the Harness before closing its storage and releasing ownership. */
  close(context: Context): Promise<void>;
};

/**
 * Open on a local Linux filesystem with working flock and fsync semantics.
 * SQLite FULL in WAL mode syncs each committed transaction before acknowledgment.
 * Hardware/filesystem honoring synchronization remains a host requirement.
 */
export async function openNodeStore(path: string): Promise<NodeStore> {
  if (process.platform !== 'linux') throw new Error('This host adapter requires Linux; use a platform storage/ownership adapter elsewhere.');
  const directory = resolve(path);
  createDurableDirectory(directory);
  const releaseWriter = acquireWriter(directory);
  let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>> | undefined;
  try {
    database = await openNodeSqliteDatabase(join(directory, 'session.sqlite'));
    await database.exec('PRAGMA synchronous = FULL');
    const mode = await database.get<{ synchronous: number }>('PRAGMA synchronous');
    if (mode?.synchronous !== 2) throw new Error('SQLite did not enable synchronous=FULL.');
    const storage = await SqliteStorage.open(database);
    syncDirectory(directory);
    let closed = false;
    return {
      storage,
      async close(context) {
        if (closed) return;
        await storage.close(context);
        releaseWriter();
        closed = true;
      },
    };
  } catch (error) {
    try { await database?.close(); } finally { releaseWriter(); }
    throw error;
  }
}
```

### `examples/demo.mts`

[Complete source](../examples/demo.mts)

```typescript
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
```

### `examples/anthropic-node.mts`

[Complete source](../examples/anthropic-node.mts)

```typescript
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
```

<!-- implementation:end -->
