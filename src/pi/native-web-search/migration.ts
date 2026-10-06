import type { Context } from '@earendil-works/chord';
import type { AssistantMessage, Message, UserMessage } from '@earendil-works/pi-ai';
import type { ContextView, ConversationId, EntryId, Harness } from '@earendil-works/pi-durable';

import { isSearchResponseInvalidated, NativeResponsesDoc, SearchObservationsDoc } from './documents';
import { projectSearchEvidence } from './evidence';
import { observationKey, persistSearchObservations } from './observations';
import type { NativeResponseRecord } from './types';

type SkipReason = 'missing-response-id' | 'missing-normalized-content' | 'ambiguous-response-id'
  | 'no-active-assistant' | 'content-changed' | 'outside-request' | 'outside-context' | 'beyond-cutoff'
  | 'already-indexed' | 'no-readable-results' | 'disabled-turn';

export type SearchMigrationReport = {
  recordsExamined: number;
  recordsMigrated: number;
  observationsAdded: number;
  observationsForwarded: number;
  skipped: Partial<Record<SkipReason, number>>;
};

export type SearchMigrationOptions = {
  /** The prepared request may contain fewer messages than current active context. */
  messages?: readonly Message[];
  /** An already-prepared request cannot see newly appended entries without a hook result. */
  cutoff?: EntryId;
};

type Source = { entryId: EntryId; message: AssistantMessage };
const emptyReport = (): SearchMigrationReport => ({
  recordsExamined: 0, recordsMigrated: 0, observationsAdded: 0, observationsForwarded: 0, skipped: {},
});
const skip = (report: SearchMigrationReport, reason: SkipReason) => {
  report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
};

function activeSources(view: ContextView): Map<string, Source[]> {
  const sources = new Map<string, Source[]>();
  for (const [index, entry] of view.entries.entries()) {
    for (const message of view.contributions[index]) {
      if (message.role !== 'assistant' || !message.responseId) continue;
      const matches = sources.get(message.responseId) ?? [];
      matches.push({ entryId: entry.id, message });
      sources.set(message.responseId, matches);
    }
  }
  return sources;
}

function matchesRecord(message: Message, record: NativeResponseRecord): boolean {
  return message.role === 'assistant' && message.responseId === record.responseId &&
    message.provider === record.provider && message.api === 'openai-responses' && message.model === record.model &&
    JSON.stringify(message.content) === record.normalizedContent;
}

function eligibleSource(
  record: NativeResponseRecord, sources: Map<string, Source[]>, identities: Map<string, number>,
  options: SearchMigrationOptions, report: SearchMigrationReport, head?: EntryId,
): Source | undefined {
  if (record.cutoff !== undefined && head !== undefined && head > record.cutoff) {
    skip(report, 'outside-context'); return;
  }
  if (!record.responseId) { skip(report, 'missing-response-id'); return; }
  if (record.normalizedContent === undefined) { skip(report, 'missing-normalized-content'); return; }
  const candidates = sources.get(record.responseId) ?? [];
  if (identities.get(record.responseId) !== 1 || candidates.length > 1) {
    skip(report, 'ambiguous-response-id'); return;
  }
  const source = candidates[0];
  if (!source) { skip(report, 'no-active-assistant'); return; }
  if (!matchesRecord(source.message, record)) { skip(report, 'content-changed'); return; }
  if (options.cutoff !== undefined && source.entryId > options.cutoff) { skip(report, 'beyond-cutoff'); return; }
  if (options.messages && !options.messages.some((message) => matchesRecord(message, record))) {
    skip(report, 'outside-request'); return;
  }
  return source;
}

/**
 * Backfill legacy native results only while their unchanged answer remains in
 * canonical context. A prepared request can also receive eligible observations
 * that startup migration appended after its pinned cutoff. No source bodies are
 * included in the diagnostic report.
 */
export async function migrateSearchObservations(
  harness: Harness, conversationId: ConversationId, context: Context, options: SearchMigrationOptions = {},
): Promise<{ messages: UserMessage[]; report: SearchMigrationReport }> {
  const conversation = await harness.conversation(conversationId, context);
  if (!conversation || !await harness.snapshot(NativeResponsesDoc, conversationId, context)) {
    return { messages: [], report: emptyReport() };
  }
  // Context reads use Pi's public resolver, including edits, forks and heads.
  // The tail check closes the gap between that read and the atomic backfill.
  for (let attempt = 0; attempt < 4; attempt++) {
    context.abortSignal?.throwIfAborted();
    const view = await conversation.context(context);
    const tail = view.entries.reduce<EntryId | undefined>((latest, entry) =>
      latest === undefined || entry.id > latest ? entry.id : latest, undefined);
    const result = await harness.commit(async (tx) => {
      const latest = (await tx.scanEntries({ conversationId }, 1)).items[0]?.id;
      if (latest !== tail) return undefined;
      const archive = await tx.doc(NativeResponsesDoc, conversationId);
      const index = await tx.doc(SearchObservationsDoc, conversationId);
      const records = Object.values(archive.responses);
      const identities = new Map<string, number>();
      for (const record of records) if (record.responseId) {
        identities.set(record.responseId, (identities.get(record.responseId) ?? 0) + 1);
      }
      const sources = activeSources(view);
      const report = emptyReport();
      const messages: UserMessage[] = [];
      const seen = new Set(options.messages?.filter((message) => message.role === 'user')
        .map((message) => JSON.stringify(message.content)) ?? []);
      const forward = (message: UserMessage) => {
        const identity = JSON.stringify(message.content);
        if (seen.has(identity)) return;
        seen.add(identity);
        messages.push(message);
      };
      for (const record of records) {
        report.recordsExamined++;
        if (isSearchResponseInvalidated(index, record)) {
          skip(report, 'disabled-turn'); continue;
        }
        const source = eligibleSource(record, sources, identities, options, report, view.head?.head);
        if (!source) continue;
        const origin = record.originEntryId ?? view.entries.filter((entry) =>
          entry.kind === 'pi.user' && entry.id <= source.entryId).at(-1)?.id;
        if (origin !== undefined && isSearchResponseInvalidated(index, { ...record, originEntryId: origin })) {
          skip(report, 'disabled-turn'); continue;
        }
        const completedIds = new Set(record.output.flatMap((item) => item.type === 'web_search_call' &&
          item.status === 'completed' && typeof item.id === 'string' && item.id.trim() ? [item.id] : []));
        if (!completedIds.size) { skip(report, 'no-readable-results'); continue; }
        const missingIds = new Set([...completedIds].filter((id) => !index.observations[observationKey(record.requestId, id)]));
        // A bounded projection may retain only an honest omission notice. The
        // original text count distinguishes that case from absent source bodies.
        // Fully indexed requests avoid rendering large source bodies again on
        // every generation merely to discover there is nothing to migrate.
        const missing = missingIds.size ? projectSearchEvidence(record).filter((projection) =>
          missingIds.has(projection.nativeItemId) && projection.data.originalCharacters > 0) : [];
        if (missing.length) {
          const added = await persistSearchObservations(tx, conversationId, record, {
            sourceEntryId: source.entryId, nativeItemIds: missing.map((projection) => projection.nativeItemId),
          });
          report.recordsMigrated++;
          report.observationsAdded += added.length;
          added.forEach(forward);
        } else skip(report, missingIds.size ? 'no-readable-results' : 'already-indexed');
        if (options.cutoff === undefined) continue;
        for (const nativeItemId of completedIds) {
          const reference = index.observations[observationKey(record.requestId, nativeItemId)];
          if (!reference || reference.disabled || reference.budgetExcluded || reference.entryId <= options.cutoff ||
              (reference.originEntryId !== undefined && isSearchResponseInvalidated(index,
                { ...record, originEntryId: reference.originEntryId })) ||
              (reference.sourceEntryId !== undefined && reference.sourceEntryId !== source.entryId)) continue;
          const position = view.entries.findIndex((entry) => entry.id === reference.entryId);
          if (position < 0) continue;
          // Use the current canonical contribution, never reconstruct one that
          // an omission, replacement, compaction or reset removed.
          for (const message of view.contributions[position]) if (message.role === 'user') forward(message);
        }
      }
      report.observationsForwarded = messages.length;
      return { messages, report };
    }, context);
    if (result) return result;
  }
  throw new Error('Search observation migration could not obtain a stable conversation context.');
}
