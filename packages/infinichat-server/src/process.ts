import { local, method } from '@earendil-works/chord';
import { str } from '@earendil-works/pi-schema';
import { InfiniChatMcpMembers } from '@pi-agent/infinichat/pi/infinichat-remote/mcp-contract';

/**
 * What the host process gives the plugins of its runtime, as start data (chord `docs/design.md` §18): InfiniChat's
 * folder, this machine as the apps' device lists name it, and what only the process can do. Each of those plugins'
 * modules exports a function of it that returns the facet (`main.ts`), as the design's `coreServerFacet(config)`.
 */
export interface ServerProcess {
  /** `~/.infinichat`. */
  readonly home: string;
  readonly device: string;
  readonly description: string;
  /**
   * Settles once the host has loaded InfiniChat's plugin, the tools plugin and the user's plugins, so every extension
   * they contribute is in `Extensions`: the conversation's Harness resumes then (`conversation.ts`).
   */
  readonly loaded: Promise<void>;
  /** Ends the process as failed, so its service manager starts it again: reopening is how pi-durable recovers. */
  fail(error: unknown): void;
  /** Reloads the user's plugins and reads the MCP configuration again (`plugins.ts`); says what happened. */
  reloadPlugins(): Promise<string>;
}

/** A method without a result answers `null`, its wire form (chord `docs/design.md` §5, "Methods"). */
export const done = async (work: unknown): Promise<null> => {
  await work;
  return null;
};

/**
 * The tools plugin's store (`tools-facet.ts`), one object for the host's life: code mode's sandbox and the MCP
 * servers of `~/.infinichat/mcp.json`, with `/mcp`'s members, which the type clients hold re-exposes.
 */
export const InfiniChatTools = local('infinichat.tools', {
  version: 1,
  params: {},
  members: {
    ...InfiniChatMcpMembers.state,
    ...InfiniChatMcpMembers.methods,
    /**
     * Reads the configuration again: connects the servers added, reconnects those whose connection changed, closes
     * those removed, and connects each that is left but isn't connected. Says what it did.
     */
    mcp: method(undefined, str()),
  },
});
