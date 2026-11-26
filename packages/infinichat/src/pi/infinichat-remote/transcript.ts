import type { ChatMessage, TranscriptGap } from '../../chat/types';
import type { HistoryPage, HistoryPageQuery, TranscriptBounds } from '../infinichat-view';

type Segment = {
  readonly firstEntryId: number;
  readonly lastEntryId: number;
  readonly messages: readonly ChatMessage[];
};

const NO_MESSAGES: readonly ChatMessage[] = [];

const isEarlierRow = (row: ChatMessage): boolean => row.history?.kind === 'earlier';

/**
 * Client-side transcript accumulator over a server's bounded live window.
 *
 * The server only mirrors pi-durable's bounded live `ConversationView` window in `messages` so no Chord state part
 * can ever grow past the 16 MiB wire limit. Each client keeps its own loaded history segments and gaps here, paging
 * older turns on demand through `loadHistory` without affecting any other client.
 */
export class RemoteTranscript {
  private segments: Segment[] = [];
  private gaps: TranscriptGap[] = [];
  private oldestBefore?: number;
  private liveRows: readonly ChatMessage[] = NO_MESSAGES;
  private liveBounds?: TranscriptBounds;
  private lastLiveMessages?: readonly ChatMessage[];
  private lastLiveBounds?: TranscriptBounds | null;
  private combined: readonly ChatMessage[] = NO_MESSAGES;
  private loadingEarlier?: Promise<boolean>;
  private readonly loadingGaps = new Map<string, Promise<boolean>>();

  getMessages(): readonly ChatMessage[] {
    return this.combined;
  }

  /** Resets all locally cached pages (for example when the server no longer holds the conversation). */
  reset(): void {
    if (this.segments.length === 0 && this.gaps.length === 0 && this.oldestBefore === undefined
      && this.liveRows.length === 0 && this.liveBounds === undefined) {
      return;
    }
    this.segments = [];
    this.gaps = [];
    this.oldestBefore = undefined;
    this.liveRows = NO_MESSAGES;
    this.liveBounds = undefined;
    this.lastLiveMessages = undefined;
    this.lastLiveBounds = undefined;
    this.combined = NO_MESSAGES;
  }

  /**
   * Merges a new live window snapshot from the server. Preserves any older segments this client already paged in,
   * opening a `gap` row if the server's live window advanced past the last archived segment.
   */
  applyLive(messages: readonly ChatMessage[], bounds: TranscriptBounds | null | undefined): void {
    if (messages === this.lastLiveMessages && bounds === this.lastLiveBounds) return;
    this.lastLiveMessages = messages;
    this.lastLiveBounds = bounds;
    if (bounds === null) {
      this.reset();
      return;
    }
    if (bounds === undefined) {
      // Defensive fallback before bounds arrive: mirror raw messages without mutating archived state.
      this.liveRows = messages;
      this.combined = messages;
      return;
    }
    const stripped = messages.length > 0 && isEarlierRow(messages[0]) ? messages.slice(1) : messages;
    const liveFirst = bounds.firstEntryId;
    if (liveFirst !== undefined) {
      // Drop any archived segment or gap that overlaps the live window (e.g. after a conversation switch).
      this.segments = this.segments.filter((segment) => segment.lastEntryId < liveFirst);
      this.gaps = this.gaps.filter((gap) => gap.upTo <= liveFirst);
    }
    if (this.segments.length === 0) {
      this.oldestBefore = bounds.before;
      this.gaps = [];
    } else {
      const last = this.segments[this.segments.length - 1];
      // Remove any previous trailing gap from the last segment to an older live window.
      this.gaps = this.gaps.filter((gap) => gap.after < last.lastEntryId);
      if (liveFirst !== undefined && bounds.before !== undefined && bounds.before > last.lastEntryId) {
        this.gaps.push({ after: last.lastEntryId, upTo: liveFirst });
      }
    }
    this.liveRows = stripped;
    this.liveBounds = bounds;
    this.rebuild();
  }

  /** Loads one page strictly before the oldest entry this client holds; shares concurrent requests. */
  loadEarlier(fetch: (query: HistoryPageQuery) => Promise<HistoryPage>): Promise<boolean> {
    if (this.oldestBefore === undefined) return Promise.resolve(false);
    if (this.loadingEarlier !== undefined) return this.loadingEarlier;
    const before = this.oldestBefore;
    const run = Promise.resolve().then(async () => {
      const page = await fetch({ before });
      // Ignore if the transcript was reset or already loaded past this cursor while the RPC was in flight.
      if (this.oldestBefore !== before) return false;
      if (page.firstEntryId !== undefined && page.lastEntryId !== undefined) {
        const nextFirst = this.segments[0]?.firstEntryId ?? this.liveBounds?.firstEntryId;
        if (nextFirst === undefined || page.lastEntryId < nextFirst) {
          this.segments = [{
            firstEntryId: page.firstEntryId,
            lastEntryId: page.lastEntryId,
            messages: page.messages,
          }, ...this.segments];
        }
      }
      this.oldestBefore = page.more ? page.before : undefined;
      this.rebuild();
      return true;
    });
    this.loadingEarlier = run;
    const clear = () => {
      if (this.loadingEarlier === run) this.loadingEarlier = undefined;
    };
    run.then(clear, clear);
    return run;
  }

  /** Loads the next ascending page inside `gap`; shares concurrent requests for the same gap. */
  fillGap(gap: TranscriptGap, fetch: (query: HistoryPageQuery) => Promise<HistoryPage>): Promise<boolean> {
    const current = this.gaps.find((each) => each.after === gap.after && each.upTo === gap.upTo)
      ?? this.gaps.find((each) => each.after < gap.upTo && gap.after < each.upTo);
    if (current === undefined) return Promise.resolve(false);
    const key = `${current.after}:${current.upTo}`;
    const running = this.loadingGaps.get(key);
    if (running !== undefined) return running;
    const run = Promise.resolve().then(async () => {
      const page = await fetch({ after: current.after, upTo: current.upTo });
      const index = this.gaps.findIndex((each) => each.after === current.after && each.upTo === current.upTo);
      if (index < 0) return false;
      if (page.firstEntryId !== undefined && page.lastEntryId !== undefined) {
        this.insertSegment({
          firstEntryId: page.firstEntryId,
          lastEntryId: page.lastEntryId,
          messages: page.messages,
        });
      }
      if (page.more && page.lastEntryId !== undefined && page.lastEntryId < current.upTo) {
        this.gaps = [
          ...this.gaps.slice(0, index),
          { after: page.lastEntryId, upTo: current.upTo },
          ...this.gaps.slice(index + 1),
        ];
      } else {
        this.gaps = [...this.gaps.slice(0, index), ...this.gaps.slice(index + 1)];
      }
      this.rebuild();
      return true;
    });
    this.loadingGaps.set(key, run);
    const clear = () => {
      if (this.loadingGaps.get(key) === run) this.loadingGaps.delete(key);
    };
    run.then(clear, clear);
    return run;
  }

  private insertSegment(segment: Segment): void {
    const next = [...this.segments.filter((each) =>
      each.lastEntryId < segment.firstEntryId || each.firstEntryId > segment.lastEntryId), segment];
    next.sort((left, right) => left.firstEntryId - right.firstEntryId);
    this.segments = next;
  }

  private rebuild(): void {
    const out: ChatMessage[] = [];
    const seen = new Set<string>();
    const push = (row: ChatMessage) => {
      if (seen.has(row.id)) return;
      seen.add(row.id);
      out.push(row);
    };
    if (this.oldestBefore !== undefined) {
      const oldestFirst = this.segments[0]?.firstEntryId ?? this.liveBounds?.firstEntryId;
      push({
        id: `history-earlier-${oldestFirst ?? 'start'}`,
        role: 'notice',
        text: 'Earlier messages',
        createdAt: 0,
        history: { kind: 'earlier' },
      });
    }
    for (const segment of this.segments) {
      for (const row of segment.messages) push(row);
      const gap = this.gaps.find((each) => each.after === segment.lastEntryId);
      if (gap !== undefined) {
        push({
          id: `history-${gap.after}-${gap.upTo}`,
          role: 'notice',
          text: 'More messages',
          createdAt: 0,
          history: { kind: 'gap', after: gap.after, upTo: gap.upTo },
        });
      }
    }
    for (const row of this.liveRows) push(row);
    this.combined = out;
  }
}
