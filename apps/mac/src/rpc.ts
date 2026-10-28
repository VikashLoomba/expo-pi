import type { RPCSchema } from 'electrobun/view';

/** What the main process asks a window to do, from a menu item or the Dock; Settings opens its own window. */
export type WindowCommand = 'new-chat';

/** Electrobun's RPC between the main process and a window carries commands only; everything else is a Chord call. */
export type WindowRPC = {
  bun: RPCSchema<{ requests: Record<never, never>; messages: Record<never, never> }>;
  webview: RPCSchema<{ requests: Record<never, never>; messages: { command: { name: WindowCommand } } }>;
};
