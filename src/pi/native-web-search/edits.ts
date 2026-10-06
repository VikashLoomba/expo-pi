import type { ContextEdit, ConversationId, Cursor, EntryId, EntryRecord, Tx } from '@earendil-works/pi-durable';

import { NativeResponsesDoc, SearchObservationsDoc } from './documents';
import { SearchObservationChangeEntry } from './observations';

/** Raw visible history is sufficient for turn boundaries; Pi still resolves all model contributions. */
async function activeHistory(tx: Tx, conversationId: ConversationId): Promise<EntryRecord[]> {
  const marker = await tx.latestHeadMarker(conversationId);
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId,
      ...(marker ? { minEntryId: marker.head } : {}),
    }, 100, cursor);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return entries.reverse().filter((entry) => entry.head === undefined);
}

function responseIds(entry: EntryRecord): string[] {
  return entry.model?.flatMap((message) => message.role === 'assistant' && message.responseId ? [message.responseId] : []) ?? [];
}

function isTurnOutput(entry: EntryRecord): boolean {
  return entry.model?.some((message) =>
    message.role === 'assistant' || message.role === 'toolResult') === true;
}

/**
 * Editing either a user submission or any assistant in its turn invalidates that
 * turn's other answers, local results, and search observations. Preserve exactly
 * the replacement/omission requested for the target. Neighbouring turns survive.
 */
export async function editSearchTurn(tx: Tx, conversationId: ConversationId, edit: ContextEdit): Promise<void> {
  // Every table read precedes the final append. Fork-aware scans prevent an entry
  // from another conversation from becoming an edit or evidence-deletion target.
  const entries = await activeHistory(tx, conversationId);
  const target = entries.find((entry) => entry.id === edit.target);
  if (!target) throw new Error('The turn edit target is not in this conversation\'s active history.');
  if (target.kind !== 'pi.user' && !target.model?.some((message) => message.role === 'assistant')) {
    throw new Error('A logical turn edit must target a user submission or assistant response.');
  }
  const archive = await tx.doc(NativeResponsesDoc, conversationId);
  const index = await tx.doc(SearchObservationsDoc, conversationId);
  const targetResponses = new Set(responseIds(target));
  const recordedOrigins = new Set(Object.values(archive.responses)
    .filter((record) => record.responseId && targetResponses.has(record.responseId) && record.originEntryId !== undefined)
    .map((record) => record.originEntryId!));
  if (recordedOrigins.size > 1) throw new Error('The response has ambiguous logical-turn origins.');
  const precedingUser = entries.filter((entry) => entry.id <= target.id && entry.kind === 'pi.user').at(-1);
  const origin = target.kind === 'pi.user' ? target.id : [...recordedOrigins][0] ?? precedingUser?.id;
  // A compacted prefix may remove the original user entry while retaining part
  // of its turn. In that case edit only the remaining visible turn fragment.
  const start = origin === undefined ? entries[0]?.id : origin;
  const nextUser = entries.find((entry) => entry.kind === 'pi.user' && entry.id > (start ?? target.id));
  const turn = entries.filter((entry) => (start === undefined || entry.id >= start) &&
    (nextUser === undefined || entry.id < nextUser.id));
  if (!turn.some((entry) => entry.id === target.id)) {
    throw new Error('The recorded turn origin does not contain the edit target.');
  }
  const turnIds = new Set(turn.map((entry) => entry.id));
  const turnResponses = new Set(turn.flatMap(responseIds));
  const edits = new Map<EntryId, ContextEdit>();
  for (const entry of turn) if (isTurnOutput(entry)) edits.set(entry.id, { target: entry.id, action: 'omit' });
  for (const reference of Object.values(index.observations)) {
    const associated = (origin !== undefined && reference.originEntryId === origin) ||
      turnResponses.has(reference.responseId) ||
      (reference.sourceEntryId !== undefined && turnIds.has(reference.sourceEntryId as EntryId));
    if (!associated) continue;
    edits.set(reference.entryId as EntryId, { target: reference.entryId as EntryId, action: 'omit' });
    reference.disabled = true;
  }
  index.disabledResponses = [...new Set([...(index.disabledResponses ?? []), ...turnResponses])];
  // A target replacement must win over the default omission for other outputs.
  edits.set(edit.target, edit);
  const change = await tx.appendEntry(SearchObservationChangeEntry, conversationId, {
    data: { targetEntryId: edit.target, reason: 'turn-edited' }, edits: [...edits.values()],
  });
  if (origin !== undefined) index.disabledOriginCutoffs = {
    ...index.disabledOriginCutoffs, [origin]: change.id,
  };
}
