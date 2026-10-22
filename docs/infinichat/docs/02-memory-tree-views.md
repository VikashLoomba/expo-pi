# Canonical memory, binary tree and saved views

[Guide index](../README.md) · [Behavioral coverage](09-validation.md) · [Pinned references](10-references.md)

Sources: UniiChat’s [Memory.ts design](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L1-L50), [message pages](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L428-L456), [node sources](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L575-L586), [view sizes](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L826-L829), [`flat`](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L985-L990), [view batches and due merges](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L831-L956) and [view rendering](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L1005-L1018), [native document scopes and lifetime](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/docs/spec.md#L1067-L1423), [transactions](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/docs/spec.md#L1677-L1743).

## Canonical records

Permanent monotonically addressed records contain kind, original text, actual UTF-8 byte size, and original date. Supported kinds are `user`, `unii`, `tool`, `echo`, `work`, and `note`. Tool calls contain their name and JSON input; a background report is UniiChat’s: `[Name]`, a newline, the report, a blank line and `Full chat: zoom("Name")`. Non-tool long text splits losslessly across consecutive records. The whole incoming input is still delivered to the provider once, not once per memory fragment. An input’s images remain retrievable from its original record. A tool result’s echo is text only, an `[image]` line for each image it returned, as UniiChat shows a result’s part: the model saw the image in its turn.

Thinking is not OptChat semantic memory. Preserve native reasoning/signatures needed by the provider; excluding them from memory is not a request to disable thinking or rewrite the underlying model protocol.

## Tree identity and sources

`node(0,i)` covers message `i`. `node(l,i)` covers the `2^l` messages starting at `i*2^l`; its children are `(l-1,2i)` and `(l-1,2i+1)`. The external address is `id+n`, where `id=i*2^l` and `n=2^l`.

A leaf source is the exact `kind: text`, followed by an `[image]` line for each image the message holds, the line `zoom(id,1)` shows; the image itself stays in the record. A parent source is the left and right node text, each flattened (its newlines and the spaces around them as one space, UniiChat’s `flat`), joined by one newline, as UniiChat’s merge input is; a short leaf’s exact source may hold several lines. If that source fits in 512 UTF-8 bytes, publish it without a model call. Once published, node content is immutable.

## Saved main view

The view is an oldest-first contiguous cover. Rendering emits `<chat>`, one `id+n|text` line per node, and `</chat>`; embedded newlines become spaces and dates are absent. Never insert a partial message as a substitute summary.

Appending a message extends the tail. A view’s size is UniiChat’s: the UTF-8 bytes of its lines’ node text, without their `id+n|` heads, newlines or tags. Only when that size is **greater than 128,000 bytes** does a merge batch start; its target is **at most 64,000 bytes**. Merge only adjacent aligned siblings with an already-built parent. Select the largest `(T - last)/2^l`, where `last` is the pair’s last message, with oldest pair first on ties. Measuring age from the first message is incorrect. If eligible parents run out, preserve the pending batch and continue at subsequent message boundaries.

Persist exact view references and pending-batch state. Reopening or beginning a turn must not reconstruct a different cover from the log. Do not substitute a fixed line count or fixed lines per level.

## Saved compaction view

Compaction has its own saved view, measured the same way: initially reduce toward 16,000 bytes, append later lines, and reduce again when over 32,000 bytes. Each view batches on its own size only, as UniiChat’s two views do, so a batch of the main view leaves the compactions’ cached view alone. Its context contains only built lines and stops at the first missing leaf. A leaf build sees only earlier messages; a parent build may see detail through its own final message, never future context.

Ready queues, the contiguous built frontier and targeted parent enqueueing drive work. A growing history must not be repeatedly scanned to rediscover unbuilt nodes.

## Implementation

<!-- implementation:start -->

### `src/memory.mts`

[Complete source](../src/memory.mts)

```typescript
import {
  defineDoc,
  defineDocFamily,
  type ConversationId,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
export type NodeRef = [level: number, index: number];
export const bytes = (s: string): number => new TextEncoder().encode(s).length;
export const key = ([l, i]: NodeRef): string => `${l}:${i}`;
export const width = ([l]: NodeRef): number => 2 ** l;
export const first = (r: NodeRef): number => r[1] * width(r);
export const end = (r: NodeRef): number => first(r) + width(r);
/** Tool output keeps head and tail within this many Unicode scalars; other long text splits into records this long. */
const TEXT_LIMIT = 30000;
/** Newlines as spaces, as UniiChat's `flat` writes a line and a merge's input. */
export const flat = (text: string): string => text.replace(/\s*\n\s*/g, " ");
export type Kind = "user" | "unii" | "tool" | "echo" | "work" | "note";
export type CanonicalMessage = {
  i: number;
  kind: Kind;
  text: string;
  bytes: number;
  date: string;
  source: string;
  images: {
    data: string;
    mimeType: string;
  }[];
};
export type MessageInput = Omit<CanonicalMessage, "i" | "bytes">;
export const MessageDoc = defineDocFamily<
  CanonicalMessage,
  CanonicalMessage | null
>({
  kind: "optchat.message",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  family: true,
  checkpointWhen: () => false,
  initial: (seed) => {
    if (!seed) throw new Error("Missing canonical message");
    return seed;
  },
});
export type BuiltNode = {
  ref: NodeRef;
  text: string;
  bytes: number;
  builder: TaskId<string>;
};
export const NodeDoc = defineDocFamily<
  {
    value: BuiltNode | null;
  },
  BuiltNode | null
>({
  kind: "optchat.node",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  family: true,
  checkpointWhen: () => false,
  initial: (value) => ({ value }),
});
export type View = {
  refs: NodeRef[];
  reducing: boolean;
};
export type MemoryState = {
  nextMessage: number;
  frontier: number;
  viewThrough: number;
  revision: number;
  messageProgress: number;
  pendingLeaves: number[];
  readyParents: NodeRef[];
  active: Record<string, TaskId<string>>;
  failed: Record<
    string,
    {
      ref: NodeRef;
      at: number;
    }
  >;
  main: View;
  compact: View;
};
export const MemoryDoc = defineDoc<MemoryState>({
  kind: "optchat.memory",
  version: 2,
  scope: "conversation",
  history: "latest",
  fork: "current",
  checkpointWhen: () => true,
  // Version 1 took leaves and parents in turn; builds now start in the order the messages came.
  migrate: (value) => {
    const { nextQueue: _turn, ...memory } = value as MemoryState & {
      nextQueue: "leaf" | "parent";
    };
    return memory;
  },
  initial: () => ({
    nextMessage: 0,
    frontier: 0,
    viewThrough: 0,
    revision: 0,
    messageProgress: 0,
    pendingLeaves: [],
    readyParents: [],
    active: {},
    failed: {},
    main: { refs: [], reducing: false },
    compact: { refs: [], reducing: false },
  }),
});
export async function readMessage(
  tx: Tx,
  root: ConversationId,
  i: number,
): Promise<CanonicalMessage> {
  return await tx.doc(MessageDoc, root, String(i), null);
}
/** A message as a compaction and zoom show it: an image's line tells the model there is one to zoom into. */
export const shownMessage = (m: CanonicalMessage): string =>
  `${m.kind}: ${m.text}${m.images.map(() => "\n[image]").join("")}`;
export async function readNode(
  tx: Tx,
  root: ConversationId,
  ref: NodeRef,
): Promise<BuiltNode | null> {
  return (await tx.doc(NodeDoc, root, key(ref), null)).value;
}
/** UniiChat's clip: half the limit from the head, the tail less 64 for the marker, which counts what it cut. */
export function clipToolText(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= TEXT_LIMIT) return text;
  const head = TEXT_LIMIT / 2;
  const tail = TEXT_LIMIT / 2 - 64;
  const cut = chars.length - head - tail;
  return (
    chars.slice(0, head).join("") +
    `\n[... ${cut} characters cut ...]\n` +
    chars.slice(-tail).join("")
  );
}
export async function advanceMessageProgress(
  tx: Tx,
  root: ConversationId,
): Promise<void> {
  const s = await tx.doc(MemoryDoc, root);
  s.messageProgress++;
  s.revision++;
}
export async function appendMessage(
  tx: Tx,
  root: ConversationId,
  input: MessageInput,
  advanceProgress = true,
  chunkScalars = TEXT_LIMIT,
): Promise<number[]> {
  if (!Number.isSafeInteger(chunkScalars) || chunkScalars < 1)
    throw new Error("Invalid chunk size");
  const s = await tx.doc(MemoryDoc, root);
  const chars = Array.from(
    input.kind === "echo" ? clipToolText(input.text) : input.text,
  );
  const ids: number[] = [];
  for (let at = 0; at < chars.length || at === 0; at += chunkScalars) {
    const text = chars.slice(at, at + chunkScalars).join("");
    const i = s.nextMessage++;
    await tx.doc(MessageDoc, root, String(i), {
      ...input,
      i,
      text,
      bytes: bytes(text),
      images: at === 0 ? input.images : [],
    });
    s.pendingLeaves.push(i);
    ids.push(i);
  }
  if (advanceProgress) s.messageProgress++;
  s.revision++;
  return ids;
}
export async function memoryReady(
  tx: Tx,
  root: ConversationId,
  cutoff?: number,
): Promise<boolean> {
  const s = await tx.doc(MemoryDoc, root);
  return s.frontier >= (cutoff ?? s.nextMessage);
}
export const renderLines = (lines: string[]): string =>
  `<chat>\n${lines.length ? lines.join("\n") + "\n" : ""}</chat>`;
export const nodeLine = (n: BuiltNode): string =>
  `${first(n.ref)}+${width(n.ref)}|${flat(n.text)}`;
/** A view's size as UniiChat counts it: its lines' text, without their heads, newlines or tags. */
export async function viewBytes(
  tx: Tx,
  root: ConversationId,
  refs: NodeRef[],
): Promise<number> {
  let total = 0;
  for (const ref of refs) {
    const n = await readNode(tx, root, ref);
    if (!n) throw new Error("View contains an unresolved node");
    total += n.bytes;
  }
  return total;
}
// Compare (T-last)/width exactly, then prefer the oldest first-message address.
export function moreDue(a: NodeRef, b: NodeRef, T: number): boolean {
  const aw = BigInt(width(a)),
    bw = BigInt(width(b));
  const an = BigInt(T) - BigInt(first(a) + 2 * width(a) - 1);
  const bn = BigInt(T) - BigInt(first(b) + 2 * width(b) - 1);
  const cmp = an * bw - bn * aw;
  return cmp > 0n || (cmp === 0n && first(a) < first(b));
}
export async function reduceView(
  tx: Tx,
  root: ConversationId,
  view: View,
  T: number,
  target: number,
): Promise<boolean> {
  let changed = false;
  while ((await viewBytes(tx, root, view.refs)) > target) {
    let chosen = -1;
    for (let j = 0; j + 1 < view.refs.length; j++) {
      const a = view.refs[j],
        b = view.refs[j + 1];
      if (a[0] !== b[0] || a[1] % 2 !== 0 || b[1] !== a[1] + 1) continue;
      if (!(await readNode(tx, root, [a[0] + 1, a[1] / 2]))) continue;
      if (chosen < 0 || moreDue(a, view.refs[chosen], T)) chosen = j;
    }
    if (chosen < 0) {
      view.reducing = true;
      return changed;
    }
    const a = view.refs[chosen];
    view.refs.splice(chosen, 2, [a[0] + 1, a[1] / 2]);
    changed = true;
  }
  view.reducing = false;
  return changed;
}
// Each canonical boundary is consumed exactly once when its complete leaf becomes available.
// A parent completion alone does not start/retry a batch, preserving prompt-cache prefixes.
export async function settleViews(tx: Tx, root: ConversationId): Promise<void> {
  const s = await tx.doc(MemoryDoc, root);
  while (s.viewThrough < s.frontier) {
    const i = s.viewThrough++;
    s.main.refs.push([0, i]);
    s.compact.refs.push([0, i]);
    const T = i + 1;
    // Each view batches on its own size only, so a chat batch leaves the compactions' cached view alone.
    if ((await viewBytes(tx, root, s.main.refs)) > 128000)
      s.main.reducing = true;
    if (s.main.reducing) await reduceView(tx, root, s.main, T, 64000);
    if ((await viewBytes(tx, root, s.compact.refs)) > 32000)
      s.compact.reducing = true;
    if (s.compact.reducing) await reduceView(tx, root, s.compact, T, 16000);
    s.revision++;
  }
}
async function cutoffLines(
  tx: Tx,
  root: ConversationId,
  refs: NodeRef[],
  cutoff: number,
): Promise<string[]> {
  const out: string[] = [];
  let stopped = false;
  async function visit(ref: NodeRef): Promise<void> {
    if (stopped || first(ref) >= cutoff) return;
    const n = await readNode(tx, root, ref);
    if (end(ref) <= cutoff && n) {
      out.push(nodeLine(n));
      return;
    }
    if (ref[0] === 0) {
      stopped = true;
      return;
    }
    await visit([ref[0] - 1, ref[1] * 2]);
    await visit([ref[0] - 1, ref[1] * 2 + 1]);
  }
  for (const ref of refs) await visit(ref);
  return out;
}
export async function renderMain(
  tx: Tx,
  root: ConversationId,
  cutoff?: number,
): Promise<string> {
  await settleViews(tx, root);
  const s = await tx.doc(MemoryDoc, root);
  const count = cutoff ?? s.nextMessage;
  if (s.frontier < count)
    throw new Error("Prior message summaries are not ready");
  return renderLines(await cutoffLines(tx, root, s.main.refs, count));
}
export async function renderCompaction(
  tx: Tx,
  root: ConversationId,
  cutoffExclusive: number,
): Promise<string> {
  await settleViews(tx, root);
  const s = await tx.doc(MemoryDoc, root);
  return renderLines(
    await cutoffLines(
      tx,
      root,
      s.compact.refs,
      Math.min(cutoffExclusive, s.frontier),
    ),
  );
}
export async function publishNode(
  tx: Tx,
  root: ConversationId,
  node: BuiltNode,
): Promise<void> {
  const d = await tx.doc(NodeDoc, root, key(node.ref), null);
  if (d.value) throw new Error("Node already published");
  d.value = node;
  const s = await tx.doc(MemoryDoc, root);
  delete s.active[key(node.ref)];
  delete s.failed[key(node.ref)];
  if (node.ref[0] === 0) {
    const at = s.pendingLeaves.indexOf(node.ref[1]);
    if (at >= 0) s.pendingLeaves.splice(at, 1);
    while (
      s.frontier < s.nextMessage &&
      (await readNode(tx, root, [0, s.frontier]))
    )
      s.frontier++;
  }
  const sibling: NodeRef = [
    node.ref[0],
    node.ref[1] % 2 === 0 ? node.ref[1] + 1 : node.ref[1] - 1,
  ];
  if (await readNode(tx, root, sibling)) {
    const parent: NodeRef = [node.ref[0] + 1, Math.floor(node.ref[1] / 2)];
    s.readyParents.push(parent);
  }
  s.revision++;
  await settleViews(tx, root);
}
```

<!-- implementation:end -->
