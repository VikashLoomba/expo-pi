import assert from 'node:assert/strict';
import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

export const SUBSCRIPTION_TOKEN = 'eyJ.synthetic-native-search.signature';
export const MODEL_ID = 'gpt-6-sol';
export const USAGE = { input_tokens: 31, output_tokens: 12, total_tokens: 43,
  input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 4 } };

/** Real Pi provider/auth/Responses parsing. Only the HTTP response is scripted. */
export function responsesModels(steps, { requestOptions = {}, wrapProvider = (provider) => provider } = {}) {
  const requests = [];
  const models = createModels({ credentials: new InMemoryCredentialStore(),
    authContext: { env: async () => undefined, fileExists: async () => false } });
  const provider = openaiProvider();
  const fetch = async (url, init) => {
    const request = { url: String(url), body: JSON.parse(init.body), headers: new Headers(init.headers), signal: init.signal };
    requests.push(request);
    const step = steps[requests.length - 1];
    assert.ok(step, `Unexpected OpenAI request ${requests.length}`);
    const exchange = controlledSSE(request);
    if (typeof step === 'function') await step(exchange, request);
    else exchange.complete(step);
    return exchange.response;
  };
  models.setProvider(wrapProvider({ ...provider,
    auth: { apiKey: { name: 'Synthetic ChatGPT subscription',
      check: async () => ({ type: 'api_key' }), resolve: async () => ({ auth: { apiKey: SUBSCRIPTION_TOKEN } }) } },
    stream: (model, context, options) => provider.stream(model, context, { ...options, ...requestOptions, fetch }),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, { ...options, ...requestOptions, fetch }),
  }));
  return { models, requests };
}

export function controlledSSE(request) {
  const encoder = new TextEncoder();
  let controller;
  let closed = false;
  let sequence = 0;
  const abort = () => {
    if (closed) return;
    closed = true;
    controller.error(new DOMException('The synthetic request was aborted', 'AbortError'));
  };
  const body = new ReadableStream({
    start(value) { controller = value; },
    cancel() { closed = true; request.signal?.removeEventListener('abort', abort); },
  });
  request.signal?.addEventListener('abort', abort, { once: true });
  if (request.signal?.aborted) abort();
  const emit = (type, fields = {}) => {
    assert.equal(closed, false, 'The scripted SSE stream must remain open');
    controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`));
  };
  const close = () => {
    if (closed) return;
    closed = true;
    request.signal?.removeEventListener('abort', abort);
    controller.close();
  };
  return {
    request, emit, close,
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    created(id = 'resp_test') {
      emit('response.created', { response: { id, object: 'response', status: 'in_progress', model: MODEL_ID, output: [] } });
    },
    item(item, outputIndex) {
      emit('response.output_item.added', { output_index: outputIndex, item: { ...item, status: 'in_progress' } });
      emit('response.output_item.done', { output_index: outputIndex, item });
    },
    complete(output, { id = 'resp_test', status = 'completed', ...extra } = {}) {
      emit(`response.${status}`, { response: { id, object: 'response', model: MODEL_ID,
        status, output, usage: USAGE, ...extra } });
      close();
    },
    failure(error) { closed = true; request.signal?.removeEventListener('abort', abort); controller.error(error); },
  };
}

export function reasoningItem(id = 'rs_search', encrypted = 'opaque-encrypted-reasoning') {
  return { id, type: 'reasoning', status: 'completed', summary: [], encrypted_content: encrypted };
}

export function searchItem(id = 'ws_search', overrides = {}) {
  return { id, type: 'web_search_call', status: 'completed', action: { type: 'search',
    queries: ['OpenAI Responses native search'],
    sources: [{ type: 'url', url: 'https://openai.com/research/', title: 'OpenAI Research', future_source_field: 'retained' }] },
  results: [{ type: 'web_search_result', title: `Calibration bulletin for ${id}`,
    url: `https://example.test/observatories/${id}`, snippet: sourceFact(id) }],
  future_search_field: { nested: ['retained', 42] }, ...overrides };
}

/** A source-only fact: default assistant answers deliberately do not repeat it. */
export function sourceFact(id = 'ws_search') {
  return `The ${id} observatory calibrates its cobalt beacon every 47 seconds.`;
}

/** Extract only ordinary message text, excluding raw hosted-call object fields. */
export function inputText(body, role) {
  return body.input.filter((item) => !role || item.role === role).flatMap((item) =>
    typeof item.content === 'string' ? [item.content] : Array.isArray(item.content)
      ? item.content.flatMap((part) => typeof part.text === 'string' ? [part.text] : []) : []).join('\n');
}

export function textItem(text = 'A sourced answer.', id = 'msg_search', annotations = [{ type: 'url_citation',
  start_index: 0, end_index: 16, url: 'https://openai.com/research/', title: 'OpenAI Research' }]) {
  return { id, type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer',
    content: [{ type: 'output_text', text, annotations, logprobs: [] }] };
}

export async function until(check, message, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
