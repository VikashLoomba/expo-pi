import type { WebSearchPresentation } from '../../chat/web-search-types';
import type { SearchPresentation } from './documents';

/**
 * The committed presentation as the UI's view model. Cited pages carry no text ranges — the answer's Markdown
 * links already render — so synthesized citations only order the sources list and carry its "Cited" badge until
 * WS-2 removes the field.
 */
export function toWebSearchPresentation(responseId: string, presentation: SearchPresentation): WebSearchPresentation {
  return {
    calls: presentation.calls,
    citations: presentation.cited.map((source, index) => ({
      id: `${responseId}:citation:${index}`, url: source.url, title: source.title ?? source.url,
      startIndex: 0, endIndex: 0,
    })),
    sources: presentation.sources,
  };
}

/** A response did search work worth showing (a call, or a citation without one). */
export function hasSearchActivity(presentation: SearchPresentation): boolean {
  return presentation.calls.length > 0 || presentation.cited.length > 0;
}
