import type { WebSearchPresentation, WebSearchSource } from '../../chat/web-search-types';
import { safeSourceUrl } from '../../chat/web-search-url';
import type { SearchPresentation, SearchSource } from './documents';

/** A citation matches its result ignoring the `utm_source=openai` the provider appends to cited URLs. */
function citationKey(value: string): string | undefined {
  const url = safeSourceUrl(value);
  if (!url) return undefined;
  const parsed = new URL(url);
  if (parsed.searchParams.get('utm_source') === 'openai') parsed.searchParams.delete('utm_source');
  return parsed.toString();
}

/**
 * The committed presentation as the UI's view model: the union of the calls' results and the cited URLs,
 * cited pages first, each once. The answer's citations render as the Markdown links the model already wrote.
 */
export function toWebSearchPresentation(presentation: SearchPresentation): WebSearchPresentation {
  const seen = new Set<string>();
  const sources: WebSearchSource[] = [];
  const add = (source: SearchSource, cited: boolean) => {
    const key = citationKey(source.url);
    if (key === undefined || seen.has(key)) return;
    seen.add(key);
    sources.push({ url: source.url, ...(source.title ? { title: source.title } : {}),
      ...(cited ? { cited: true } : {}) });
  };
  presentation.cited.forEach((source) => add(source, true));
  presentation.sources.forEach((source) => add(source, false));
  return { calls: presentation.calls, sources };
}

/** A response did search work worth showing (a call, or a citation without one). */
export function hasSearchActivity(presentation: SearchPresentation): boolean {
  return presentation.calls.length > 0 || presentation.cited.length > 0;
}
