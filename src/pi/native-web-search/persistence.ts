import type { ConversationId, Tx } from '@earendil-works/pi-durable';

import { NativeLiveDoc, NativeResponsesDoc } from './documents';
import { preserveObservationEdits, requestStillInContext } from './lifecycle';
import { persistSearchObservations } from './observations';
import { copyJson, type NativeResponseRecord } from './types';

/** The archive, readable observations, and deduplication index share one commit. */
export async function persistNativeResponse(tx: Tx, conversationId: ConversationId, record: NativeResponseRecord) {
  // Complete table reads before staging any writes on the transaction line.
  const active = await requestStillInContext(tx, conversationId, record);
  await preserveObservationEdits(tx, conversationId, record);
  const archive = await tx.doc(NativeResponsesDoc, conversationId);
  const previous = archive.responses[record.requestId];
  if (previous?.responseId && record.responseId && previous.responseId !== record.responseId) {
    throw new Error('A native request cannot change its response identity.');
  }
  archive.responses[record.requestId] = copyJson(record);
  if (active) await persistSearchObservations(tx, conversationId, record);
  const live = await tx.doc(NativeLiveDoc, conversationId);
  if (live.requestId === undefined || live.requestId === record.requestId) {
    live.requestId = record.requestId;
    live.taskId = record.taskId;
  }
}
