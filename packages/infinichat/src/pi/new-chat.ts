import {
  createModelSettings, type ChatModelSettings, type NewChatDefaults, type ProviderOption,
} from './model-catalog';
import { OPENAI_PROVIDER_ID } from './openai-auth/core';

/**
 * Used when no recently used chat applies, on every device. OpenAI goes first so native web search applies; a
 * provider whose entry is missing from its catalog falls back to its first reasoning model.
 */
export const NEW_CHAT_DEFAULTS: NewChatDefaults = {
  preferredProvider: OPENAI_PROVIDER_ID,
  models: {
    openai: 'gpt-6-sol',
    anthropic: 'claude-sonnet-5-5',
    // A machine's Claude, through its Claude Code login (`claude-code.ts`).
    'claude-code': 'claude-sonnet-5-5',
    deepseek: 'deepseek-flash',
    google: 'gemini-3.8-flash',
    xai: 'grok-4.7',
    openrouter: 'anthropic/claude-sonnet-5.5',
  },
};

/**
 * A provider's smaller models for InfiniChat's summaries, tried in order; a provider without one writes its summaries
 * on its main model. UniiChat's own compactors lead (its README, "Config").
 */
const SUMMARY_MODELS: Readonly<Record<string, readonly string[]>> = {
  openai: ['gpt-6-luna'],
  anthropic: ['claude-haiku-5-5'],
  // Claude Code offers the models of the account's plan.
  'claude-code': ['claude-haiku-5-5', 'claude-haiku-4-5-20251001'],
  google: ['gemini-3.1-flash-lite'],
  openrouter: ['anthropic/claude-haiku-5.5'],
};

/**
 * What a new InfiniChat runs on with `provider` until the user chooses, among the models its account can use
 * (`usable`): a new chat's model at medium effort, and a smaller one at high effort for the summaries, as UniiChat's
 * config defaults a chat's `pick` and its `compactor`. A model without those efforts takes its lowest. Undefined when
 * the provider has no model to offer.
 */
export function infiniChatDefaults(provider: ProviderOption, usable: ReadonlySet<string>):
{ main: ChatModelSettings; summary: ChatModelSettings } | undefined {
  const models = provider.models.filter((model) => usable.has(model.id) && model.thinkingLevels.length > 0);
  const first = (ids: readonly string[]) => ids.map((id) => models.find((model) => model.id === id))
    .find((model) => model !== undefined);
  const preferred = NEW_CHAT_DEFAULTS.models[provider.id];
  const main = first(preferred === undefined ? [] : [preferred]) ?? models[0];
  if (main === undefined) return undefined;
  const summary = first(SUMMARY_MODELS[provider.id] ?? []) ?? main;
  return { main: createModelSettings(main, 'medium'), summary: createModelSettings(summary, 'high') };
}
