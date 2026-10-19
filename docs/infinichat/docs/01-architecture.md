# Architecture and implementation contract

[Guide index](../README.md) · [Behavioral coverage](09-validation.md) · [Pinned references](10-references.md)

This package implements the behavior in [Victor Taelin’s OptChat / UniiChat guide](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) and [UniiChat’s released source](https://github.com/VictorTaelin/UniiChat/tree/0500bf6a8ea4bf0ce047488562022b1b6532cc30) using **pi-durable 1.3.0**; where the release differs from the gist, it follows the release. The guide defines semantic behavior; its JSONL files and view files are represented by native documents, not mirrored application files.

The user has one ongoing chat. Every fresh logical turn sees the saved memory view and its new input, not the previous turn’s provider transcript. Native context resets preserve the stored transcript. Native tasks manage the coordinator, summary builds, and requested background agents. Native documents hold permanent originals, immutable built nodes, exact saved views, and application policy state.

Pi owns transactions, persisted task checkpoints, task ownership, cancellation, tool execution, provider protocol pairing, provider caching, native submissions, and reopening storage. OptChat supplies the actual binary-tree policy, due-order merges, sawtooth byte budgets, compaction source/context selection, fresh-turn admission, recall, and named-report semantics. Those policies are implemented in the linked source modules, not left to an integrator to invent.

## Reading and integration order

1. [Memory, tree and saved views](02-memory-tree-views.md): canonical data and the pure tree/view algorithms.
2. [Summary tasks](03-summary-tasks.md): queue admission, frozen requests, bounded corrections, patient retries and publication.
3. [Turns and coordinator](04-turns-and-coordinator.md): the exact prompt, root conversation, input routing and projection.
4. [Tools and recall](05-tools-and-recall.md), [background agents](06-background-agents.md), and [provider caching](07-provider-cache.md): native extension composition and what Pi caches itself.
5. [Host and lifecycle](08-host-and-lifecycle.md): storage/environment integration and deployment obligations.
6. [Validation](09-validation.md): behavior-derived checks and the runnable test boundary.

The implementation listings are generated directly from the package source. A host adapter supplies credentials, model selection, native platform tools, storage and process lifetime. It must not implement missing OptChat tree, view, compaction or turn policy.

Sources: [native concepts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/README.md#L80-L101), [task definitions](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/docs/spec.md#L1657-L1933), [task ownership](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/docs/spec.md#L1989-L2269), [documents](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/docs/spec.md#L983-L1335).

## Public API

`openOptChat(storage, options, context)` assembles the native registry, documents, tasks, hooks and root conversation. It returns `accept`, `waitForAnswer`, `abort`, `close`, `root` and `harness`. Use a stable unique `requestId` for an input and reuse it if its acknowledgement is lost. `waitForAnswer` is a host/UI wait for that submission, not a tool for the main agent to poll its subagents.

The host passes its own pi-ai `Models`. It selects the root conversation’s main model and thinking level with pi-durable’s `configure`, and the summary model and thinking level as the `summary` of `ConfigDoc`, in one commit; summary builds wait until that selection is set, and the host accepts no input before the main model is. `turnState` supplies what changes between turns, such as the devices open now; a turn and a subagent read it as they start. `init` runs in the root conversation’s creating commit after OptChat’s own documents, for the host’s documents. See the [complete hosts](08-host-and-lifecycle.md).

<!-- implementation:start -->

### `src/index.mts`

[Complete source](../src/index.mts)

```typescript
export {
  openOptChat,
  AppDoc,
  DeliveryEntry,
  InputDoc,
  type Admission,
  type AppState,
  type OptChat,
  type OptChatOptions,
} from "./app.mjs";
export { ConfigDoc, type SummarySelection } from "./summary.mjs";
export { MemoryDoc, MessageDoc, NodeDoc } from "./memory.mjs";
export { PrivateAgentDoc, AgentDirectoryDoc } from "./agents.mjs";
```

<!-- implementation:end -->
