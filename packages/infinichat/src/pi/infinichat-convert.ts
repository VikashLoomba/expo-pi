import type { Context } from '@earendil-works/chord/context';
import type {
  ConversationId, Cursor, DocumentRecord, Page, Storage, StorageWrite,
} from '@earendil-works/pi-durable';

/** The file a conversation was kept in before it was a Chord store: pi-durable's own SQLite storage. */
export const LEGACY_DATABASE = 'infinichat.db';

/** How many records one commit of the copy holds. */
const BATCH = 500;

/** Every item of a scan, a page at a time. */
async function* all<T>(page: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>): AsyncGenerator<T> {
  let cursor: Cursor | undefined;
  do {
    const next = await page(cursor);
    yield* next.items;
    cursor = next.next;
  } while (cursor !== undefined);
}

/** The scopes documents live in: the session's, each conversation's and each task's. */
async function* scopes(storage: Storage, context: Context): AsyncGenerator<DocumentRecord['scope']> {
  yield { kind: 'session' };
  for await (const { id } of all((cursor) => storage.scanConversations({}, BATCH, cursor, context))) {
    yield { kind: 'conversation', conversationId: id };
  }
  for await (const { id } of all((cursor) => storage.scanTasks({}, BATCH, cursor, context))) {
    yield { kind: 'task', taskId: id };
  }
}

/**
 * Every current record of `from` as the write that stores it: the conversations, tasks, submissions and entries as
 * they are, under their own IDs, and each document that is not retired as one base of its current value. It is what a
 * Harness reads when it opens. What it leaves is history no part of InfiniChat reads: a document's earlier revisions,
 * and the commit each record was written by, which the copy's own commits replace.
 */
async function* records(from: Storage, context: Context): AsyncGenerator<StorageWrite> {
  const conversations: ConversationId[] = [];
  for await (const value of all((cursor) => from.scanConversations({}, BATCH, cursor, context))) {
    conversations.push(value.id);
    yield { type: 'conversation', value };
  }
  for await (const value of all((cursor) => from.scanTasks({}, BATCH, cursor, context))) yield { type: 'task', value };
  for await (const value of all((cursor) => from.scanSubmissions({}, BATCH, cursor, context))) {
    yield { type: 'submission', value };
  }
  for (const conversationId of conversations) {
    const query = { conversationId, order: 'ascending' } as const;
    for await (const value of all((cursor) => from.scanEntries(query, BATCH, cursor, context))) {
      // A fork's scan reaches its ancestors' entries too: each entry is written once, with its own conversation.
      if (value.conversationId === conversationId) yield { type: 'entry', value };
    }
  }
  for await (const scope of scopes(from, context)) {
    const query = { scope, at: 'current' } as const;
    for await (const listed of all((cursor) => from.scanDocuments(query, BATCH, cursor, context))) {
      const stored = await from.document(listed.id, 'current', context);
      if (!stored) throw new Error(`Document ${listed.id} of the conversation could not be read.`);
      const { createdAt: _stamped, retiredAt: _current, ...record } = stored.record;
      yield { type: 'document.create', record, content: { version: stored.version, kind: 'base', value: stored.value } };
    }
  }
}

/** How many records of each kind a storage holds, as `records` reads them. */
async function count(storage: Storage, context: Context): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for await (const write of records(storage, context)) counts[write.type] = (counts[write.type] ?? 0) + 1;
  return counts;
}

/**
 * Copies a conversation from `from` into `to`, which is empty, through pi-durable's `Storage` interface alone, so
 * between any two of its storages: here from the SQLite storage the releases before kept it in, into its storage in a
 * Chord store. pi-durable has no such copy of its own. The records keep their IDs, and the copy's next ID is past
 * them all, as a storage raises it for every ID it is given. Rejects when `to` refuses a record or ends with other
 * counts than were read, before its caller lets go of `from`.
 */
export async function convertConversation(from: Storage, to: Storage, context: Context): Promise<void> {
  const copied: Record<string, number> = {};
  let batch: StorageWrite[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const result = await to.commit([batch], () => {}, context);
    if (result.stored !== 1) {
      const reason = result.refused instanceof Error ? result.refused.message : String(result.refused);
      throw new Error(`The conversation could not be converted: ${reason}`);
    }
    batch = [];
  };
  for await (const write of records(from, context)) {
    copied[write.type] = (copied[write.type] ?? 0) + 1;
    batch.push(write);
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  const found = await count(to, context);
  for (const [type, read] of Object.entries(copied)) {
    if (found[type] !== read) {
      throw new Error(`The conversation could not be converted: ${read} ${type} records were read and `
        + `${found[type] ?? 0} were stored.`);
    }
  }
}
