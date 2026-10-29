import type { NewChatDefaults } from './model-catalog';
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
    deepseek: 'deepseek-flash',
    google: 'gemini-3.8-flash',
    xai: 'grok-4.7',
    openrouter: 'anthropic/claude-sonnet-5.5',
  },
};
