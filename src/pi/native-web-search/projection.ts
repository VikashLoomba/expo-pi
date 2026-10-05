import type { WebSearchCall, WebSearchCitation, WebSearchPresentation, WebSearchSource } from '../../chat/web-search-types';
import { safeSourceUrl } from '../../chat/web-search-url';
import type { NativeResponseRecord } from './types';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
const string = (value: unknown) => typeof value === 'string' ? value : undefined;

function citationRange(content: string, start: unknown, end: unknown): { start: number; end: number } | undefined {
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || typeof end !== 'number'
    || !Number.isSafeInteger(end) || start < 0 || end <= start) return undefined;
  const direct = end <= content.length ? { start, end } : undefined;
  // The protocol describes character positions without specifying UTF-16 vs
  // Unicode code points. Keep both interpretations until the text proves one.
  let pointIndex = 0;
  let unitIndex = 0;
  let pointStart: number | undefined;
  let pointEnd: number | undefined;
  for (const character of content) {
    if (pointIndex === start) pointStart = unitIndex;
    if (pointIndex === end) { pointEnd = unitIndex; break; }
    pointIndex++;
    unitIndex += character.length;
  }
  if (pointIndex === end) pointEnd = unitIndex;
  const points = pointStart !== undefined && pointEnd !== undefined ? { start: pointStart, end: pointEnd } : undefined;
  if (direct && points && direct.start === points.start && direct.end === points.end) return direct;
  const isMarker = (range: typeof direct) => !!range
    && /^\uE200cite\uE202[^\uE200\uE201]+\uE201$/.test(content.slice(range.start, range.end));
  if (isMarker(direct) && !isMarker(points)) return direct;
  if (isMarker(points) && !isMarker(direct)) return points;
  // Bounds alone cannot identify the right prose span after an astral character.
  // Keep the source available without linking unrelated text.
  return undefined;
}

function messageParts(record: NativeResponseRecord): ObjectValue[] {
  return record.output.flatMap((item) => item.type === 'message' && Array.isArray(item.content)
    ? item.content.flatMap((part) => object(part) ? [object(part)!] : []) : []);
}

/** Pi concatenates output text/refusal parts in native output order. */
export function nativeResponseText(record: NativeResponseRecord): string {
  return messageParts(record).map((part) => part.type === 'output_text' ? string(part.text) ?? ''
    : part.type === 'refusal' ? string(part.refusal) ?? '' : '').join('');
}

/** Pure, bounded presentation projection; opaque provider data never enters React props. */
export function projectNativeWebSearch(record: NativeResponseRecord, text: string, interrupted = false): WebSearchPresentation | undefined {
  const calls = new Map<string, WebSearchCall>();
  const sources = new Map<string, WebSearchSource>();
  const citations: WebSearchCitation[] = [];
  const addSource = (value: unknown) => {
    const source = object(value);
    const url = safeSourceUrl(source?.url);
    if (!url) return;
    const title = string(source?.title);
    const previous = sources.get(url);
    sources.set(url, { url, ...(title || previous?.title ? { title: title || previous?.title } : {}) });
  };
  const statusOf = (value: unknown): WebSearchCall['status'] => {
    if (value === 'completed') return 'completed';
    if (value === 'failed') return 'failed';
    if (value === 'incomplete') return 'interrupted';
    if (interrupted || record.status === 'interrupted' || record.status === 'incomplete') return 'interrupted';
    if (record.status === 'failed') return 'failed';
    if (record.status === 'completed') return 'completed';
    return 'running';
  };
  const addCall = (item: ObjectValue) => {
    if (item.type !== 'web_search_call') return;
    const id = string(item.id);
    if (!id) return;
    const previous = calls.get(id);
    const action = object(item.action);
    const kind = action?.type === 'open_page' || action?.type === 'find_in_page' ? action.type
      : action?.type === 'search' ? 'search' : previous?.action ?? 'search';
    const queries = Array.isArray(action?.queries) ? action.queries.filter((value): value is string => typeof value === 'string')
      : typeof action?.query === 'string' ? [action.query] : previous?.queries;
    const url = safeSourceUrl(action?.url) ?? previous?.url;
    const pattern = string(action?.pattern) ?? previous?.pattern;
    const candidateStatus = statusOf(item.status);
    const status = candidateStatus === 'running' && previous && previous.status !== 'running' ? previous.status : candidateStatus;
    calls.set(id, { id, action: kind, status,
      ...(queries?.length ? { queries } : {}), ...(url ? { url } : {}), ...(pattern ? { pattern } : {}),
      ...(status === 'failed' && record.error ? { error: record.error } : {}),
    });
    if (Array.isArray(action?.sources)) action.sources.forEach(addSource);
    if (Array.isArray(item.results)) {
      for (const value of item.results) {
        const result = object(value);
        if (!result) continue;
        addSource({ url: result.source_website_url ?? result.url,
          title: result.title ?? result.source_website_title });
      }
    }
  };
  // Events supply activity before an output item is complete; the final output is
  // applied last and owns authoritative action metadata and source lists.
  for (const event of record.events) {
    const item = object(event.item);
    if (item) addCall(item);
    // A citation may arrive before the complete text item. Its source is already
    // useful; inline placement waits for a full, matching native text snapshot.
    const annotation = object(event.annotation);
    if (annotation?.type === 'url_citation') addSource(annotation);
    const type = string(event.type);
    const id = string(event.item_id);
    if (!type?.startsWith('response.web_search_call.') || !id) continue;
    const previous = calls.get(id);
    calls.set(id, { ...previous, id, action: previous?.action ?? 'search',
      status: statusOf(type.endsWith('.completed') ? 'completed' : type.endsWith('.failed') ? 'failed' : 'in_progress') });
  }
  record.output.forEach((item) => addCall(item));

  const exactText = nativeResponseText(record) === text;
  let offset = 0;
  for (const [partIndex, part] of messageParts(record).entries()) {
    const content = part.type === 'output_text' ? string(part.text) ?? ''
      : part.type === 'refusal' ? string(part.refusal) ?? '' : '';
    if (part.type === 'output_text' && Array.isArray(part.annotations)) {
      for (const [annotationIndex, value] of part.annotations.entries()) {
        const annotation = object(value);
        if (annotation?.type !== 'url_citation') continue;
        const url = safeSourceUrl(annotation.url);
        if (!url) continue;
        const title = string(annotation.title) || url;
        addSource({ url, title });
        const range = exactText ? citationRange(content, annotation.start_index, annotation.end_index) : undefined;
        if (range) {
          citations.push({ id: `${record.responseId ?? record.requestId}:${partIndex}:${annotationIndex}`,
            url, title, startIndex: offset + range.start, endIndex: offset + range.end });
        }
      }
    }
    offset += content.length;
  }
  return calls.size || citations.length || sources.size ? { calls: [...calls.values()], citations, sources: [...sources.values()] } : undefined;
}
