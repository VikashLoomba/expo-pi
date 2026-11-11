import type { UsageRow } from '../pi/infinichat/usage';

/** What the Usage sections say under their rows. */
export const USAGE_NOTE = 'List prices, from each model’s rates: a subscription sign-in isn’t billed per token. '
  + 'Memory is what writing summaries has spent since InfiniChat began counting it.';

const count = (tokens: number): string => tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M`
  : tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens);

export const usageTitle = (row: UsageRow): string => row.memory ? `Memory · ${row.model}` : row.model;

/** The tokens a row read and wrote, and how much of what it read came from the provider's cache. */
export function usageDetail(row: UsageRow): string {
  const read = row.input + row.cacheRead + row.cacheWrite;
  const cached = read > 0 ? ` · ${Math.round(100 * row.cacheRead / read)}% from cache` : '';
  return `${count(read)} tokens in, ${count(row.output)} out${cached}`;
}

export const usageCost = (dollars: number): string => `$${dollars.toFixed(2)}`;
export const usageTotal = (rows: readonly UsageRow[]): number => rows.reduce((sum, row) => sum + row.cost, 0);
