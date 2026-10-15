import {
  defineDoc, defineDocFamily, type ConversationId, type TaskId, type Tx,
} from '@earendil-works/pi-durable';

export type NodeRef = [level: number, index: number];
export const bytes = (s: string): number => new TextEncoder().encode(s).length;
export const key = ([l, i]: NodeRef): string => `${l}:${i}`;
const width = ([l]: NodeRef): number => 2 ** l;
export const first = (r: NodeRef): number => r[1] * width(r);
export const end = (r: NodeRef): number => first(r) + width(r);

/** Tool output keeps head and tail within this many Unicode scalars; other long text splits into records this long. */
const TEXT_LIMIT = 30000;

type Kind = 'user' | 'unii' | 'tool' | 'echo' | 'work' | 'note';
type CanonicalMessage = {
  i: number;
  kind: Kind;
  text: string;
  bytes: number;
  date: string;
  source: string;
  images: { data: string; mimeType: string }[];
};
type MessageInput = Omit<CanonicalMessage, 'i' | 'bytes'>;
export const MessageDoc = defineDocFamily<CanonicalMessage, CanonicalMessage | null>({
  kind: 'optchat.message',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  family: true,
  initial: (seed) => {
    if (!seed) throw new Error('Missing canonical message');
    return seed;
  },
});
type BuiltNode = { ref: NodeRef; text: string; bytes: number; builder: TaskId<string> };
export const NodeDoc = defineDocFamily<{ value: BuiltNode | null }, BuiltNode | null>({
  kind: 'optchat.node',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  family: true,
  initial: (value) => ({ value }),
});
type View = { refs: NodeRef[]; reducing: boolean };
type MemoryState = {
  nextMessage: number;
  frontier: number;
  viewThrough: number;
  revision: number;
  messageProgress: number;
  pendingLeaves: number[];
  readyParents: NodeRef[];
  nextQueue: 'leaf' | 'parent';
  active: Record<string, TaskId<string>>;
  failed: Record<string, { ref: NodeRef; at: number }>;
  main: View;
  compact: View;
};
export const MemoryDoc = defineDoc<MemoryState>({
  kind: 'optchat.memory',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial: () => ({
    nextMessage: 0,
    frontier: 0,
    viewThrough: 0,
    revision: 0,
    messageProgress: 0,
    pendingLeaves: [],
    readyParents: [],
    nextQueue: 'leaf',
    active: {},
    failed: {},
    main: { refs: [], reducing: false },
    compact: { refs: [], reducing: false },
  }),
});

export async function readMessage(tx: Tx, root: ConversationId, i: number): Promise<CanonicalMessage> {
  return await tx.doc(MessageDoc, root, String(i), null);
}

export async function readNode(tx: Tx, root: ConversationId, ref: NodeRef): Promise<BuiltNode | null> {
  return (await tx.doc(NodeDoc, root, key(ref), null)).value;
}

export function clipToolText(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= TEXT_LIMIT) return text;
  const marker = '\n… [output omitted] …\n';
  const remaining = TEXT_LIMIT - Array.from(marker).length;
  const head = Math.ceil(remaining / 2);
  return chars.slice(0, head).join('') + marker + chars.slice(-(remaining - head)).join('');
}

export async function advanceMessageProgress(tx: Tx, root: ConversationId): Promise<void> {
  const s = await tx.doc(MemoryDoc, root);
  s.messageProgress++;
  s.revision++;
}

export async function appendMessage(tx: Tx, root: ConversationId, input: MessageInput,
  advanceProgress = true): Promise<number[]> {
  const s = await tx.doc(MemoryDoc, root);
  const chars = Array.from(input.kind === 'echo' ? clipToolText(input.text) : input.text);
  const ids: number[] = [];
  for (let at = 0; at < chars.length || at === 0; at += TEXT_LIMIT) {
    const text = chars.slice(at, at + TEXT_LIMIT).join('');
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

export async function memoryReady(tx: Tx, root: ConversationId, cutoff?: number): Promise<boolean> {
  const s = await tx.doc(MemoryDoc, root);
  return s.frontier >= (cutoff ?? s.nextMessage);
}

const renderLines = (lines: string[]): string => `<chat>\n${lines.length ? lines.join('\n') + '\n' : ''}</chat>`;
export const nodeLine = (n: BuiltNode): string =>
  `${first(n.ref)}+${width(n.ref)}|${n.text.replace(/\r\n|\r|\n/g, ' ')}`;

async function rendered(tx: Tx, root: ConversationId, refs: NodeRef[]): Promise<string> {
  const lines: string[] = [];
  for (const ref of refs) {
    const n = await readNode(tx, root, ref);
    if (!n) throw new Error('View contains an unresolved node');
    lines.push(nodeLine(n));
  }
  return renderLines(lines);
}

// Compare (T-last)/width exactly, then prefer the oldest first-message address.
function moreDue(a: NodeRef, b: NodeRef, T: number): boolean {
  const aw = BigInt(width(a));
  const bw = BigInt(width(b));
  const an = BigInt(T) - BigInt(first(a) + 2 * width(a) - 1);
  const bn = BigInt(T) - BigInt(first(b) + 2 * width(b) - 1);
  const cmp = an * bw - bn * aw;
  return cmp > 0n || (cmp === 0n && first(a) < first(b));
}

async function reduceView(tx: Tx, root: ConversationId, view: View, T: number, target: number): Promise<boolean> {
  let changed = false;
  while (bytes(await rendered(tx, root, view.refs)) > target) {
    let chosen = -1;
    for (let j = 0; j + 1 < view.refs.length; j++) {
      const a = view.refs[j];
      const b = view.refs[j + 1];
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
    if (bytes(await rendered(tx, root, s.main.refs)) > 128000) s.main.reducing = true;
    const mainBatch = s.main.reducing;
    if (mainBatch) await reduceView(tx, root, s.main, T, 64000);
    if (mainBatch || bytes(await rendered(tx, root, s.compact.refs)) > 32000) s.compact.reducing = true;
    if (s.compact.reducing) await reduceView(tx, root, s.compact, T, 16000);
    s.revision++;
  }
}

async function cutoffLines(tx: Tx, root: ConversationId, refs: NodeRef[], cutoff: number): Promise<string[]> {
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

export async function renderMain(tx: Tx, root: ConversationId, cutoff?: number): Promise<string> {
  await settleViews(tx, root);
  const s = await tx.doc(MemoryDoc, root);
  const count = cutoff ?? s.nextMessage;
  if (s.frontier < count) throw new Error('Prior message summaries are not ready');
  return renderLines(await cutoffLines(tx, root, s.main.refs, count));
}

export async function renderCompaction(tx: Tx, root: ConversationId, cutoffExclusive: number): Promise<string> {
  await settleViews(tx, root);
  const s = await tx.doc(MemoryDoc, root);
  return renderLines(await cutoffLines(tx, root, s.compact.refs, Math.min(cutoffExclusive, s.frontier)));
}

export async function publishNode(tx: Tx, root: ConversationId, node: BuiltNode): Promise<void> {
  const d = await tx.doc(NodeDoc, root, key(node.ref), null);
  if (d.value) throw new Error('Node already published');
  d.value = node;
  const s = await tx.doc(MemoryDoc, root);
  delete s.active[key(node.ref)];
  delete s.failed[key(node.ref)];
  if (node.ref[0] === 0) {
    const at = s.pendingLeaves.indexOf(node.ref[1]);
    if (at >= 0) s.pendingLeaves.splice(at, 1);
    while (s.frontier < s.nextMessage && (await readNode(tx, root, [0, s.frontier]))) s.frontier++;
  }
  const sibling: NodeRef = [node.ref[0], node.ref[1] % 2 === 0 ? node.ref[1] + 1 : node.ref[1] - 1];
  if (await readNode(tx, root, sibling)) {
    const parent: NodeRef = [node.ref[0] + 1, Math.floor(node.ref[1] / 2)];
    s.readyParents.push(parent);
  }
  s.revision++;
  await settleViews(tx, root);
}
