import { copyJson, isObject, type JsonObject, type NativeResponseRecord } from './types';

const terminalStatuses = new Set(['completed', 'failed', 'incomplete']);

/** Archive SDK-parsed native items. Pi remains responsible for parsing text and tool calls. */
export class NativeResponseArchive {
  private record: NativeResponseRecord;
  private readonly items = new Map<number, JsonObject>();
  private readonly seen = new Set<string>();

  constructor(initial: NativeResponseRecord) {
    this.record = copyJson(initial);
    initial.output.forEach((item, index) => this.items.set(index, copyJson(item)));
  }

  get responseId() { return this.record.responseId; }

  snapshot(): NativeResponseRecord {
    return copyJson({ ...this.record, output: [...this.items].sort(([a], [b]) => a - b).map(([, item]) => item) });
  }

  /** Returns whether durable structure changed; text deltas are checkpointed by Pi. */
  accept(value: unknown): boolean {
    if (!isObject(value) || typeof value.type !== 'string') return false;
    const event = copyJson(value);
    const type = event.type as string;
    // Text/reasoning deltas already belong to Pi's live message. Keep native
    // structural events and original item snapshots, without a second parser.
    if (type.endsWith('.delta')) return false;
    // Sequence numbers are scoped to a single Responses stream, not a conversation.
    const identity = typeof event.sequence_number === 'number' ? `seq:${event.sequence_number}` : JSON.stringify(event);
    if (identity && this.seen.has(identity)) return false;
    if (identity) this.seen.add(identity);
    this.record.events.push(event);

    if (isObject(event.response)) {
      const response = event.response;
      if (typeof response.id === 'string') this.record.responseId = response.id;
      this.record.response = { ...this.record.response, ...response };
      if (Array.isArray(response.output)) {
        response.output.forEach((item, index) => {
          if (isObject(item)) this.mergeItem(index, item, true);
        });
      }
      if (type === 'response.completed') this.record.status = 'completed';
      else if (type === 'response.failed') this.record.status = 'failed';
      else if (type === 'response.incomplete') this.record.status = 'incomplete';
    }

    const index = typeof event.output_index === 'number' ? event.output_index : undefined;
    if (index !== undefined) {
      if (isObject(event.item)) this.mergeItem(index, event.item, type === 'response.output_item.done');
    }
    return true;
  }

  finish(status: NativeResponseRecord['status'], error?: string) {
    // A transport or persistence error takes precedence over a terminal event
    // which has not yet produced a successfully persisted Pi assistant message.
    if (status !== 'completed' || this.record.status === 'in_progress') this.record.status = status;
    if (error) this.record.error = error;
  }

  private mergeItem(index: number, next: JsonObject, authoritative: boolean) {
    const previous = this.items.get(index);
    if (!previous) { this.items.set(index, copyJson(next)); return; }
    const merged = { ...previous, ...next };
    if (!authoritative && terminalStatuses.has(String(previous.status))) merged.status = previous.status;
    if (isObject(previous.action) && isObject(next.action)) merged.action = { ...previous.action, ...next.action };
    // Completed items can add encrypted content/sources that later envelopes omit.
    // Preserve such fields, while taking returned terminal values as authoritative.
    this.items.set(index, merged);
  }

}
