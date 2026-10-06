import { isObject, type JsonObject, type NativeResponseRecord } from './types';
import { evidenceCallLimit, getSearchEvidenceBudget, prefixByUtf8Bytes, SEARCH_EVIDENCE_MESSAGE_PREFIX,
  SEARCH_EVIDENCE_MIN_CALL_BYTES, utf8ByteLength } from './budget';

export const SEARCH_EVIDENCE_VERSION = 1;
/** UTF-16 character limits, including JSON escaping and provenance in the call limit. */
export const SEARCH_EVIDENCE_LIMITS = {
  resultCharacters: 65_536,
  callCharacters: 131_072,
  metadataCharacters: 4_096,
} as const;

export type SearchEvidenceAction = {
  type?: string;
  queries?: string[];
  url?: string;
  pattern?: string;
};

export type SearchEvidenceResult = {
  /** Original zero-based provider positions; identical sources are represented once. */
  resultIndices: number[];
  type?: string;
  title?: string;
  url?: string;
  textKind: 'snippet' | 'text' | 'content' | 'mixed' | 'none';
  text: string;
  originalCharacters: number;
  retainedCharacters: number;
  truncated: boolean;
  omitted: boolean;
  metadataTruncated: boolean;
};

export type SearchEvidenceData = {
  version: number;
  requestId: string;
  responseId: string;
  taskId: number;
  provider: 'openai';
  model: string;
  nativeItemId: string;
  outputIndex: number;
  status: 'completed';
  /** Completion describes the search operation, never the completeness of a web page. */
  contentKind: 'retrieved_excerpts';
  action: SearchEvidenceAction;
  results: SearchEvidenceResult[];
  returnedResults: number;
  duplicateResults: number;
  unreadableResults: number;
  omittedResults: number;
  originalCharacters: number;
  retainedCharacters: number;
  renderedCharacters: number;
  truncated: boolean;
  metadataTruncated: boolean;
  responseBudgetBytes: number;
  callBudgetBytes: number;
  responseOmittedCalls: number;
};

export type SearchEvidenceProjection = {
  nativeItemId: string;
  /** Collision-free canonical equality signature, not a cryptographic hash or entry ID. */
  digest: string;
  data: SearchEvidenceData;
  content: string;
};

type Source = Pick<SearchEvidenceResult, 'resultIndices' | 'type' | 'title' | 'url' | 'textKind' | 'text'>;
const string = (value: unknown) => typeof value === 'string' ? value : undefined;
const header = SEARCH_EVIDENCE_MESSAGE_PREFIX
  + 'These are returned excerpts or snippets, not verified complete pages. Search completion does not imply exhaustive coverage.\n';

/** A fixed-key projection makes equality independent of incoming JSON object key order. */
function actionOf(item: JsonObject): SearchEvidenceAction {
  const action = isObject(item.action) ? item.action : {};
  const queries = Array.isArray(action.queries) ? action.queries.filter((value): value is string => typeof value === 'string')
    : typeof action.query === 'string' ? [action.query] : undefined;
  return {
    ...(typeof action.type === 'string' ? { type: action.type } : {}),
    ...(queries ? { queries } : {}),
    ...(typeof action.url === 'string' ? { url: action.url } : {}),
    ...(typeof action.pattern === 'string' ? { pattern: action.pattern } : {}),
  };
}

function textOf(result: JsonObject): Pick<Source, 'textKind' | 'text'> {
  const parts: { kind: 'snippet' | 'text' | 'content'; text: string }[] = [];
  const seen = new Set<string>();
  for (const key of ['snippet', 'text', 'content'] as const) {
    const value = result[key];
    let text = typeof value === 'string' ? value : '';
    if (key === 'content' && Array.isArray(value)) {
      text = value.flatMap((part) => isObject(part) &&
        (part.type === 'text' || part.type === 'output_text' || part.type === 'input_text') &&
        typeof part.text === 'string' ? [part.text] : []).join('\n');
    }
    if (text.length > 0 && !seen.has(text)) { parts.push({ kind: key, text }); seen.add(text); }
  }
  if (parts.length === 1) return { textKind: parts[0].kind, text: parts[0].text };
  if (parts.length > 1) return { textKind: 'mixed', text: parts.map((part) => `[${part.kind}]\n${part.text}`).join('\n\n') };
  return { textKind: 'none', text: '' };
}

function sourcesOf(item: JsonObject) {
  const results = Array.isArray(item.results) ? item.results : [];
  const sources: Source[] = [];
  const seen = new Map<string, Source>();
  let unreadableResults = 0;
  for (const [index, result] of results.entries()) {
    if (!isObject(result)) { unreadableResults++; continue; }
    const source = {
      ...(typeof result.type === 'string' ? { type: result.type } : {}),
      ...(typeof result.title === 'string' ? { title: result.title } : {}),
      ...(typeof result.url === 'string' ? { url: result.url } : {}),
      ...textOf(result),
    };
    if (!source.title && !source.url && !source.text) { unreadableResults++; continue; }
    const key = JSON.stringify(source);
    const previous = seen.get(key);
    if (previous) previous.resultIndices.push(index);
    else {
      const value = { resultIndices: [index], ...source };
      sources.push(value);
      seen.set(key, value);
    }
  }
  return { sources, returnedResults: results.length, unreadableResults,
    duplicateResults: sources.reduce((total, source) => total + source.resultIndices.length - 1, 0) };
}

/** Keep a valid Unicode boundary even though budgets and JS strings count UTF-16 units. */
function prefix(value: string, limit: number): string {
  const end = Math.max(0, Math.min(value.length, limit));
  const code = value.charCodeAt(end - 1);
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end);
}

function renderSource(source: Source, text: string) {
  const metadata = (value: string | undefined) => value === undefined ? undefined : prefix(value, SEARCH_EVIDENCE_LIMITS.metadataCharacters);
  return JSON.stringify({
    source: source.resultIndices[0] + 1,
    identicalResults: source.resultIndices.length,
    type: metadata(source.type), title: metadata(source.title), url: metadata(source.url),
    excerptKind: source.textKind,
    excerpt: text,
    originalCharacters: source.text.length,
    retainedCharacters: text.length,
    truncated: text.length < source.text.length,
  }) + '\n';
}

function project(record: NativeResponseRecord, item: JsonObject, outputIndex: number,
  limits: { responseBudgetBytes: number; callBudgetBytes: number; responseOmittedCalls: number }): SearchEvidenceProjection {
  const nativeItemId = item.id as string;
  const responseId = record.responseId!;
  const action = actionOf(item);
  const { sources, ...counts } = sourcesOf(item);
  const identity = { version: SEARCH_EVIDENCE_VERSION, requestId: record.requestId, responseId,
    taskId: record.taskId, provider: record.provider, model: record.model, nativeItemId, outputIndex };
  // Include all source text, including omitted tails, so enrichment outside the rendered budget is detected.
  const digest = JSON.stringify({ ...identity, action, ...counts, sources, ...limits });
  const rawProvenance = JSON.stringify({ responseId, nativeItemId, action });
  const provenanceLimit = Math.min(SEARCH_EVIDENCE_LIMITS.metadataCharacters, Math.floor(limits.callBudgetBytes / 8));
  const metadataTruncated = utf8ByteLength(rawProvenance) > provenanceLimit;
  let content = header + 'Provenance: ' + prefixByUtf8Bytes(rawProvenance, provenanceLimit)
    + (metadataTruncated ? ' [provenance shortened in model context]' : '') + '\n';
  // Reserve room for an honest completeness report after the source blocks.
  const sourceLimit = limits.callBudgetBytes - 768;
  const results: SearchEvidenceResult[] = sources.map((source) => {
    const metadataTruncated = [source.type, source.title, source.url].some((value) =>
      value !== undefined && value.length > SEARCH_EVIDENCE_LIMITS.metadataCharacters);
    const available = sourceLimit - utf8ByteLength(content);
    const omitted = utf8ByteLength(renderSource(source, '')) > available;
    let retained = '';
    if (!omitted) {
      let low = 0;
      let high = Math.min(source.text.length, SEARCH_EVIDENCE_LIMITS.resultCharacters);
      if (utf8ByteLength(renderSource(source, prefix(source.text, high))) <= available) low = high;
      else {
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (utf8ByteLength(renderSource(source, prefix(source.text, mid))) <= available) low = mid;
          else high = mid - 1;
        }
      }
      retained = prefix(source.text, low);
      content += renderSource(source, retained);
    }
    return { ...source, text: retained, originalCharacters: source.text.length,
      retainedCharacters: retained.length, truncated: retained.length < source.text.length,
      omitted, metadataTruncated };
  });
  const originalCharacters = sources.reduce((sum, source) => sum + source.text.length, 0);
  const retainedCharacters = results.reduce((sum, result) => sum + result.retainedCharacters, 0);
  const omittedResults = results.filter((result) => result.omitted).length;
  const truncated = results.some((result) => result.truncated || result.omitted || result.metadataTruncated) ||
    metadataTruncated || limits.responseOmittedCalls > 0;
  const completeness = { ...counts, distinctResults: results.length, omittedResults,
    originalCharacters, retainedCharacters, truncated, metadataTruncated,
    responseOmittedCalls: limits.responseOmittedCalls };
  content += `Completeness: ${JSON.stringify(completeness)}\n`;
  if (counts.returnedResults === 0) content += 'The provider returned no readable result bodies for this completed search.\n';
  if (truncated || counts.unreadableResults > 0) {
    content += 'Some returned material is shortened, omitted, or unreadable in this context projection. '
      + 'The original provider response remains unchanged in the application archive.\n';
  }
  if (limits.responseOmittedCalls > 0) content += `${limits.responseOmittedCalls} other completed searches were omitted from this response's model context budget; their full results remain in the archive.\n`;
  if (utf8ByteLength(content) > limits.callBudgetBytes) {
    // Very small model windows still get an explicit omission notice rather than
    // silently turning a completed search into an empty model contribution.
    content = SEARCH_EVIDENCE_MESSAGE_PREFIX + 'This completed search does not fit its context allocation. '
      + 'Its excerpts and source metadata are omitted here; full results remain in the archive.\n'
      + `Completeness: ${JSON.stringify({ returnedResults: counts.returnedResults, omittedResults: results.length,
        responseOmittedCalls: limits.responseOmittedCalls, retainedCharacters: 0 })}\n`;
    return { nativeItemId, digest, content, data: { ...identity, status: 'completed', contentKind: 'retrieved_excerpts',
      action, results: results.map((result) => ({ ...result, text: '', retainedCharacters: 0, truncated: result.originalCharacters > 0,
        omitted: true, metadataTruncated: true })), ...counts, omittedResults: results.length,
      originalCharacters, retainedCharacters: 0, renderedCharacters: content.length, truncated: true, metadataTruncated: true, ...limits } };
  }
  return { nativeItemId, digest, content, data: { ...identity, status: 'completed', contentKind: 'retrieved_excerpts',
    action, results, ...counts, omittedResults, originalCharacters, retainedCharacters,
    renderedCharacters: content.length, truncated, metadataTruncated, ...limits } };
}

/**
 * Project only completed, identified hosted calls. Missing response/item identities produce no observation:
 * callers must wait for enrichment rather than invent an identity that could collide during recovery.
 * Parent response failure/cancellation does not invalidate a call that completed successfully.
 * No raw objects are mutated and no encrypted reasoning or arbitrary provider fields enter model text.
 */
export function projectSearchEvidence(record: NativeResponseRecord): SearchEvidenceProjection[] {
  if (!string(record.responseId)?.trim()) return [];
  const maximum = getSearchEvidenceBudget(1_048_576).maxBytes;
  const configured = record.evidenceBudgetBytes ?? maximum;
  const responseBudgetBytes = Number.isFinite(configured) ? Math.max(0, Math.min(maximum, Math.floor(configured))) : 0;
  const calls = record.output.flatMap((item, outputIndex) => item.type === 'web_search_call' && item.status === 'completed' &&
    string(item.id)?.trim() ? [{ item, outputIndex }] : []);
  const selected = calls.slice(0, evidenceCallLimit(responseBudgetBytes));
  const responseOmittedCalls = calls.length - selected.length;
  let remaining = responseBudgetBytes;
  return selected.map(({ item, outputIndex }, index) => {
    const callBudgetBytes = Math.min(SEARCH_EVIDENCE_LIMITS.callCharacters,
      remaining - (selected.length - index - 1) * SEARCH_EVIDENCE_MIN_CALL_BYTES);
    const observation = project(record, item, outputIndex, { responseBudgetBytes, callBudgetBytes, responseOmittedCalls });
    remaining -= utf8ByteLength(observation.content);
    return observation;
  });
}
