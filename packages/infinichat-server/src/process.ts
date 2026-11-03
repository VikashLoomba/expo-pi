import { local, method, opaque } from '@earendil-works/chord';
import { obj, str } from '@earendil-works/pi-schema';

/**
 * What the host process gives the plugins it loads: InfiniChat's folder, this machine as the apps' device lists name
 * it, and what only the process can do. Its code lives in the runtime, so a plugin reload never changes it.
 */
export interface ServerProcess {
  /** `~/.infinichat`. */
  readonly home: string;
  readonly device: string;
  readonly description: string;
  /**
   * Settles once the host has loaded InfiniChat's plugin, the tools plugin and the user's plugins, so every extension
   * they register is in `Extensions`: the conversation's Harness resumes then (`conversation.ts`).
   */
  readonly loaded: Promise<void>;
  /** Ends the process as failed, so its service manager starts it again: reopening is how pi-durable recovers. */
  fail(error: unknown): void;
  /** Reloads the tools plugin and the user's plugins (`plugins.ts`); says what happened, the MCP servers' too. */
  reloadPlugins(): Promise<string>;
}

/**
 * The host process, as one object of lifetime `"host"` that the runtime serves before it loads any plugin. A plugin
 * holds it by this contract (Chord binds by description, chord `test/fixtures/loader.ts`).
 */
export const InfiniChatProcess = local('infinichat.process', {
  version: 1,
  input: obj({}, { open: true }),
  members: { process: opaque<ServerProcess>('infinichat.process@1') },
});

/**
 * The runtime's tools plugin (`tools-facet.ts`), one object of lifetime `"host"`, which the host asks after a reload
 * what its MCP servers did.
 */
export const InfiniChatTools = local('infinichat.tools', {
  version: 1,
  input: obj({}, { open: true }),
  members: {
    /** Connects each server that isn't, then says which connected, reconnected, closed or failed since the last run. */
    mcp: method(undefined, str()),
  },
});
