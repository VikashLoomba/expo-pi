# Handoff: computer use on a Linux machine with no display

Written 2026-11-16 for the agent that picks this up on the owner's Linux machine. Nothing here is built yet. It
records what the owner asked for, what was measured, what Cua does, and what still has to be decided. Delete this
file when the work ships; `docs/server-plugins.md` is where the result is documented.

## What the owner asked for

- "I would like to figure out how to get cua computer use working without needing a display connected. The machine
  is most often used headlessly."
- Offered two routes (a virtual desktop the server starts, or keeping the real session drawing with a dummy plug),
  the owner chose the first: "the virtual desktop for the server work we need to do".
- "I assume we don't need to do any hard work and just use cua (which I thought we were already)." We are, and the
  driver needs no change. What is missing is only a display for it: Cua Driver connects to whatever `DISPLAY` its
  environment names and starts none itself. So the owner expects a small change, and a large one means the design
  is wrong (AGENTS.md, "Size is a signal").

## Where things stand (server 4.2.1)

- `packages/infinichat-server/src/cua-driver.ts` installs Cua Driver when the account has none and, on Linux, a
  desktop session, then adds the `cua-driver` server to `~/.infinichat/mcp.json` with `env.DISPLAY` and
  `toolExposure: { get_guide: 'direct' }`. `tools-facet.ts` owns it; `mcp-config.ts` has `addMcpServer`.
  `docs/server-plugins.md`, "Computer use: Cua Driver", describes all of it.
- This machine's live server (`infinichat.service`, a user unit, running from `~/.infinichat`, not from this
  checkout) has the driver, 0.47.7 at `~/.local/bin/cua-driver`, and this entry:
  `{"command":"~/.local/bin/cua-driver","args":["mcp"],"env":{"DISPLAY":":0"},"toolExposure":{"get_guide":"direct"}}`.
- A real turn worked end to end on 2026-11-10: the prompt named `mcp__cua-driver`, the model called
  `get_desktop_state`, passed the PNG to `image()`, and Claude described it.

## The problem

The picture the agent got was stale. This machine runs Cinnamon on X11 at `:0`, and its monitor is usually off or
unplugged. With every output disconnected the compositor stops drawing, and every capture returns the last frame.

- The agent's capture at 21:24 showed the panel clock at 20:21. A capture six days later by ImageMagick
  (`import -window root`), not Cua, showed the same clock and was the same size to the byte.
- At 20:21:45 that day Cinnamon logged `_monitorsChanged` in `~/.xsession-errors`; since then `xrandr --query` on
  `:0` lists every output as disconnected.
- Screensaver, lock and DPMS are all off there, so they are not the cause. It is the X session, not Cua.

To see it: `DISPLAY=:0 xrandr --query | grep -c " connected"` prints 0, and the clock in a fresh root capture is
days old.

## What Cua does about machines with no screen

Read on 2026-11-16 at trycua/cua `fcdf49c` (driver 0.52.9) by a research pass; re-read a passage before relying on
it. cua.ai's docs are `docs/content/docs` in that repository.

- Cua documents no way to keep a host's own X session drawing without a monitor, and the driver has no stale-frame
  or no-output check (`doctor.rs`, `health_report.rs`; open issue #5964, no maintainer reply).
- Its own answer is a virtual X display. `libs/images/common/desktop/start-desktop.sh` starts Xvfb (or Xvnc), a
  session `dbus-daemon` at a fixed address, then XFCE, with `GTK_MODULES=gail:atk-bridge`, `GNOME_ACCESSIBILITY=1`,
  `QT_ACCESSIBILITY=1`, and sets `org.a11y.Status IsEnabled`. Its CI says: "For a headless session, wrap this
  command in xvfb-run and dbus-run-session" (`scripts/ci/linux/run-rust-e2e.sh`).
- A Linux guide removed in June 2026 (`docs/.../getting-started/linux.mdx` at `d52f26b371`) gave
  `xvfb-run -a cua-driver serve`, and the source's no-display error still says "or Xvfb for headless"
  (`platform-linux/src/lib.rs`).
- Stated limits under a virtual server: no MPX/uinput background pointer, so some actions need
  `delivery_mode: "foreground"`, and drags fall back to XSendEvent (`Skills/cua-driver/LINUX.md`).
- There is no flag that points the driver at a display. Bare `cua-driver mcp` on Linux owns its runtime and uses
  its environment. Its session-bus lookup prefers `/run/user/<uid>/bus` when `DBUS_SESSION_BUS_ADDRESS` is unset
  (`session_bus.rs`), so a second session must pass its own bus address or the driver reads the real session's
  accessibility tree.
- Cua's product route, Linux Spaces in Docker, is a different tool surface (cua-spacesd), not `cua-driver mcp`.

## What was measured here

On this machine, with the installed driver, in a private run that never touched `:0` (own `XDG_RUNTIME_DIR`, one
process group, removed afterwards):

```bash
env -u DISPLAY -u XAUTHORITY -u WAYLAND_DISPLAY -u DBUS_SESSION_BUS_ADDRESS \
  XDG_RUNTIME_DIR="$(mktemp -d)" DO_NOT_TRACK=1 CUA_DRIVER_RS_UPDATE_CHECK=false \
  xvfb-run -a -s "-screen 0 1920x1080x24 -dpi 96 -nolisten tcp +extension RANDR +extension GLX -noreset" \
  dbus-run-session -- sh -c '
    export GTK_MODULES=gail:atk-bridge GNOME_ACCESSIBILITY=1 QT_ACCESSIBILITY=1
    metacity >/dev/null 2>&1 &
    xclock -digital -update 1 >/dev/null 2>&1 &
    zenity --entry --title="probe entry" --text=probe >/dev/null 2>&1 &
    exec "$HOME/.local/bin/cua-driver" mcp'
```

Speaking MCP over that command's stdin and stdout:

- 66 tools; `get_screen_size` said 1920x1080; two `get_desktop_state` captures 2.5 s apart differed.
- `get_window_state` returned the dialog's AT-SPI tree; `type_text` typed into it ("via AT-SPI") and the next
  capture showed the text.
- The machine already has Xvfb, xvfb-run, Xvnc, XFCE, metacity, dbus-run-session and AT-SPI. Nothing was installed.
- `xvfb-run` merges the command's stderr into its stdout, so dbus-daemon's and the driver's log lines land in the
  MCP stream. Whatever starts the display must keep the driver's stdout clean.

Not tested: clicks, drags and scrolling; a real browser in the virtual display; the server's own MCP client against
such a command; what a second copy of an app does while the real session runs the first.

## What has to be decided, with the owner, before code

AGENTS.md asks for a design and the owner's approval first. The questions the design has to answer:

1. **Who owns the display.** Two shapes, both from Cua:
   - The entry's command starts it (Cua's CI and removed guide): the display lives exactly as long as the MCP
     connection, which the server already owns, and the server gains almost no code. Its apps end when the
     connection is replaced. See "How a reload treats servers" in `docs/server-plugins.md` for when that happens.
   - The tools object starts it (Cua's images): the display outlives reconnects and ends with the host, at the
     cost of a native that owns three processes.
2. **When a machine gets a virtual display.** Always on Linux, or only when the session has no connected output.
   Today a machine with no desktop session gets no driver at all (`sessionDisplay` in `cua-driver.ts`); with a
   virtual display it could.
3. **What runs in it.** Xvfb or Xvnc (which the owner could watch), which window manager, what size.
4. **Machines missing the programs.** The server installs nothing with root. Say what happens there.
5. **The entry that exists.** Once added, the entry is the user's and the server never rewrites it. This machine's
   has `DISPLAY=:0`; moving it is a hand edit the owner approves, as for 4.2.1. The app is unreleased: no migration
   code.

## Rules that are not all in AGENTS.md

- The owner's live conversation is on this machine (`~/.infinichat/data/infinichat.db`). Read it only with
  `sqlite3 "file:...?mode=ro"`; never write it, never send a message into it.
- `/reload-plugins` is the user's command, and restarting or signalling `infinichat.service` is the owner's call.
  Its log is `journalctl --user-unit infinichat.service`.
- Probes do not drive the owner's real apps on `:0`. Scratch runs use a scratch `HOME` or scratch config, set
  `DO_NOT_TRACK=1` and `CUA_DRIVER_RS_UPDATE_CHECK=false`, and leave nothing behind; check `/tmp/.X11-unix` after.
- The owner's standing choices for this feature: no code about macOS permissions, no telemetry, the server never
  updates or removes the driver.
- Cua's uninstaller finds daemons with `pgrep -f`, which also matches a shell whose command line names
  `cua-driver`; run it from a downloaded file.
- A release is the server package's lint, typecheck, build and `check`, the docs, a commit and push, then
  `pnpm release` there ("Release" in `docs/server-plugins.md`). Releasing from this machine has not been tried.
