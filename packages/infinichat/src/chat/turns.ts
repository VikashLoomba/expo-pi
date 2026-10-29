import type { ChatMessage, MemoryView } from './types';

/** A line of the model's memory standing for some of a turn's messages, and how many turns it stands for. */
export interface MemoryLine {
  text: string;
  shared: number;
}

/**
 * A turn of the thread: the input that opened it (OptChat's fresh turn: the person's message, or an agent's report
 * delivered on its own) and everything until the next, steers included. Its memory lines are what the model holds
 * for its messages right now: one line per message while it is recent, a line merged with its neighbours' once old.
 */
export interface Turn {
  id: string;
  rows: readonly ChatMessage[];
  opener?: ChatMessage;
  lines: readonly MemoryLine[];
}

/** An input opens a turn unless it steered the one under way; a queued input is a turn of its own until placed. */
const opens = (row: ChatMessage): boolean => row.fresh === true
  || (row.fresh === undefined && (row.role === 'user' || row.role === 'work') && row.queued?.mode !== 'steer');

export function turnsOf(messages: readonly ChatMessage[], memory: MemoryView | undefined): Turn[] {
  const turns: (Omit<Turn, 'lines'> & { rows: ChatMessage[] })[] = [];
  for (const row of messages) {
    const current = turns.at(-1);
    if (current === undefined || opens(row)) {
      turns.push({ id: row.id, rows: [row], opener: opens(row) ? row : undefined });
    } else current.rows.push(row);
  }
  // Each turn's range in the memory runs from its opener's index to the next turn's; a line stands for every turn
  // whose range it overlaps.
  const starts = turns.map((turn) => turn.opener?.memory);
  const ranges = starts.map((start, index) => {
    if (start === undefined || memory === undefined) return undefined;
    const next = starts.slice(index + 1).find((later) => later !== undefined) ?? memory.count;
    return { first: start, end: next };
  });
  const overlaps = (line: MemoryView['lines'][number], range: { first: number; end: number }) =>
    line.first < range.end && line.first + line.count > range.first;
  return turns.map((turn, index) => {
    const range = ranges[index];
    const lines = range === undefined || memory === undefined ? [] : memory.lines.flatMap((line) =>
      overlaps(line, range)
        ? [{ text: line.text, shared: ranges.filter((other) => other !== undefined && overlaps(line, other)).length }]
        : []);
    return { ...turn, lines };
  });
}
