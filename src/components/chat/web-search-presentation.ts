import type { WebSearchCall, WebSearchCitation, WebSearchPresentation, WebSearchSource } from '../../chat/web-search-types';
import { safeSourceUrl } from '../../chat/web-search-url';
import { parseInline, type InlineToken, type MarkdownBlock, type SourceSpan } from './streaming-markdown';

export { safeSourceUrl } from '../../chat/web-search-url';

export interface SearchSource extends WebSearchSource {
  number: number;
  title: string;
  host: string;
  cited: boolean;
}

export interface InlineCitation extends WebSearchCitation { number: number }
export interface CitedInlineToken extends Omit<InlineToken, 'key' | 'text'> {
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

function sourceOffset(spans: readonly SourceSpan[] | undefined, index: number): number | undefined {
  const span = spans?.find((item) => index >= item.start && index < item.end);
  return span ? span.sourceStart + index - span.start : undefined;
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

/**
 * Compose inline -> block -> original source maps. Markdown delimiters, link
 * targets, CRLFs and list indentation never shift a provider citation range.
 * Original message text is preserved for copying, persistence and replay.
 */
export function citedInlineTokens(block: MarkdownBlock, streaming: boolean, citations: readonly InlineCitation[]): readonly CitedInlineToken[] {
  const parts: CitedInlineToken[] = [];
  const markers = nativeCitationMarkers(block.text);
  const emittedMarkers = new Set<number>();
  const linked = new Set<InlineCitation>();
  const lastVisiblePart = new Map<InlineCitation, number>();
  for (const token of parseInline(block.text, streaming, true)) {
    let offset = 0;
    let previousPart: CitedInlineToken | undefined;
    let previousMatches: readonly InlineCitation[] = [];
    for (const character of token.text) {
      const blockOffset = sourceOffset(token.sourceSpans, offset);
      const originalOffset = blockOffset === undefined ? undefined : sourceOffset(block.sourceSpans, blockOffset);
      const marker = blockOffset === undefined ? undefined : markers.find((item) => blockOffset >= item.start && blockOffset < item.end);
      if (marker) {
        if (!emittedMarkers.has(marker.start)) {
          emittedMarkers.add(marker.start);
          const start = sourceOffset(block.sourceSpans, marker.start);
          const last = sourceOffset(block.sourceSpans, marker.end - 1);
          const matches = marker.complete && start !== undefined && last !== undefined
            ? citations.filter((citation) => citation.startIndex <= start && citation.endIndex >= last + 1) : [];
          const citation = matches[0];
          if (citation) {
            parts.push({ kind: 'link', key: `marker:${marker.start}`, text: `[${citation.number}]`, citation });
            linked.add(citation);
            matches.forEach((item) => lastVisiblePart.set(item, parts.length - 1));
          }
        }
        // A partial or unannotated native marker is transport syntax, never prose.
        // Its original bytes and positions remain in ChatMessage.text.
        previousPart = undefined;
        previousMatches = [];
        offset += character.length;
        continue;
      }
      const matches = originalOffset === undefined ? []
        : citations.filter((item) => originalOffset >= item.startIndex && originalOffset + character.length <= item.endIndex);
      const citation = matches[0];
      if (previousPart && previousPart.citation === citation && previousMatches.length === matches.length
        && previousMatches.every((item, index) => item === matches[index])) previousPart.text += character;
      else {
        previousPart = { ...token, key: `${token.key}:${offset}`, text: character, ...(citation ? { citation } : {}) };
        parts.push(previousPart);
      }
      if (citation) linked.add(citation);
      matches.forEach((item) => lastVisiblePart.set(item, parts.length - 1));
      previousMatches = matches;
      offset += character.length;
    }
  }
  const trailing = new Map<number, InlineCitation[]>();
  for (const citation of citations) {
    const index = lastVisiblePart.get(citation);
    if (index === undefined || linked.has(citation) || parts[index].citation?.url === citation.url) continue;
    const group = trailing.get(index) ?? [];
    // Repeated metadata for the same source needs only one extra link here.
    if (!group.some((item) => item.url === citation.url)) group.push(citation);
    trailing.set(index, group);
  }
  return parts.flatMap((part, index) => {
    const extras = trailing.get(index) ?? [];
    return [part, ...extras.map((citation) => ({ kind: 'link' as const,
      key: `${part.key}:citation:${citation.id}`, text: ` [${citation.number}]`, citation }))];
  });
}
