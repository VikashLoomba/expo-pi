import type { ConversationId, Cursor, EntryId, Tx } from '@earendil-works/pi-durable';

import { SearchObservationsDoc } from './documents';
import { SearchObservationChangeEntry } from './observations';
import type { NativeResponseRecord } from './types';

/**
 * Locate the genuine user submission behind a pinned request. Application source
 * observations also contribute user-role messages, so their entry kind must never
 * become a new logical turn. Later tool rounds retain the same pi.user identity.
 */
export async function captureRequestOrigin(
  tx: Tx, conversationId: ConversationId, cutoff: EntryId,
): Promise<EntryId | undefined> {
  let cursor: Cursor | undefined;
  let head: EntryId | undefined;
  const omitted = new Map<EntryId, boolean>();
  do {
    const page = await tx.scanEntries({ conversationId, maxEntryId: cutoff }, 100, cursor);
    for (const entry of page.items) {
      if (head !== undefined && entry.id < head) return undefined;
      for (const edit of [...entry.edits ?? []].reverse()) {
        if (!omitted.has(edit.target)) omitted.set(edit.target, edit.action === 'omit');
      }
      if (head === undefined && entry.head !== undefined) head = entry.head;
      if (entry.kind === 'pi.user' && !omitted.get(entry.id)) return entry.id;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return undefined;
}

/**
 * A response may finish after its context was reset or compacted. Keep its raw
 * archive, but do not append fresh evidence past a boundary that excluded the
 * request. This checks public head markers inside the same save transaction.
 */
export async function requestStillInContext(
  tx: Tx, conversationId: ConversationId, record: NativeResponseRecord,
): Promise<boolean> {
  if (record.cutoff === undefined) return true;
  const marker = await tx.latestHeadMarker(conversationId);
  return !marker || marker.head <= record.cutoff;
}

/** An explicit context edit wins over later delivery of provider enrichment. */
export async function preserveObservationEdits(tx: Tx, conversationId: ConversationId, record: NativeResponseRecord) {
  const index = await tx.doc(SearchObservationsDoc, conversationId);
  const pending = new Map(Object.values(index.observations)
    .filter((reference) => reference.requestId === record.requestId && !reference.disabled)
    .map((reference) => [reference.entryId, reference]));
  if (!pending.size) return;
  const oldest = Math.min(...pending.keys());
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId, minEntryId: oldest as EntryId }, 100, cursor);
    for (const entry of page.items) for (const edit of [...entry.edits ?? []].reverse()) {
      const reference = pending.get(edit.target);
      if (!reference) continue;
      // The most recent override is authoritative. Our own enrichment may be
      // enriched again; a deliberate external omission/replacement may not.
      if (!SearchObservationChangeEntry.is(entry) ||
          (entry.data.reason !== 'enriched' && entry.data.reason !== 'budget-excluded')) reference.disabled = true;
      pending.delete(edit.target);
    }
    if (!pending.size) return;
    cursor = page.next;
  } while (cursor !== undefined);
}
