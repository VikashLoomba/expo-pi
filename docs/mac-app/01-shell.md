# Piece 1: The shell

## Goal

`apps/mac` builds and runs on Hutch: one window with the app's layout and theme, native menus, macOS lifecycle, and the
spine every later piece hangs on: a Chord host in the main process that the window reaches over loopback. Nothing of
InfiniChat yet.

## What upstream does

- **Project shape:** the `hello-world` template (`hutch electrobun init --template=hello-world`, 2.0.5):
  `hutch.config.ts` with the `// @hutch cli=0.28.2 cottontail=0.7.3` pragma, `electrobun: { version: "2.0.5" }` and
  tasks; `electrobun.config.ts` with `app`, `build.mainProcess: "bun"`, `build.bun.entrypoint`, `build.views`,
  `build.copy`; `tsconfig.json` extending `./.hutch/devkit/tsconfig.json` with `jsx: "react-jsx"`; `.gitignore` of
  `.hutch/`, `build/`, `artifacts/`. In a monorepo Hutch loads the nearest `hutch.config.ts` and treats the directory
  with `electrobun.config.ts` as the app root (guides/migrating-to-v2 "Monorepos"); `packageManager: "pnpm"` delegates
  `hutch install` and `hutch pm exec` to pnpm.
- **Window and menus:** `new BrowserWindow({ title, url: "views://app/index.html", frame, titleBarStyle:
  "hiddenInset", preload, allowedProtocols })` (`BrowserWindow.ts:14-56`); `ApplicationMenu.setApplicationMenu` with
  roles and `action` items; `Electrobun.events.on("reopen" | "before-quit")`; `runtime.exitOnLastWindowClosed: false`
  for a Mac app that stays open without windows; `win.on("resize" | "move")` and `getFrame`.
- **React DOM:** `createRoot(container).render(<App />)`; `jsx: "react-jsx"` in tsconfig with React's own import
  source. Hutch's view bundler transpiles `.tsx` (the probe in references.md did it for Warren's runtime; React's is
  the same transform) and bundles `react-dom`.
- **Chord over loopback:** `createHost({ name, self, principalKey })`, `acceptWebSockets(server, host, { principal })`
  (`websocket.d.ts:14`), `webSocketLink(socket)` (`link.d.ts:84-92`), `host.connect(link, { onProtocolMismatch })`
  and `host.hold(Type, input)` for UI runtimes (guide "References"). `apps/mobile/server/listen.ts` is the `ws` server
  the server uses; the Mac's is the same without the client files.

## Builds

- `apps/mac/package.json`: `@pi-agent/mac`, private; dependencies `@pi-agent/infinichat: workspace:*`, the four pi
  packages from the catalog, `ws`, `react`, `react-dom`, `@silvia-odwyer/photon` (so pnpm links the `.wasm` where
  `build.copy` can find it); dev `@types/bun`, `@types/ws`, `@types/react`, `@types/react-dom`, `typescript`,
  `eslint`, `eslint-config-expo`; scripts `lint` and `typecheck` (`tsc --noEmit`, after `hutch electrobun prepare`).
- `hutch.config.ts` (pragma, pin, `packageManager: "pnpm"`, tasks `dev`, `build`, `build:dev`), `electrobun.config.ts`
  (`app` = InfiniChat, `com.vikashloomba.piagent.mac`, version from `package.json`; views `app`; copies of `index.html`
  and `app.css`; `runtime.exitOnLastWindowClosed: false`; `build.watch` for `../../packages/infinichat/src` if Hutch
  accepts it), `tsconfig.json`, `eslint.config.js` (the package's configuration without its host-import guard),
  `.gitignore`.
- Photon (deviation 5): `build.copy` places `node_modules/@silvia-odwyer/photon/photon_rs_bg.wasm` at
  `Resources/photon/photon_rs_bg.wasm`; `src/main/images.ts` reads it with `PATHS.RESOURCES_FOLDER` and calls
  `createPhotonImages(bytes)` once, as `images/node.d.ts` prescribes for a single-file binary. pi-ai's bundled SDKs
  call `require()`: Bun's bundler rewrites those; if one still reaches a global `require`, the entry's first line
  makes one with `createRequire(import.meta.url)`, as the server's banner does.
- `src/contract.ts`: `MacPrincipal` (`{ kind: 'owner' } | { kind: 'host' }`) and `MacApp` (`remote('infinichat.mac',
  { version: 1, host: hostNamed('mac') })`) with one cell, `about` (version, `userData`), as the probe of the spine.
- `src/main/host.ts`: `createHost<MacPrincipal>({ name: 'mac', self: { kind: 'host' }, principalKey })`; serves
  `MacApp`. `src/main/listen.ts`: a `ws` `WebSocketServer` on `127.0.0.1:0`; `acceptWebSockets` with `principal`
  comparing the `Sec-WebSocket-Protocol` the page sends (a browser can set no other header) with the launch's secret
  (32 random bytes, hex), in constant time; `handleProtocols` echoes it. Every window acts as `{ kind: 'owner' }`.
- `src/main/rpc.ts`: the Electrobun RPC schema, `webview.messages.command: { name }`, used by menu actions and
  `reopen`; `bun` has nothing. `src/main/index.ts`: the menu (App: About, Settings… `⌘,` as an action, Hide, Hide
  Others, Show All, Quit; File: New Chat `⌘N` as an action, Close; Edit roles; View: Toggle Full Screen; Window:
  Minimize, Zoom), the window with `preload: "window.__mac = { port, secret }"`, the window's frame remembered in
  `userData/settings.json` on `resize`/`move` and restored at launch, `reopen` showing or recreating the window,
  `before-quit` running the close chain once (host, then the `ws` server) and quitting again when it is done.
- `src/view/index.html`, `src/view/index.tsx` (reads `window.__mac`, `client.ts`'s `connect`, renders `App`),
  `src/view/client.ts` (`createHost({ name: 'window', self: { kind: 'owner' }, kind: 'client' })`,
  `host.connect(webSocketLink(new WebSocket(url, [secret])), { onProtocolMismatch: () => location.reload() })`,
  `hold`), `src/view/use-ref.ts` (`useMember(member)` with `useSyncExternalStore` over the member's `subscribe` and
  `value`; `useStatus(ref)` over `onStatus`), `src/view/app.tsx` (the layout: a sidebar and a detail pane under a
  toolbar whose empty area is `app-region: drag`, the sidebar listing InfiniChat and, later, the chats), `app.css`
  (tokens on `:root` for light and dark, `-apple-system` text, HIG sizes).

## Ownership and lifetime

The main process creates the host, the `ws` server and the window, and closes them in that order at quit; nothing
survives the process. The secret lives for one launch, in the main process and in the pages it preloads. A window's
link ends with the window; the host releases what the window held (guide "Hosts and links"). A link lost while the
main process lives doesn't happen on loopback; the page reloads on a protocol mismatch only.

## Deviations

5 (Hutch bundles the main process; the Photon resource). None otherwise: the files are the template's, with pnpm.

## Size

About 450 lines (config ~100, main ~180, contract ~20, view ~150) and ~150 lines of CSS.

## Checks

- `hutch electrobun build --env=dev` bundles `@pi-agent/infinichat`, chord, pi-durable's Node storage and pi-ai (its
  `require` calls included) into the main process, and chord and React into the view; the built `.app` runs and
  `createPhotonImages` prepares a test image from the copied resource.
- `hutch run dev`: the window opens with the layout; the sidebar footer shows the version from the `MacApp` ref, so
  Chord runs over loopback; a second client with a wrong secret is refused.
- Closing the window leaves the app in the Dock; clicking it reopens the window at its last frame; `⌘Q` quits
  through `before-quit`; `⌘,` and `⌘N` reach the page as commands (logged for now).
- `pnpm --filter @pi-agent/mac lint`, `pnpm --filter @pi-agent/mac typecheck`.

## Not in this piece

Any InfiniChat object, the Settings window (piece 4), signing (piece 9).

## As built

From `88ae496` on `feat/mac-app-shell` (2026-10-28), with Electrobun 2.0.5, Hutch 0.28.2, Bun 1.4.4, chord 1.4.0,
React 19.3.0 and TypeScript 6.0.3. What differs from the plan:

- **TypeScript 6 against the devkit and chord.** The projected `tsconfig.json` sets `baseUrl`, which TypeScript 6
  deprecates, so `apps/mac/tsconfig.json` sets `ignoreDeprecations: "6.0"`. Its DOM library types `WebSocket.send`
  with `BufferSource` and its message listeners with `Event`, which chord's `WebSocketLike` (`link.d.ts:84-92`) doesn't
  match, so `src/view/client.ts` wraps the browser socket in `socketLike`, a narrower `send` and a listener that
  passes the `data` of message events; no cast. `acceptWebSockets` infers its principal from the callback, so that
  callback states `MacPrincipal | undefined`.
- **The RPC schema's empty sides are `Record<never, never>`**, not the docs' `{}`, which the lint rejects.
- **A socket that offers no subprotocol completes the handshake** (`ws` consults `handleProtocols` only for offered
  ones) and is then refused by `acceptWebSockets`' `principal`, chord's own refusal (`websocket.d.ts:10-11`); a wrong
  one fails the handshake. Both checked with a Bun script against the running app.
- **Hutch bundles the main process** (`app/bun/index.js`, 1.2 MB) with pi-ai's `require` calls rewritten to its own
  helper; `Resources/main.js` is Hutch's 8 KB loader. The view bundle is 1.7 MB. Photon's `.wasm` lands at
  `Resources/app/photon/photon_rs_bg.wasm`, which `src/main/images.ts` reads. `build.watch` with `../../packages`
  was accepted; whether `dev --watch` rebuilds on package edits is unverified.
- In a dev build `Utils.paths.userData` is `~/Library/Application Support/com.vikashloomba.piagent.mac/dev` and
  `Updater.getLocalInfo()` reads the version from `version.json`.

Verified on this Mac with `hutch electrobun run --env=dev` and its forwarded console: startup; the window's
`MacApp` reference going `loading` then `live` with the `about` cell; the frame saved on quit and restored at the
next launch; a reopen while running (`open` on the running bundle); an Apple-event quit running `before-quit`, the
close chain and exiting 0; the listener's two refusals. Not verified, since this session has no Accessibility or
Screen Recording permission: closing the window and reopening from the Dock, `⌘N` and `⌘,` arriving as commands,
and the Edit menu's roles in a text field. The icon warning stays until piece 9.
