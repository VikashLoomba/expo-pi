import type { Provider } from '@earendil-works/pi-ai';

import { nativeWebSearchScope } from './bindings';
import { streamNativeOpenAI } from './wrapper-stream';

/** Decorate Pi's provider, preserving its auth, catalog, transport, and parser. */
export function withNativeWebSearch(provider: Provider<'openai-responses'>): Provider<'openai-responses'> {
  if (provider.id !== 'openai') throw new Error('Native web search requires the modern OpenAI provider.');
  return {
    ...provider,
    stream(model, context, options) {
      const scope = nativeWebSearchScope(options?.signal);
      if (!scope) return provider.stream(model, context, options);
      if ('error' in scope) throw scope.error;
      return streamNativeOpenAI(model, context, options, scope, (next) => provider.stream(model, context, next));
    },
    streamSimple(model, context, options) {
      const scope = nativeWebSearchScope(options?.signal);
      if (!scope) return provider.streamSimple(model, context, options);
      if ('error' in scope) throw scope.error;
      return streamNativeOpenAI(model, context, options, scope, (next) => provider.streamSimple(model, context, next));
    },
  };
}
