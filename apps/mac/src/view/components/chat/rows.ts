import type { ChatMessage } from '@pi-agent/infinichat/chat/types';

/**
 * A row of the thread. A run of tool calls is one row with one Trace, as the chatbot template groups an agent's
 * steps between its text; every other message is its own row; the working line is the last row while the agent is
 * busy without a streaming row of its own.
 */
export type Row = { kind: 'message'; id: string; message: ChatMessage }
  | { kind: 'steps'; id: string; messages: ChatMessage[] }
  | { kind: 'working'; id: 'working'; text: string };

export function rowsOf(messages: readonly ChatMessage[], working: string | undefined): Row[] {
  const rows: Row[] = [];
  for (const message of messages) {
    const last = rows.at(-1);
    if (message.role === 'tool' && message.tool) {
      if (last?.kind === 'steps') last.messages.push(message);
      else rows.push({ kind: 'steps', id: message.id, messages: [message] });
    } else {
      rows.push({ kind: 'message', id: message.id, message });
    }
  }
  if (working !== undefined) rows.push({ kind: 'working', id: 'working', text: working });
  return rows;
}

/** The id of the person's turn when it is the newest message, so the thread can settle it near the top. */
export function newestTurn(rows: readonly Row[]): string | undefined {
  const last = rows.at(-1)?.kind === 'working' ? rows.at(-2) : rows.at(-1);
  return last?.kind === 'message' && last.message.role === 'user' ? last.id : undefined;
}
