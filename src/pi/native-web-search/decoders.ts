import type { JsonObject } from '@earendil-works/pi-durable';

/** Small typed decoders for the provider stream events the recording in docs/web-search-recording.json shows. */

export type SearchAction =
  | { kind: 'search'; queries: string[] }
  | { kind: 'open_page'; url?: string }
  | { kind: 'find_in_page'; url?: string; pattern?: string };

/** A completed `web_search_call` item: its action, declared sources and returned results. */
export type WebSearchCall = {
  id: string;
  status: 'completed' | 'failed' | 'interrupted';
  action: SearchAction;
  sources: { title?: string; url?: string }[];
  results: { title?: string; url?: string; snippet?: string }[];
};

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];

/** `response.created` carries the response identity every later event belongs to. */
export function responseCreated(event: unknown): string | undefined {
  if (!isObject(event) || event.type !== 'response.created' || !isObject(event.response)) return undefined;
  return string(event.response.id);
}

/** `response.output_item.added` with a `web_search_call` item: the call is running. */
export function webSearchCallAdded(event: unknown): { id: string } | undefined {
  if (!isObject(event) || event.type !== 'response.output_item.added' || !isObject(event.item)) return undefined;
  if (event.item.type !== 'web_search_call') return undefined;
  const id = string(event.item.id);
  return id ? { id } : undefined;
}

function actionOf(item: JsonObject): SearchAction {
  const action = isObject(item.action) ? item.action : {};
  const type = string(action.type);
  const url = string(action.url);
  if (type === 'open_page') return { kind: 'open_page', ...(url ? { url } : {}) };
  if (type === 'find_in_page') {
    const pattern = string(action.pattern);
    return { kind: 'find_in_page', ...(url ? { url } : {}), ...(pattern ? { pattern } : {}) };
  }
  // The recording shows both a `queries` array and a single `query`.
  const queries = strings(action.queries);
  const single = string(action.query);
  return { kind: 'search', queries: queries.length ? queries : single ? [single] : [] };
}

function sourcesOf(item: JsonObject): WebSearchCall['sources'] {
  const action = isObject(item.action) ? item.action : undefined;
  if (!Array.isArray(action?.sources)) return [];
  return action.sources.flatMap((value) => {
    if (!isObject(value)) return [];
    const url = string(value.url);
    const title = string(value.title);
    return url || title ? [{ ...(title ? { title } : {}), ...(url ? { url } : {}) }] : [];
  });
}

function resultsOf(item: JsonObject): WebSearchCall['results'] {
  if (!Array.isArray(item.results)) return [];
  return item.results.flatMap((value) => {
    if (!isObject(value)) return [];
    const title = string(value.title);
    const url = string(value.url);
    const snippet = string(value.snippet);
    return title || url || snippet
      ? [{ ...(title ? { title } : {}), ...(url ? { url } : {}), ...(snippet ? { snippet } : {}) }]
      : [];
  });
}

/** `response.output_item.done` with a `web_search_call` item: the call is terminal. */
export function webSearchCallDone(event: unknown): WebSearchCall | undefined {
  if (!isObject(event) || event.type !== 'response.output_item.done' || !isObject(event.item)) return undefined;
  if (event.item.type !== 'web_search_call') return undefined;
  const id = string(event.item.id);
  if (!id) return undefined;
  const status = event.item.status === 'completed' ? 'completed'
    : event.item.status === 'failed' ? 'failed' : 'interrupted';
  return { id, status, action: actionOf(event.item), sources: sourcesOf(event.item), results: resultsOf(event.item) };
}

/** `response.output_text.annotation.added` with a `url_citation`: the answer cited this page. */
export function urlCitationAdded(event: unknown): { url: string; title?: string } | undefined {
  if (!isObject(event) || event.type !== 'response.output_text.annotation.added' || !isObject(event.annotation)) {
    return undefined;
  }
  if (event.annotation.type !== 'url_citation') return undefined;
  const url = string(event.annotation.url);
  if (!url) return undefined;
  const title = string(event.annotation.title);
  return { url, ...(title ? { title } : {}) };
}
