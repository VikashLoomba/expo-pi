import type { UserMessage } from '@earendil-works/pi-ai';
import {
  defineEntry,
  type ConversationId, type EntryId, type EntryRecord, type Tx,
} from '@earendil-works/pi-durable';

import { isSearchResponseInvalidated, SearchObservationsDoc } from './documents';
import { projectSearchEvidence } from './evidence';
import type { NativeResponseRecord } from './types';

export type SearchObservationData = ReturnType<typeof projectSearchEvidence>[number]['data'];
export const SearchObservationEntry = defineEntry<SearchObservationData>('app.openai.search-observation');
export const SearchObservationChangeEntry = defineEntry<{
  requestId?: string;
  nativeItemId?: string;
  targetEntryId?: number;
  evidence?: SearchObservationData;
  reason: 'enriched' | 'budget-excluded' | 'turn-edited';
}>('app.openai.search-observation-change');

export function isSearchObservationEntry(entry: EntryRecord): boolean {
  return SearchObservationEntry.is(entry) || SearchObservationChangeEntry.is(entry);
}

export function observationKey(requestId: string, nativeItemId: string): string {
  return JSON.stringify([requestId, nativeItemId]);
}

function observationTime(record: NativeResponseRecord): number {
  if (typeof record.response?.created_at === 'number') return record.response.created_at * 1000;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(record.requestId)
    ? Number.parseInt(record.requestId.replaceAll('-', '').slice(0, 12), 16) : 0;
}

/** Called in the same transaction that archives the corresponding native snapshot. */
export async function persistSearchObservations(
  tx: Tx, conversationId: ConversationId, record: NativeResponseRecord,
  options: { sourceEntryId?: EntryId; nativeItemIds?: readonly string[] } = {},
): Promise<UserMessage[]> {
  const selected = projectSearchEvidence(record);
  const projections = selected.filter((projection) =>
    !options.nativeItemIds || options.nativeItemIds.includes(projection.nativeItemId));
  if (!record.responseId) return [];
  const index = await tx.doc(SearchObservationsDoc, conversationId);
  if (isSearchResponseInvalidated(index, record)) return [];
  const added: UserMessage[] = [];
  const selectedIds = new Set(selected.map((projection) => projection.nativeItemId));
  // Earlier native output positions may complete after later ones. Reconcile the
  // whole request selection so previously materialized calls cannot accumulate
  // beyond the aggregate budget. Deliberate user edits remain non-reversible.
  for (const reference of Object.values(index.observations)) {
    if (reference.requestId !== record.requestId || reference.disabled || reference.budgetExcluded ||
        selectedIds.has(reference.nativeItemId)) continue;
    await tx.appendEntry(SearchObservationChangeEntry, conversationId, {
      data: { requestId: record.requestId, nativeItemId: reference.nativeItemId, reason: 'budget-excluded' },
      edits: [{ target: reference.entryId as EntryId, action: 'omit' }],
    });
    reference.budgetExcluded = true;
  }
  for (const projection of projections) {
    const key = observationKey(record.requestId, projection.nativeItemId);
    const previous = index.observations[key];
    // Context edits are deliberate. Later native snapshots must not undo them.
    if (previous?.disabled || (previous?.digest === projection.digest && !previous.budgetExcluded)) continue;
    const message: UserMessage = { role: 'user', content: projection.content, timestamp: observationTime(record) };
    if (previous) {
      await tx.appendEntry(SearchObservationChangeEntry, conversationId, {
        data: { requestId: record.requestId, nativeItemId: projection.nativeItemId,
          reason: 'enriched', evidence: projection.data },
        edits: [{ target: previous.entryId as EntryId, action: 'replace', messages: [message] }],
      });
      previous.digest = projection.digest;
      delete previous.budgetExcluded;
    } else {
      const entry = await tx.appendEntry(SearchObservationEntry, conversationId, {
        data: projection.data, model: [message],
      });
      index.observations[key] = {
        entryId: entry.id, digest: projection.digest, requestId: record.requestId,
        nativeItemId: projection.nativeItemId, responseId: record.responseId!,
        ...(options.sourceEntryId === undefined ? {} : { sourceEntryId: options.sourceEntryId }),
        ...(record.originEntryId === undefined ? {} : { originEntryId: record.originEntryId }),
      };
    }
    added.push(message);
  }
  return added;
}
