import type { ChatMessage } from './types';

/**
 * A turn of the thread: the input that opened it (OptChat's fresh turn: the person's message, or an agent's report
 * delivered on its own) and everything until the next, steers included.
 */
export interface Turn {
  id: string;
  rows: readonly ChatMessage[];
  opener?: ChatMessage;
}

/** An input opens a turn unless it steered the one under way; a queued input is a turn of its own until placed. */
const opens = (row: ChatMessage): boolean => row.fresh === true
  || (row.fresh === undefined && (row.role === 'user' || row.role === 'work') && row.queued?.mode !== 'steer');

export function turnsOf(messages: readonly ChatMessage[]): Turn[] {
  const turns: (Turn & { rows: ChatMessage[] })[] = [];
  for (const row of messages) {
    const current = turns.at(-1);
    if (current === undefined || opens(row)) {
      turns.push({ id: row.id, rows: [row], opener: opens(row) ? row : undefined });
    } else current.rows.push(row);
  }
  return turns;
}

/**
 * A turn as the thread shows it folded (owner, 2026-10-29: "just collapse the transcript turns and show agent
 * responses and user messages"): the person's messages and the agent's replies are shown, and the steps between
 * them, the thinking, searches, tool calls and reports, are a run that opens as the Chain of Thought pattern opens
 * an agent's steps. A reply's own thinking and searches belong to the run before it, so its row is in both.
 */
export type Block = { kind: 'message'; row: ChatMessage } | { kind: 'steps'; id: string; rows: ChatMessage[] };

const replies = (row: ChatMessage): boolean => row.role === 'assistant' && (row.text !== '' || row.error !== undefined);
const steps = (row: ChatMessage): boolean => row.role === 'assistant'
  ? (row.thinking !== undefined && row.thinking !== '') || row.webSearch !== undefined || !replies(row)
  : row.role !== 'user';

export function blocksOf(rows: readonly ChatMessage[]): Block[] {
  const blocks: Block[] = [];
  for (const row of rows) {
    if (steps(row)) {
      const last = blocks.at(-1);
      if (last?.kind === 'steps') last.rows.push(row);
      else blocks.push({ kind: 'steps', id: `steps-${row.id}`, rows: [row] });
    }
    if (row.role === 'user' || replies(row)) blocks.push({ kind: 'message', row });
  }
  return blocks;
}
