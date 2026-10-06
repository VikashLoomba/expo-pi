import type { WebSearchCall, WebSearchCitation, WebSearchPresentation, WebSearchSource } from '../../chat/web-search-types';
import { safeSourceUrl } from '../../chat/web-search-url';
import { sourceRange } from './markdown/source-map';
import type { InlineFragment, InlineRun } from './markdown/types';

export { safeSourceUrl } from '../../chat/web-search-url';

export interface SearchSource extends WebSearchSource {
  number: number;
  title: string;
  host: string;
  cited: boolean;
}

export interface InlineCitation extends WebSearchCitation { number: number }
/** Rendered decoration has no source map: marker labels can be synthesized. */
export interface CitedInlineRun extends Pick<InlineRun, 'marks' | 'href'> {
  key: string;
  text: string;
  citation?: InlineCitation;
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

/** Citation numbering is shared by inline links and the source list. */
export function collectSearchSources(presentation: WebSearchPresentation): readonly SearchSource[] {
  const sources = new Map<string, SearchSource>();
  const add = (source: WebSearchSource, cited: boolean) => {
    const url = safeSourceUrl(source.url);
    if (!url) return;
    const existing = sources.get(url);
    const title = source.title?.trim();
    if (existing) {
      existing.cited ||= cited;
      if (title && existing.title === existing.host) existing.title = title;
      return;
    }
    const host = sourceHost(url);
    sources.set(url, { number: sources.size + 1, url, title: title || host, host, cited });
  };
  [...presentation.citations].sort((a, b) => a.startIndex - b.startIndex).forEach((citation) => add(citation, true));
  presentation.sources.forEach((source) => add(source, false));
  return [...sources.values()];
}

function splitsSurrogate(text: string, index: number): boolean {
  return index > 0 && index < text.length
    && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index]);
}

/** Late/invalid annotations must never truncate text or create speculative links. */
export function inlineCitations(text: string, citations: readonly WebSearchCitation[], sources: readonly SearchSource[]): readonly InlineCitation[] {
  const numbers = new Map(sources.map((source) => [source.url, source.number]));
  const seen = new Set<string>();
  return [...citations].sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex).flatMap((citation) => {
    const url = safeSourceUrl(citation.url);
    if (!url || !Number.isInteger(citation.startIndex) || !Number.isInteger(citation.endIndex)
      || citation.startIndex < 0 || citation.endIndex <= citation.startIndex || citation.endIndex > text.length
      || splitsSurrogate(text, citation.startIndex) || splitsSurrogate(text, citation.endIndex)) return [];
    const number = numbers.get(url);
    const key = `${citation.startIndex}:${citation.endIndex}:${url}`;
    if (!number || seen.has(key)) return [];
    seen.add(key);
    return [{ ...citation, url, number }];
  });
}

function nativeCitationMarkers(text: string): { start: number; end: number; complete: boolean }[] {
  const prefix = '\uE200cite\uE202';
  const markers: { start: number; end: number; complete: boolean }[] = [];
  for (let start = text.indexOf('\uE200'); start !== -1; start = text.indexOf('\uE200', start + 1)) {
    const suffix = text.slice(start);
    if (!suffix.startsWith(prefix) && !prefix.startsWith(suffix)) continue;
    const end = text.indexOf('\uE201', start + prefix.length);
    markers.push({ start, end: end === -1 ? text.length : end + 1, complete: end !== -1 });
  }
  return markers;
}

/** Decorate visible runs without reparsing Markdown or changing the archived source. */
export function citedInlineRuns(fragment: InlineFragment, citations: readonly InlineCitation[]): readonly CitedInlineRun[] {
  const markers = nativeCitationMarkers(fragment.sourceText).map((marker) => ({
    ...marker, start: fragment.key + marker.start, end: fragment.key + marker.end,
  }));
  const relevant = citations.filter((citation) => citation.endIndex > fragment.key
    && citation.startIndex < fragment.key + fragment.sourceText.length);
  if (!markers.length && !relevant.length) {
    return fragment.runs.map((run) => ({ marks: run.marks, href: run.href, text: run.text, key: String(run.key) }));
  }
  const parts: CitedInlineRun[] = [];
  const emittedMarkers = new Set<number>();
  const linked = new Set<InlineCitation>();
  const lastVisiblePart = new Map<InlineCitation, number>();
  for (const run of fragment.runs) {
    let offset = 0;
    let previousPart: CitedInlineRun | undefined;
    let previousMatches: readonly InlineCitation[] = [];
    for (const character of run.text) {
      const original = sourceRange(run.sourceSpans, offset, offset + character.length);
      const marker = original && markers.find((item) => original.start >= item.start && original.start < item.end);
      if (marker) {
        if (!emittedMarkers.has(marker.start)) {
          emittedMarkers.add(marker.start);
          const matches = marker.complete
            ? relevant.filter((citation) => citation.startIndex <= marker.start && citation.endIndex >= marker.end) : [];
          const citation = matches[0];
          if (citation) {
            parts.push({ marks: [], key: `marker:${marker.start}`, text: `[${citation.number}]`, citation });
            linked.add(citation);
            matches.forEach((item) => lastVisiblePart.set(item, parts.length - 1));
          }
        }
        // Partial/unannotated provider markers are transport syntax, never prose.
        previousPart = undefined;
        previousMatches = [];
        offset += character.length;
        continue;
      }
      // Keep line separators selectable without turning them into link hit targets.
      const matches = original && !/^[\r\n]+$/.test(character) ? relevant.filter((item) => original.start >= item.startIndex && original.end <= item.endIndex) : [];
      const citation = matches[0];
      if (previousPart && previousPart.citation === citation && previousMatches.length === matches.length
        && previousMatches.every((item, index) => item === matches[index])) previousPart.text += character;
      else {
        previousPart = { marks: run.marks, href: run.href, key: `${run.key}:${offset}`, text: character, ...(citation ? { citation } : {}) };
        parts.push(previousPart);
      }
      if (citation) linked.add(citation);
      matches.forEach((item) => lastVisiblePart.set(item, parts.length - 1));
      previousMatches = matches;
      offset += character.length;
    }
  }
  const trailing = new Map<number, InlineCitation[]>();
  for (const citation of relevant) {
    const index = lastVisiblePart.get(citation);
    if (index === undefined || linked.has(citation) || parts[index].citation?.url === citation.url) continue;
    const group = trailing.get(index) ?? [];
    if (!group.some((item) => item.url === citation.url)) group.push(citation);
    trailing.set(index, group);
  }
  return parts.flatMap((part, index) => {
    const extras = trailing.get(index) ?? [];
    return [part, ...extras.map((citation) => ({ marks: [],
      key: `${part.key}:citation:${citation.id}`, text: ` [${citation.number}]`, citation }))];
  });
}
