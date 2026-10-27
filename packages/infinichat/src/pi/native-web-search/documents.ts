import { defineDoc } from '@earendil-works/pi-durable';

/** One hosted call's presentation state, in the order the provider reported it. */
export type SearchCallPresentation = {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  action: 'search' | 'open_page' | 'find_in_page';
  queries?: string[];
  url?: string;
  pattern?: string;
};

export type SearchSource = { url: string; title?: string };

/** What a chat needs to show one response's search activity, sources and citations. */
export type SearchPresentation = {
  calls: SearchCallPresentation[];
  /** Sources found, first occurrence kept: action sources, then results. */
  sources: SearchSource[];
  /** Pages the answer cited, in citation order. */
  cited: SearchSource[];
};

export type SearchPresentationsState = {
  /** Keyed by `responseId`, which pi-ai sets from `response.created` before any search event. */
  responses: Record<string, SearchPresentation>;
  /** The latest request that produced search activity; the live row uses it while its run is busy. */
  live?: { responseId: string; taskId: number };
};

/**
 * One presentation document per chat, created in `createConversation`'s `init` (as examples 06 and 29 create a
 * document they later read), so a chat view observes it from the start and nothing attaches late. `history: 'latest'`
 * because nothing reads it rewindably; `fork: 'current'` so a fork keeps showing the searches of the answers it
 * inherited.
 */
export const SearchPresentationsDoc = defineDoc<SearchPresentationsState>({
  kind: 'app.openai.search', version: 1, scope: 'conversation', history: 'latest', fork: 'current',
  checkpointWhen: () => false,
  initial: () => ({ responses: {} }),
});
