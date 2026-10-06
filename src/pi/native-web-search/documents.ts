import { defineDoc } from '@earendil-works/pi-durable';

import type { NativeResponseRecord } from './types';

export type NativeResponsesState = { responses: Record<string, NativeResponseRecord> };
export type NativeLiveState = { requestId?: string; taskId?: number };

/** Raw provider output remains authoritative for native state and presentation. */
export const NativeResponsesDoc = defineDoc<NativeResponsesState>({
  kind: 'app.openai.responses', version: 1, scope: 'conversation', history: 'rewindable', fork: 'asOf',
  initial: () => ({ responses: {} }),
});

/** A fork inherits historical responses, never its parent's in-flight activity. */
export const NativeLiveDoc = defineDoc<NativeLiveState>({
  kind: 'app.openai.live', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({}),
});

export type SearchObservationReference = {
  entryId: number;
  digest: string;
  requestId: string;
  nativeItemId: string;
  responseId: string;
  sourceEntryId?: number;
  originEntryId?: number;
  /** A reversible context-budget omission, distinct from a deliberate user edit. */
  budgetExcluded?: boolean;
  disabled?: boolean;
};

export type SearchObservationsState = {
  observations: Record<string, SearchObservationReference>;
  /** The newest turn edit, rejecting older requests while allowing regeneration. */
  disabledOriginCutoffs?: Record<string, number>;
  /** Legacy responses may have no recoverable user origin. */
  disabledResponses?: string[];
};

/** A turn edit invalidates observations from requests pinned before that edit. */
export function isSearchResponseInvalidated(index: SearchObservationsState, record: NativeResponseRecord): boolean {
  if (record.responseId !== undefined && index.disabledResponses?.includes(record.responseId)) return true;
  if (record.originEntryId === undefined) return false;
  const invalidatedBefore = index.disabledOriginCutoffs?.[record.originEntryId];
  return invalidatedBefore !== undefined && (record.cutoff === undefined || record.cutoff < invalidatedBefore);
}

/** Transactional index only; evidence belongs to immutable transcript entries. */
export const SearchObservationsDoc = defineDoc<SearchObservationsState>({
  kind: 'app.openai.search-observations', version: 1, scope: 'conversation', history: 'rewindable', fork: 'asOf',
  initial: () => ({ observations: {} }),
});
