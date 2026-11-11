import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { addMcpServer } from './mcp-config';

const run = promisify(execFile);

/** The server's name in the configuration, as Cua's `connect` and `mcp-config` name it. */
const NAME = 'cua-driver';
/** Where Cua's installer links the program on macOS and Linux, under the home folder: the path its updates keep. */
const LINK = '.local/bin/cua-driver';
/**
 * Cua's install line (github.com/trycua/cua README, "Cua Driver", macOS / Linux), then its telemetry turned off for
 * good (`docs/cua-driver/guides/operate`, "Telemetry"). A download that fails ends it before anything runs.
 */
const INSTALL = 'script=$(curl -fsSL https://cua.ai/driver/install.sh) && /bin/bash -c "$script" '
  + `&& "$HOME/${LINK}" telemetry disable`;
/**
 * The installer's own switches (its header): it leaves the account's Claude Code, Codex and Cursor, its shell
 * profile and its screen alone, and sends no install event. Its permission guide needs a terminal, which a service
 * has none of.
 */
const SWITCHES = {
  CUA_DRIVER_NO_CONNECT: '1', CUA_DRIVER_NO_TEST: '1', CUA_DRIVER_NO_MODIFY_PATH: '1',
  CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
};

/**
 * The one tool of the driver's 66 that code mode's prompt section declares. The section leaves out the tools of the
 * default exposure, and a server none of whose tools it declares gets no heading there (durable
 * `src/codemode/codemode.ts`, `describe.ts`), so the model would learn of the driver only by searching. With its
 * guide declared, the section names the server with Cua's own one-line description, and the guide tells of the rest.
 * The section's budget is shared with InfiniChat's own tools, which the driver's larger tools would crowd out.
 */
const LISTED = { get_guide: 'direct' } as const;

/** The end of what a failed command wrote, where the installer says why. */
function reason(error: unknown): string {
  const output = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
  return output.trim().split('\n').slice(-3).join('\n') || (error instanceof Error ? error.message : String(error));
}

/**
 * The X display of the account's desktop session on Linux. The service starts with the account's service manager,
 * before a desktop session, so its own environment often lacks `DISPLAY`; the session hands it to the manager once
 * it is up. Undefined when the machine has no session to drive.
 */
async function sessionDisplay(signal: AbortSignal): Promise<string | undefined> {
  if (process.env.DISPLAY) return process.env.DISPLAY;
  const shown = await run('systemctl', ['--user', 'show-environment'], { signal }).catch(() => undefined);
  return /^DISPLAY=(\S+)$/m.exec(shown?.stdout ?? '')?.[1];
}

/**
 * Cua Driver (github.com/trycua/cua, read at 0.47.6), which lets the agents see and operate this machine's desktop
 * apps as an MCP server: installed by its own installer when the account has none, and added to the MCP configuration
 * once, after that install. The entry is the user's from then on: removed or turned off, it stays so, since the driver
 * is installed. A native of the tools plugin's object (`tools-facet.ts`), which closes it with the host; that ends an
 * install under way, whose swap into place is atomic, so the next start tries again. Cua's installer, updater and
 * uninstaller own the driver's files, and the MCP connection its process, as any stdio server's (`McpServer`). On
 * macOS that process hands over to Cua's own app, which the system's permissions belong to and which asks for them.
 */
export class CuaDriver {
  private readonly controller = new AbortController();
  private running?: Promise<string | undefined>;

  /** `config` is the MCP configuration the entry goes into. */
  constructor(private readonly config: string) {}

  /**
   * Installs the driver when the account has none and the machine a desktop to drive; one install at a time. Says
   * that it did, for the caller to apply the configuration again, or resolves undefined when there was nothing to do;
   * a failed install rejects with the installer's reason, and the next call tries again.
   */
  ensure(): Promise<string | undefined> {
    this.running ??= this.install().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  close(): void {
    this.controller.abort();
  }

  private async install(): Promise<string | undefined> {
    const { signal } = this.controller;
    if (existsSync(join(homedir(), LINK))) return undefined;
    const linux = platform() === 'linux';
    // Linux only: on macOS the driver's app finds the screen itself.
    const display = linux ? await sessionDisplay(signal) : undefined;
    if (linux && display === undefined) return undefined;
    try {
      await run('/bin/bash', ['-c', INSTALL], { signal, env: { ...process.env, ...SWITCHES } });
    } catch (error) {
      if (signal.aborted) return undefined;
      throw new Error(`Cua Driver could not be installed: ${reason(error)}`);
    }
    // The MCP client adds an entry's `env` to the server's own (pi-mcp `StdioTransport`), and the driver finds the
    // display's key and the session bus itself once it has the display (Cua `platform-linux/src/xauth.rs`).
    addMcpServer(this.config, NAME, { command: `~/${LINK}`, args: ['mcp'],
      ...(display === undefined ? {} : { env: { DISPLAY: display } }), toolExposure: LISTED });
    return 'Cua Driver installed.';
  }
}
