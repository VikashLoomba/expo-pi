import type { MutableModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';

import { withNativeWebSearch } from './native-web-search/provider';
import { withPiCatalog } from './pi-catalog';

/**
 * The providers chats offer on every device, in catalog order, with pi-ai's own auth and pi.dev's newer models. OpenAI
 * carries the native web search decorator, which acts only on requests a Harness's search bridge binds. A host replaces
 * what its sign-ins need with `setProvider`, which keeps a provider's place. Individual imports preserve Metro's lazy,
 * mobile-safe SDK boundaries.
 */
export function registerChatProviders(models: MutableModels) {
  for (const provider of [withNativeWebSearch(openaiProvider()), anthropicProvider(), deepseekProvider(),
    googleProvider(), openrouterProvider(), xaiProvider()]) {
    models.setProvider(withPiCatalog(provider));
  }
}
