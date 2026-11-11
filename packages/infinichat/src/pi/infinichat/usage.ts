import type { JsonRepresentation } from '@earendil-works/chord/json';
import type { Usage } from '@earendil-works/pi-ai';
import { arr, bool, num, obj, str, type Static } from '@earendil-works/pi-schema';
import { defineDoc, type ConversationId, type Tx } from '@earendil-works/pi-durable';

type Ledger = Record<string, JsonRepresentation<Usage>>;

/**
 * What writing memory has spent, per `provider/modelId`: the summary builds' model calls. They are OptChat's own, so
 * pi-durable's ledger of the conversation (`pi.usage`) never sees them, and they stay apart from it, so the screens
 * can say what memory costs even when it runs on the main model.
 */
export const MemoryUsageDoc = defineDoc<{ models: Ledger }>({
  kind: 'optchat.usage',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => true,
  initial: () => ({ models: {} }),
});

/**
 * Adds one summary reply's usage in the commit that records the reply, as pi-durable's compaction adds its own
 * summarization spend to `pi.usage` (`recordUsage` in its `harness/usage.js`, which it does not export): every
 * counter, an optional one once either side reports it.
 */
export async function recordMemoryUsage(tx: Tx, root: ConversationId, model: string, usage: Usage): Promise<void> {
  const totals = (await tx.doc(MemoryUsageDoc, root)).models;
  // Own keys only, as pi-durable reads its ledger.
  if (!Object.hasOwn(totals, model)) {
    totals[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  }
  const total = totals[model];
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;
  if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
  total.cost.input += usage.cost.input;
  total.cost.output += usage.cost.output;
  total.cost.cacheRead += usage.cost.cacheRead;
  total.cost.cacheWrite += usage.cost.cacheWrite;
  total.cost.total += usage.cost.total;
}

/** One line of what the conversation has spent: a model's answers, or its summaries for memory. */
export const UsageRowSchema = obj({
  /** `provider/modelId`, as pi-durable keys its ledger. */
  model: str(),
  /** Spent writing memory's summaries rather than answering. */
  memory: bool(),
  input: num(),
  cacheRead: num(),
  cacheWrite: num(),
  output: num(),
  /** US dollars at list price, as pi-ai computes it from the model's rates. */
  cost: num(),
}, { open: true });
export type UsageRow = Static<typeof UsageRowSchema>;
export const InfiniChatUsageSchema = arr(UsageRowSchema);
export type InfiniChatUsage = Static<typeof InfiniChatUsageSchema>;

/** One ledger's rows, the dearest first. */
export function usageRows(models: Readonly<Ledger>, memory: boolean): UsageRow[] {
  return Object.entries(models).map(([model, usage]) => ({ model, memory, input: usage.input,
    cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output, cost: usage.cost.total }))
    .sort((left, right) => right.cost - left.cost);
}
