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

/** What the Linux entry's desktop is made of: the virtual display, its session bus and its window manager. */
const DESKTOP_PROGRAMS = ['xvfb-run', 'dbus-run-session', 'xfwm4'];
/**
 * What the Linux entry runs: the driver in a virtual desktop of its own, so a machine needs no monitor and no login,
 * and the agents never take a real session's pointer. Cua runs the driver headless this way ("wrap this command in
 * xvfb-run and dbus-run-session", `scripts/ci/linux/run-rust-e2e.sh`, read at `bff492d`). The display's size and
 * options, the accessibility variables and a runtime folder of its own are those of Cua's desktop image
 * (`libs/images/common/desktop/start-desktop.sh`), and the window manager that of XFCE, which Cua validates on.
 */
const DESKTOP = [
  // Only the driver may write to the MCP stream. xvfb-run joins its command's stderr to stdout, and the session's
  // services inherit stdout, so stdout is kept as descriptor 3 for the driver and everything else writes to stderr.
  'exec 3>&1 >&2',
  // The service may have a real session's environment (the account's service manager takes it in at a login). With
  // these, an app would open in the Wayland session, or sign on to that session's manager, which ends its clients
  // at a logout. The display, its key and the session bus are replaced below. The last two are what Cua's image
  // unsets.
  'unset WAYLAND_DISPLAY SESSION_MANAGER NO_AT_BRIDGE',
  // The session mounts gvfs and starts dconf and an accessibility bus in its runtime folder, which would otherwise be
  // the real session's.
  'export XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR/infinichat-desktop"',
  'mkdir -p -m 700 "$XDG_RUNTIME_DIR"',
  'export GTK_MODULES=gail:atk-bridge GNOME_ACCESSIBILITY=1 QT_ACCESSIBILITY=1 QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1',
  'export MOZ_ENABLE_ACCESSIBILITY=1 ACCESSIBILITY_ENABLED=1',
  `exec xvfb-run -a -s '-screen 0 1280x800x24 -dpi 96 +extension RANDR +extension GLX -noreset' `
    + `dbus-run-session -- sh -c 'xfwm4 3>&- & exec "$HOME/${LINK}" mcp >&3 3>&-'`,
].join('\n');

/** The end of what a failed command wrote, where the installer says why. */
function reason(error: unknown): string {
  const output = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
  return output.trim().split('\n').slice(-3).join('\n') || (error instanceof Error ? error.message : String(error));
}

/** Which of the desktop's programs this machine lacks, on the path the entry's command gets. */
async function missingPrograms(signal: AbortSignal): Promise<string[]> {
  const lacking = await run('/bin/sh', ['-c', 'for name; do command -v "$name" >/dev/null || echo "$name"; done', 'sh',
    ...DESKTOP_PROGRAMS], { signal });
  return lacking.stdout.split('\n').filter(Boolean);
}

/**
 * Cua Driver (github.com/trycua/cua, read at 0.47.6), which lets the agents see and operate desktop apps on this
 * machine as an MCP server: installed by its own installer when the account has none, and added to the MCP
 * configuration once, after that install. The entry is the user's from then on: removed or turned off, it stays so,
 * since the driver is installed. A native of the tools plugin's object (`tools-facet.ts`), which closes it with the
 * host; that ends an install under way, whose swap into place is atomic, so the next start tries again. Cua's
 * installer, updater and uninstaller own the driver's files, and the MCP connection its process, as any stdio
 * server's (`McpServer`). On macOS that process hands over to Cua's own app, which the system's permissions belong
 * to and which asks for them. On Linux the connection's process is the driver's whole desktop (`DESKTOP`), in one
 * process group that pi-mcp ends when the connection closes (`StdioTransport`): the apps the driver starts are its
 * children and end with it, so nothing in the desktop could outlive it and the display goes too.
 */
export class CuaDriver {
  private readonly controller = new AbortController();
  private running?: Promise<string | undefined>;

  /** `config` is the MCP configuration the entry goes into. */
  constructor(private readonly config: string) {}

  /**
   * Installs the driver when the account has none; one install at a time. Says that it did, for the caller to apply
   * the configuration again, or resolves undefined when there was nothing to do. A failed install rejects with the
   * installer's reason, as does a Linux machine that lacks a program of the desktop, and the next call tries again.
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
    // A desktop of its own on Linux only: on macOS the driver hands over to Cua's app, which works on the real screen.
    const linux = platform() === 'linux';
    try {
      // First, so a machine that could not give the driver its desktop gets no driver.
      const missing = linux ? await missingPrograms(signal) : [];
      if (missing.length > 0) throw new Error(`its desktop needs ${missing.join(', ')}, which this machine lacks`);
      await run('/bin/bash', ['-c', INSTALL], { signal, env: { ...process.env, ...SWITCHES } });
    } catch (error) {
      if (signal.aborted) return undefined;
      throw new Error(`Cua Driver could not be installed: ${reason(error)}`);
    }
    addMcpServer(this.config, NAME, { ...(linux ? { command: 'sh', args: ['-c', DESKTOP] }
      : { command: `~/${LINK}`, args: ['mcp'] }), toolExposure: LISTED });
    return 'Cua Driver installed.';
  }
}
