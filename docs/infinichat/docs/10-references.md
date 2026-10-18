# Pinned implementation references

[Guide index](../README.md) · [Behavioral coverage](09-validation.md) · [Pinned references](10-references.md)

The behavioral authority is [Victor Taelin’s complete OptChat / UniiChat implementation guide](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449). Section-specific labels below and in topic pages refer to headings in that same Gist, not invented fragment anchors.

Pi APIs in this package target release **1.3.0**, commit `71023aec1546d6d677a65669c5665c0927ce0dd0`. Use these pinned definitions when checking a call signature or lifecycle guarantee.


[Normative Pi Durable specification](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/docs/spec.md) and [usage guide](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/README.md) define the native contracts. Use the pinned implementation and runnable examples below alongside them.

The guide snapshot used here has SHA-256 `12f300f760af82bc07bc5201051d1267824ded09c9def8186e4f8144368038d8`.

Primary sources:

- [OptChat / UniiChat guide](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449), sections 1–7.
- [pi-durable package 1.3.0](https://www.npmjs.com/package/@earendil-works/pi-durable/v/1.3.0): installed README sections Concepts, Busy Conversations, Reset and Handoff, Child Tasks, Your Own State, Storage and Errors.
- [pi-ai package 1.3.0](https://www.npmjs.com/package/@earendil-works/pi-ai/v/1.3.0): installed public Models and request-option declarations.
- [Upstream durable source](https://github.com/earendil-works/pi/tree/main/packages/durable): useful navigation, but `main` is not the pinned API contract.

Pinned API references:

- [Native tool sequencing and generation](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/generation.ts)
- [Inbox steering boundaries](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/inbox.ts)
- [Public hooks and execution modes](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/types.ts)
- [Native prompt sections](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/prompt.ts)
- [Provider registration](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/ai/src/models.ts)
- [Tool result hooks and finalization](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/tool.ts)
- [Bash output sources](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/tools/bash.ts)
- [Code-mode head and tail output](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/codemode/output.ts)


Runnable native patterns:

| Pattern | Example |
|---|---|
| Documents and atomic log writes | [01-documents.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/examples/01-documents.ts#L14-L43) |
| Task-owned conversations | [03-owned-conversations.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/examples/03-owned-conversations.ts#L40-L66) |
| Document watches | [05-watches.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/examples/05-watches.ts#L24-L39) |
| Context head and history | [09-context.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/examples/09-context.ts#L112-L134) |
| Phased tasks | [12-tasks.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/examples/12-tasks.ts#L17-L62) |
| Storage recovery | [13-recovery.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/examples/13-recovery.ts#L59-L89) |
| Prompt sections | [15-system-prompt.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/examples/15-system-prompt.ts#L25-L51) |
| Inbox steering and withdrawal | [20-inbox.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/examples/20-inbox.ts#L26-L69) |
| Background agent/report ownership | [23-subagent-background.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/examples/23-subagent-background.ts#L56-L125) |
| Child task joins | [24-child-tasks.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/examples/24-child-tasks.ts#L57-L92) |
| Per-conversation environment | [29-sandbox-per-conversation.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/examples/29-sandbox-per-conversation.ts#L18-L68) |
| Native tool decoration | [30-tool-override.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/test/examples/30-tool-override.ts#L26-L51) |

Exact pinned declaration/source paths inside the installed packages:

- `pi-durable/dist/types.d.ts`: TaskRuntime, TaskDefinition, NextTaskState, Tx, DocumentObserver, document families and entry queries.
- `pi-durable/dist/index.d.ts`: actual public exports; no public `admitSubmission` or `startRun` export.
- `pi-durable/dist/harness/types.d.ts`: native input modes, HookApi, hook results, ToolExecutionApi, output limits and ConversationStreamOptions.
- `pi-durable/dist/harness/harness.js`: reset implementation and native public conversation operations.
- `pi-durable/dist/harness/inbox.js`: boundary placement and custom input entry handling.
- `pi-durable/dist/harness/generation.js` and `context.js`: committed native responses versus provider-context projection.
- `pi-durable/dist/harness/tool.js` and `scheduler.js`: native output/diagnostic assembly and task invocation behavior.
- `pi-ai/dist/models.d.ts` and `types.d.ts`: public Models calls, cancellation and tool choice.

Compile the source against the pinned declarations. The linked modules implement OptChat policy using these native APIs; native API documentation does not replace that policy implementation.
