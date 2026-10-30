# Architecture and implementation contract

[Guide index](../README.md) · [Behavioral coverage](09-validation.md) · [Pinned references](10-references.md)

This package implements the behavior of [UniiChat’s released source](https://github.com/VictorTaelin/UniiChat/tree/0500bf6a8ea4bf0ce047488562022b1b6532cc30) at commit `0500bf6` using **pi-durable 1.4.0**; [the references](10-references.md#where-this-port-differs-from-uniichat) list where it still differs. The guide defines semantic behavior; UniiChat’s JSON-lines logs and `view.json` are represented by native documents, not mirrored application files.

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

Sources: [native concepts](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/README.md#L92-L113), [task definitions](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/docs/spec.md#L1745-L2039), [task ownership](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/docs/spec.md#L2095-L2402), [documents](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/docs/spec.md#L1067-L1423).

## Public API

`openOptChat(storage, options, context)` assembles the native registry, documents, tasks, hooks and root conversation. It returns `accept`, `waitForAnswer`, `abort`, `close`, `root` and `harness`. Use a stable unique `requestId` for an input and reuse it if its acknowledgement is lost. `waitForAnswer` is a host/UI wait for that input’s answer, across the resubmissions a failed run can cause, not a tool for the main agent to poll its subagents. `abort` is the user’s stop: it ends the turn and every agent at work.

The host passes its own pi-ai `Models`. It selects the root conversation’s main model and thinking level with pi-durable’s `configure`, the summary model and thinking level as the `summary` of `ConfigDoc`, and optionally the subagents’ as its `subagents`, which otherwise run on the main model, in one commit; summary builds wait until that selection is set, and the host accepts no input before the main model is. `turnState` supplies what changes between turns, such as the devices open now; a turn reads it as it starts, and a message to a subagent as it is sent. `init` runs in the root conversation’s creating commit after OptChat’s own documents, for the host’s documents. See the [complete hosts](08-host-and-lifecycle.md).

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
export { ConfigDoc, type ModelSelection, type OptChatConfig } from "./summary.mjs";
export { MemoryDoc, MessageDoc, NodeDoc } from "./memory.mjs";
export { PrivateAgentDoc, AgentDirectoryDoc } from "./agents.mjs";
```

<!-- implementation:end -->
