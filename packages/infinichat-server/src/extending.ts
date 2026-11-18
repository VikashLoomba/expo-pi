import { join } from 'node:path';

import { awaitWithContext } from '@earendil-works/chord/context';
import { defineExtension, defineTool, section, type Extension } from '@earendil-works/pi-durable';
import { obj } from '@earendil-works/pi-schema';

import type { ServerProcess } from './process';

/** The guide within a runtime folder, `docs/extending.md` of this package as a release ships it (`build.mjs`). */
const GUIDE = 'docs/extending.md';

/**
 * What tells the agents on a machine that they can extend the server they run on, as pi's coding agent tells its
 * model of pi's own documentation (`packages/coding-agent/src/core/system-prompt.ts`, `promptSections.docs`): a
 * section naming the user's plugins folder, the MCP configuration and the guide a release ships, read only when the
 * user asks for a tool or a server. Its text is the same at every request, so it is sent once and stays cached
 * (durable `test/examples/14-system-prompt.ts`). A conversation the phone holds has none of this, and no section.
 *
 * `reload_plugins` is the agents' `/reload-plugins`. pi's own tools cannot reload (coding-agent `docs/extensions.md`,
 * "ctx.reload()"); the owner has the agent apply its change and read what failed (2026-11-17). It waits for the
 * process's one reload, which goes on when the call is aborted, as it does when a client's link drops. A call running
 * during a reload keeps the code it took (durable `test/examples/30-reload-and-restart.ts`), so the script that
 * reloads calls the new tools from the next one. Reloading again changes nothing more, so a call a restart cut off
 * runs again. It is deferred: code mode's section leaves it out, and this section names it.
 */
export function extending(proc: ServerProcess): Extension {
  const text = [
    'On the device holding this chat you can give yourself new tools, when the user asks for one or for an MCP server:',
    '- A plugin, a folder of ~/.infinichat/plugins, adds tools, prompt sections and hooks.',
    '- An entry of ~/.infinichat/mcp.json adds an MCP server.',
    `Before either, read ${join(proc.runtime, GUIDE)} and follow it.`,
    'Apply a change with `await tools.reload_plugins()` in a script: it says what loaded, what failed and why.',
    'The user signs in to an MCP server that needs it with /mcp in the app.',
  ].join('\n');
  return defineExtension({
    name: 'infinichat.extending',
    sections: [section('extending', () => text)],
    tools: [defineTool({
      name: 'reload_plugins',
      description: 'Reload the plugins of ~/.infinichat/plugins and the MCP servers of ~/.infinichat/mcp.json on the '
        + 'device holding this chat, after changing either. Says which plugins were added, reloaded or removed, which '
        + 'MCP servers connected, and what failed and why.',
      parameters: obj({}),
      deferred: true,
      replay: 'safe',
      execute: async (_args, _api, context) =>
        ({ output: [{ type: 'text', text: await awaitWithContext(proc.reloadPlugins(), context) }] }),
    })],
  });
}
