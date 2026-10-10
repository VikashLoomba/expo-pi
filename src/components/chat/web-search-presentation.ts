import type { WebSearchCall, WebSearchPresentation, WebSearchSource } from '../../chat/web-search-types';
import { safeSourceUrl } from '../../chat/web-search-url';

export { safeSourceUrl } from '../../chat/web-search-url';

export interface SearchSource extends WebSearchSource {
  number: number;
  title: string;
  host: string;
  cited: boolean;
}

export function sourceHost(value: string): string {
  const url = safeSourceUrl(value);
  return url ? new URL(url).hostname.replace(/^www\./, '') : 'Web page';
}

export function searchCallLabel(call: WebSearchCall): string {
  if (call.status === 'failed') return 'Web search failed';
  if (call.status === 'interrupted') return 'Search interrupted';
  const running = call.status === 'running';
  if (call.action === 'open_page') return running ? 'Opening a page' : 'Opened a page';
  if (call.action === 'find_in_page') return running ? 'Finding text on a page' : 'Searched a page for text';
  return running ? 'Searching the web' : 'Searched the web';
}

/** The presentation already orders sources: cited pages first, then the other results. Number them and fill. */
export function collectSearchSources(presentation: WebSearchPresentation): readonly SearchSource[] {
  const sources: SearchSource[] = [];
  for (const source of presentation.sources) {
    const url = safeSourceUrl(source.url);
    if (!url) continue;
    const title = source.title?.trim();
    const host = sourceHost(url);
    sources.push({ number: sources.length + 1, url, title: title || host, host, cited: source.cited === true });
  }
  return sources;
}
