import { local, opaque } from '@earendil-works/chord';
import { Type } from '@earendil-works/pi-ai';

/**
 * What the host process gives the plugins it loads: InfiniChat's folder, this machine as the apps' device lists name
 * it, and what only the process can do. Its code lives in the runtime, so a plugin reload never changes it.
 */
export interface ServerProcess {
  /** `~/.infinichat`. */
  readonly home: string;
  readonly device: string;
  readonly description: string;
  /** Ends the process as failed, so its service manager starts it again: reopening is how pi-durable recovers. */
  fail(error: unknown): void;
  /** Reloads built-in/user plugins and their configuration, including MCP (`plugins.ts`); says what happened. */
  reloadPlugins(): Promise<string>;
}

/**
 * The host process, as one object of lifetime `"host"` that the runtime serves before it loads any plugin. A plugin
 * holds it by this contract (Chord binds by description, chord `test/fixtures/loader.ts`).
 */
export const InfiniChatProcess = local('infinichat.process', {
  version: 1,
  input: Type.Object({}),
  members: { process: opaque<ServerProcess>('infinichat.process@1') },
});
