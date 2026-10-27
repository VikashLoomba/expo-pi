import {
  type Api, type AssistantMessageEventStream, type Model, type Provider, type StreamOptions,
} from '@earendil-works/pi-ai';
import {
  nativeWebSearchBinding, type NativeWebSearchBinding,
} from '@pi-agent/infinichat/pi/native-web-search/bindings';
import {
  responseCreated, urlCitationAdded, webSearchCallAdded, webSearchCallDone, type WebSearchCall,
} from '@pi-agent/infinichat/pi/native-web-search/decoders';
import {
  SearchPresentationsDoc, type SearchPresentation, type SearchSource,
} from '@pi-agent/infinichat/pi/native-web-search/documents';
import { SearchObservationEntry, searchObservationMessage } from '@pi-agent/infinichat/pi/native-web-search/entries';

/** Native hosted tools belong on the Responses request, outside pi's function-tool registry. pi-ai sets
 * `include` itself for active reasoning (`reasoning.encrypted_content`); this only unions the web search parts. */
const INCLUDES = ['web_search_call.results', 'web_search_call.action.sources'];

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function withWebSearchTool(payload: unknown): unknown {
  if (!isObject(payload)) throw new Error('OpenAI Responses requires an object request.');
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const hasSearch = tools.some((tool) =>
    isObject(tool) && (tool.type === 'web_search' || tool.type === 'web_search_preview'));
  const include = Array.isArray(payload.include) ? payload.include : [];
  return { ...payload,
    tools: hasSearch ? tools : [...tools, { type: 'web_search' }],
    include: [...new Set([...include, ...INCLUDES])] };
}

type CallState = SearchPresentation['calls'][number];

/**
 * Drives one request's durable writes from its raw provider events. Committed state only: the presentation
 * document commits when a call starts, when it completes, and when the stream ends (stopped streams included);
 * each completed call becomes one write entry, admitted with the search item's id so a replayed observation
 * cannot duplicate it.
 */
class SearchObserver {
  #responseId?: string;
  #calls: CallState[] = [];
  #sources: SearchSource[] = [];
  #cited: SearchSource[] = [];

  constructor(private readonly binding: NativeWebSearchBinding, private readonly signal: AbortSignal) {}

  accept(event: unknown): void {
    const created = responseCreated(event);
    if (created !== undefined) {
      this.#responseId = created;
      return;
    }
    const added = webSearchCallAdded(event);
    if (added !== undefined) {
      if (!this.#calls.some((call) => call.id === added.id)) {
        this.#calls.push({ id: added.id, status: 'running', action: 'search' });
        this.#commit();
      }
      return;
    }
    const done = webSearchCallDone(event);
    if (done !== undefined) {
      this.#complete(done);
      return;
    }
    const citation = urlCitationAdded(event);
    if (citation !== undefined && !this.#cited.some((source) => source.url === citation.url)) {
      this.#cited.push(citation);
      this.#commit();
    }
  }

  /** The stream settled: calls it left running end honestly. */
  finish(stopReason: string): void {
    let open = false;
    for (const call of this.#calls) {
      if (call.status !== 'running') continue;
      call.status = stopReason === 'error' ? 'failed' : 'interrupted';
      open = true;
    }
    if (open) this.#commit();
  }

  #complete(done: WebSearchCall): void {
    const index = this.#calls.findIndex((call) => call.id === done.id);
    const state: CallState = { id: done.id, status: done.status, action: done.action.kind,
      ...(done.action.kind === 'search' && done.action.queries.length ? { queries: done.action.queries } : {}),
      ...(done.action.kind !== 'search' && done.action.url ? { url: done.action.url } : {}),
      ...(done.action.kind === 'find_in_page' && done.action.pattern ? { pattern: done.action.pattern } : {}) };
    if (index >= 0) this.#calls[index] = state;
    else this.#calls.push(state);
    if (done.status === 'completed') {
      const add = (source: { title?: string; url?: string }) => {
        if (source.url && !this.#sources.some((known) => known.url === source.url)) {
          this.#sources.push({ ...(source.title ? { title: source.title } : {}), url: source.url });
        }
      };
      // First occurrence kept: the action's declared sources, then the returned results.
      done.sources.forEach(add);
      done.results.forEach(add);
    }
    this.#commit();
    if (done.status === 'completed') this.#persist(done);
  }

  #commit(): void {
    const responseId = this.#responseId;
    if (responseId === undefined) return;
    const presentation: SearchPresentation = {
      calls: this.#calls.map((call) => ({ ...call })),
      sources: this.#sources.map((source) => ({ ...source })),
      cited: this.#cited.map((source) => ({ ...source })),
    };
    const { conversationId, taskId, write } = this.binding;
    this.#run(() => write.commit(async (tx) => {
      const doc = await tx.doc(SearchPresentationsDoc, conversationId);
      doc.responses[responseId] = presentation;
      doc.live = { responseId, taskId };
    }, this.signal));
  }

  /** The completed call's findings for the model's later turns, placed at the next boundary (example 20). */
  #persist(done: WebSearchCall): void {
    const { write } = this.binding;
    this.#run(() => write.submit({
      kind: SearchObservationEntry.kind,
      data: { action: done.action, resultCount: done.results.length },
      model: [searchObservationMessage(done)],
    }, done.id, this.signal));
  }

  /** Fire-and-forget, as pi-durable reports its own streaming commits: a failure reaches `onReport`
   * unless the request was aborted. */
  #run(work: () => Promise<void>): void {
    void work().catch((error: unknown) => {
      if (!this.signal.aborted) this.binding.report(error);
    });
  }
}

function decorate<TOptions extends StreamOptions>(
  options: TOptions | undefined,
  binding: NativeWebSearchBinding,
  signal: AbortSignal,
  delegate: (options: TOptions | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
  const observer = new SearchObserver(binding, signal);
  const next = Object.assign({}, options, {
    async onPayload(payload: unknown, requestModel: Model<Api>) {
      const request = withWebSearchTool(payload);
      const replacement = await options?.onPayload?.(request, requestModel);
      return replacement === undefined ? request : replacement;
    },
    async onProviderStreamEvent(event: unknown, requestModel: Model<Api>) {
      observer.accept(event);
      await options?.onProviderStreamEvent?.(event, requestModel);
    },
  });
  const stream = delegate(next);
  void stream.result().then(
    (message) => observer.finish(message.stopReason),
    () => observer.finish('error'),
  );
  return stream;
}

/** Decorate pi's provider, preserving its auth, catalog, transport, and parser. */
export function withNativeWebSearch(provider: Provider<'openai-responses'>): Provider<'openai-responses'> {
  if (provider.id !== 'openai') throw new Error('Native web search requires the modern OpenAI provider.');
  return {
    ...provider,
    stream(model, context, options) {
      const binding = nativeWebSearchBinding(options?.signal);
      const signal = options?.signal;
      if (!binding || !signal) return provider.stream(model, context, options);
      return decorate(options, binding, signal, (next) => provider.stream(model, context, next));
    },
    streamSimple(model, context, options) {
      const binding = nativeWebSearchBinding(options?.signal);
      const signal = options?.signal;
      if (!binding || !signal) return provider.streamSimple(model, context, options);
      return decorate(options, binding, signal, (next) => provider.streamSimple(model, context, next));
    },
  };
}
