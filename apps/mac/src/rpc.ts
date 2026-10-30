import type { RPCSchema } from 'electrobun/view';

import type { SettingsTarget } from './contract';

/** What the main process asks a window to do, from a menu item or the Dock; Settings opens its own window. */
export type WindowCommand = 'new-chat';

/**
 * Electrobun's RPC between the main process and a window carries commands only; everything else is a Chord call.
 * `show` tells an open Settings window which pane a notice asked for; a new one reads it from its bootstrap.
 */
export type WindowRPC = {
  bun: RPCSchema<{ requests: Record<never, never>; messages: Record<never, never> }>;
  webview: RPCSchema<{
    requests: Record<never, never>;
    messages: { command: { name: WindowCommand }; show: SettingsTarget };
  }>;
};
