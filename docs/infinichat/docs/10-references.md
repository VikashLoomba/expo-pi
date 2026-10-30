# Pinned implementation references

[Guide index](../README.md) · [Behavioral coverage](09-validation.md) · [Pinned references](10-references.md)

The behavioral authority is [UniiChat’s released source](https://github.com/VictorTaelin/UniiChat/tree/0500bf6a8ea4bf0ce047488562022b1b6532cc30), commit `0500bf6a8ea4bf0ce047488562022b1b6532cc30`, Victor Taelin’s implementation of OptChat. It is read as data and not run. Its design is in each file’s header comment, starting with Memory.ts, Server.ts and AskAI.ts, as [its README](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/README.md?plain=1#L38-L40) says.

The guide was first written from [Taelin’s design gist](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449/3c190e06f34aba0c69f49042c526093269604935), revision `3c190e0` of 2026-10-08, which the release supersedes. The gist remains the source of three things the release doesn’t state: the rollback push the due order is tested against (§3.1), the renaming and dropped device paragraph it allows a port (§5), and its checklist of mistakes (§7).

## Where this port differs from UniiChat

The topic pages note each difference where they cover it.

- **Providers:** any pi-ai provider, through pi-ai’s own requests and retries; UniiChat has its own Anthropic and OpenAI wires.
- **Caching**, deferred: no mark on the view’s last whole four-line block and no single flight, and compactions still offer the turns’ tools with tool use disabled, where UniiChat sends none. See [provider caching](07-provider-cache.md).
- **Logging an input:** when pi-durable places it, so a stop withdraws an input not yet placed; UniiChat logs a message as it arrives. See [turns and coordinator](04-turns-and-coordinator.md).
- **Recall pages:** by page number; UniiChat’s zoom takes a character offset `at`. See [tools and recall](05-tools-and-recall.md).
- **Summary model:** no default, by the owner’s decision; UniiChat defaults to `haiku-5.5` at high effort.
- **Web search:** the app gives an OpenAI model OpenAI’s hosted search and logs each search in memory as a tool call and its result, after the reply that made it; UniiChat has no web search.
- UniiChat’s imports, computer tasks, goals and billing are outside this port; the prompt drops the `ai` kind of imported chats.

## Pinned sources

Pi APIs in this package target release **1.4.0**, commit `4a080252f06caf63a525d7873c5d94d3c23887e0`. Use these pinned definitions when checking a call signature or lifecycle guarantee.


[Normative Pi Durable specification](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/docs/spec.md) and [usage guide](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/README.md) define the native contracts. Use the pinned implementation and runnable examples below alongside them.

Primary sources:

- [UniiChat 0500bf6](https://github.com/VictorTaelin/UniiChat/tree/0500bf6a8ea4bf0ce047488562022b1b6532cc30):
  - [Memory.ts](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts): [design](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L1-L50), [constants and compaction tasks](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L139-L190), [message pages](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L428-L456), [node sources](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L575-L586), [build admission](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L588-L656), [`build` and `over`](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L726-L816), [`JOBS`](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L143) and [`ctx`](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L584-L586), [view sizes](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L826-L829), [view batches and due merges](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L831-L956), [`settle`](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L958-L977), [`flat`](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L985-L990), [view rendering](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L1005-L1018), [`zoom` and `date`](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L1020-L1045), the roots of a wrong line among them, and [agent logs](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L1153-L1194).
  - [prompt.txt](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/prompt.txt), with the closing compaction paragraph.
  - [Server.ts](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Server.ts): [turns](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Server.ts#L12-L14), [a message taken between tool calls](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Server.ts#L482-L495), [the turn message](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Server.ts#L528-L556), [the turns’ calls](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Server.ts#L498-L521), [a call’s end and the messages it didn’t take](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Server.ts#L563-L581), [a failed turn’s note](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Server.ts#L620-L623), [a report’s turn](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Server.ts#L709-L726) and [the stop note](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Server.ts#L1209-L1224).
  - [Tools.ts](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts): [agents](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts#L14-L16), [`SUB_HEAD`, `VIEW_DOC` and `DEVICES`](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts#L123-L190), [the tools](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts#L192-L202), [their work dirs](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts#L204-L210), [`at_work`](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts#L259-L265), [`spawn`](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts#L491-L498), [`tell`](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts#L510-L528), [an agent’s start](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts#L530-L539), [its calls and report](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts#L557-L572), [its call’s message](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts#L581-L599) and [stop](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Tools.ts#L656-L661).
  - [Agent.ts](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Agent.ts): [its loop](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Agent.ts#L1-L10), [failed results](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Agent.ts#L198), [empty ones](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Agent.ts#L479) and [a cut attempt](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Agent.ts#L444-L448).
  - [AskAI.ts](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/AskAI.ts#L1-L24), patient calls and single flight, and [its kinds](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/AskAI.ts#L36-L39); [Anthropic.ts](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Anthropic.ts#L1-L12); [Clip.ts](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Clip.ts#L1-L13) and [its clip](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Clip.ts#L18-L43); [Names.ts](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Names.ts#L1-L50); [Call.ts’s report text](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Call.ts#L60-L67); [Machine.ts’s work dirs](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Machine.ts#L1-L9) and [the default one](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Config.ts#L28); [the default compactor](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Config.ts#L35); [cache.test.ts](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/cache.test.ts#L252-L257).
- [Taelin’s design gist](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449/3c190e06f34aba0c69f49042c526093269604935), revision `3c190e0`: §3.1, §5 and §7.
- [pi-durable package 1.4.0](https://www.npmjs.com/package/@earendil-works/pi-durable/v/1.4.0): installed README sections Concepts, Sleeping and Waking Up, Failures and Recovery, Busy Conversations, Reset and Handoff, Child Tasks, Your Own State, Storage and Errors.
- [pi-ai package 1.4.0](https://www.npmjs.com/package/@earendil-works/pi-ai/v/1.4.0): installed public Models and request-option declarations.
- [Upstream durable source](https://github.com/earendil-works/pi/tree/main/packages/durable): useful navigation, but `main` is not the pinned API contract.

Pinned API references:

- [Native tool sequencing and generation](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/harness/generation.ts)
- [Inbox steering boundaries](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/harness/inbox.ts)
- [Public hooks and execution modes](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/harness/types.ts)
- [Native prompt sections](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/harness/prompt.ts)
- [Provider registration](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/ai/src/models.ts)
- [Tool result hooks and finalization](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/harness/tool.ts)
- [Bash output sources](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/tools/bash.ts)
- [Code-mode head and tail output](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/codemode/output.ts)
- [Read paging](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/tools/read.ts)
- [Compaction retry phase](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/harness/compaction.ts#L188-L232), which summary builds follow
- [Retry classification and backoff](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/ai/src/utils/retry.ts)


Runnable native patterns:

| Pattern | Example |
|---|---|
| Documents and atomic log writes | [01-documents.ts](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/test/examples/01-documents.ts#L14-L44) |
| Task-owned conversations | [03-owned-conversations.ts](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/test/examples/03-owned-conversations.ts#L41-L67) |
| Document watches | [05-watches.ts](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/test/examples/05-watches.ts#L25-L40) |
| Context head and history | [09-context.ts](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/test/examples/09-context.ts#L112-L134) |
| Phased tasks | [12-tasks.ts](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/test/examples/12-tasks.ts#L17-L62) |
| Storage recovery | [13-recovery.ts](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/test/examples/13-recovery.ts#L60-L90) |
| Prompt sections | [15-system-prompt.ts](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/test/examples/15-system-prompt.ts#L25-L51) |
| Inbox steering and withdrawal | [20-inbox.ts](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/test/examples/20-inbox.ts#L26-L69) |
| Background agent/report ownership | [23-subagent-background.ts](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/test/examples/23-subagent-background.ts#L57-L126) |
| Subagent conversation configuration | [23-subagent-background.ts](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/test/examples/23-subagent-background.ts#L187-L198) |
| Child task joins | [24-child-tasks.ts](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/test/examples/24-child-tasks.ts#L62-L97) |
| Per-conversation environment | [29-sandbox-per-conversation.ts](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/test/examples/29-sandbox-per-conversation.ts#L18-L69) |
| Native tool decoration | [30-tool-override.ts](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/test/examples/30-tool-override.ts#L26-L51) |

Exact pinned declaration/source paths inside the installed packages:

- `pi-durable/dist/types.d.ts`: TaskRuntime, TaskDefinition, NextTaskState, Tx, DocumentObserver, document families and entry queries.
- `pi-durable/dist/index.d.ts`: actual public exports; no public `admitSubmission` or `startRun` export.
- `pi-durable/dist/harness/types.d.ts`: native input modes, HookApi, hook results, ToolExecutionApi, output limits and ConversationStreamOptions.
- `pi-durable/dist/harness/harness.js`: reset implementation and native public conversation operations.
- `pi-durable/dist/harness/inbox.js`: boundary placement and custom input entry handling.
- `pi-durable/dist/harness/generation.js` and `context.js`: committed native responses versus provider-context projection.
- `pi-durable/dist/harness/tool.js` and `scheduler.js`: native output/diagnostic assembly and task invocation behavior.
- `pi-ai/dist/models.d.ts` and `types.d.ts`: public Models calls, cancellation and tool choice.
- `pi-ai/dist/utils/retry.d.ts`: `isRetryableAssistantError` and `retryDelayMs`.

Compile the source against the pinned declarations. The linked modules implement OptChat policy using these native APIs; native API documentation does not replace that policy implementation.
