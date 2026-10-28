# References

Evidence the Mac app's pieces rely on. Read on 2026-10-27 unless noted. Electrobun paths are inside the generated
`.hutch/devkit` projection, which is identical for every project on the same Electrobun release and platform; the
line numbers are from the 2.0.5 macOS ARM64 projection.

## Versions

| What | Version | Where it is pinned |
| --- | --- | --- |
| Electrobun | 2.0.5 (released 2026-10-26) | `apps/mac/hutch.config.ts` → `electrobun.version` |
| Hutch (build CLI) | 0.28.2, paired with 2.0.5 | `// @hutch cli=0.28.2 cottontail=0.7.3` pragma; installed at `~/.hutch/bin/hutch` (not on `PATH`) |
| Bun (app main process) | 1.4.4, downloaded and packaged by Hutch | the Electrobun release's devkit manifest |
| Cottontail | 0.7.3, build-time only (loads configs, bundles) | paired with Hutch |
| macOS deployment target | 14 or later, arm64 and x64 built natively on each | Electrobun |
| pi-durable, pi-ai, chord, pi-env | 1.4.0 | `pnpm-workspace.yaml` catalog |
| Node on this Mac | 25.6.1 (`~/.nvm/versions/node/v25.6.1/bin/node`) | what the LaunchAgent server runs on |
| Signing identity | `Developer ID Application: Vikash Loomba (BMNS2Z2BU9)` | the login keychain (`security find-identity -v -p codesigning`) |
| Release host | `https://github.com/VikashLoomba/expo-pi` (public, no releases yet) | `electrobun.config.ts` → `release.baseUrl` |

Documentation: https://framework.blackboard.sh/electrobun/ (guides and `apis/*`), all read page by page on 2026-10-27.
The template catalog and the Electrobun core are downloaded by Hutch at `init`/`prepare` time; nothing from the npm
`electrobun` package is used.

## Electrobun contracts

| Contract | Where | What it says |
| --- | --- | --- |
| Project ownership | guides/project-ownership | `hutch.config.ts` owns the release pin, tasks and the package-manager choice; `electrobun.config.ts` owns app identity, build inputs, views, copies, signing, release. The SDK is projected into `.hutch/devkit` (generated, ignored); `tsconfig.json` extends `.hutch/devkit/tsconfig.json`. |
| Monorepos | guides/migrating-to-v2 "Monorepos" | Hutch loads the nearest `hutch.config.ts` only; each directory with `electrobun.config.ts` is an app root with its own `build/`, `artifacts/` and `.hutch/devkit`. |
| Package manager | guides/hutch "Everyday commands" | `packageManager: "pnpm"` makes `hutch install` and `hutch pm …` delegate to pnpm; Hutch's own resolver would ignore `pnpm-lock.yaml`. |
| Bundling | apis/cli/build-configuration "JavaScript Bundling" | Hutch forwards only `minify`, `sourcemap`, `target`, `external`, `define`, `alias` (views also `format`). No `loader` or `banner`; no plugins. Photon's `.wasm` is therefore a copied resource (pi-durable `images/node.d.ts`: "A single-file binary cannot resolve the package: read its own copy of `photon_rs_bg.wasm` and call `createPhotonImages()`"). |
| Views | apis/bundled-assets | `build.views.<name>.entrypoint` becomes `views/<name>/index.js`, served as `views://<name>/index.js`; `build.copy` places HTML and CSS beside it. The view bundler transpiles `.tsx` (verified below). |
| `BrowserWindow` options | `.hutch/devkit/api/sdks/main/core/BrowserWindow.ts:14-56` | `titleBarStyle: "default" \| "hidden" \| "hiddenInset"` (`:43`), `preload: string \| null` (`:29`), `trafficLightOffset` (`:15`), `hidden`, `activate`, `transparent`, `rpc`. |
| `BrowserView` events and RPC | apis/browser-view | `dom-ready`, `did-navigate`, downloads; `BrowserView.defineRPC<Schema>` with `bun`/`webview` sides; `executeJavascript` returns nothing. |
| Browser SDK | `.hutch/devkit/api/browser/index.ts` | `Electroview.defineRPC` + `new Electroview({ rpc })` attach the typed transport; `window.__electrobunPlatform`, `__electrobunWebviewId`. |
| Warren DOM (not used: the window is React, see README) | `.hutch/devkit/api/browser/ui/index.ts` | exports `signal`, `store`, `live`, `memo`, `inert`, `cleanup`, `batch`, `createRoot`, `For`, `Show`, `Switch`/`Match`, `Portal`, `render`, `currentParent`; JSX runtime at `electrobun/browser/ui/jsx-runtime`. |
| Warren reactivity (not used) | `.hutch/devkit/api/shared/warren/reactive.ts` | `signal` `:253`, `memo` `:344`, `live` `:386`, `inert` `:489`, `cleanup` `:500`, `createRoot` `:521`, `store` `:567` (read-only proxy, mutator setter). Components run once; bare functions in value positions throw. |
| Warren DOM renderer (not used) | `.hutch/devkit/api/browser/ui/dom.ts` | `render(app, container)` `:437` returns dispose; `Portal` `:466`; `currentParent` `:87` for DOM libraries; behaviour pinned by `browser/ui/__tests__/dom.test.ts`. |
| Warren GPU (not used) | guides/electrobun-ui "Current limitations" | Single-line text, no wrapping or truncation, flex subset, experimental; needs `bundleWGPU`. |
| Events | apis/events | `before-quit` (synchronous, `event.response = { allow: false }` cancels), `reopen`, `open-url`; window `close`, `focus`, `blur`. |
| Utils | apis/utils | `showNotification`, `showMessageBox`, `openFileDialog`, clipboard, `paths.userData` = `<base>/<identifier>/<install-root>`, `quit`. Directories are not created for you. |
| Application menu | apis/application-menu | `ApplicationMenu.setApplicationMenu([...])` with roles (`undo`…`selectAll`, `quit`, `close`, `toggleFullScreen`) and `action` items; `application-menu-clicked`. |
| Runtime | apis/cli/build-configuration "Runtime Values" | `runtime.exitOnLastWindowClosed` (default `true`); `BuildConfig.get()` reads `build.json`/`version.json`. |
| Signing | guides/code-signing | `build.mac.codesign/notarize/createDmg`; env `ELECTROBUN_DEVELOPER_ID` plus either `ELECTROBUN_APPLEAPIKEYPATH/APPLEAPIKEY/APPLEAPIISSUER` or `ELECTROBUN_APPLEID/APPLEIDPASS/TEAMID`; `ELECTROBUN_SKIP_NOTARIZATION=1` for a dry run. Dev builds are never signed by Hutch. |
| Updates | guides/updates, apis/updater | `release.baseUrl`; artifacts uploaded unrenamed; `stable-macos-arm64-update.json`; GitHub's `releases/latest/download` works for stable only; `Updater.checkForUpdate()`, `downloadUpdate()`, `applyUpdate()` (asks `before-quit`), `onStatusChange`. |
| Icons | apis/application-icons | `build.mac.icons` is an `.iconset` directory (converted with `iconutil`) or an Icon Composer `.icon` (needs Xcode's `actool`). |
| streamdown | npm `streamdown@2.7.1` (checked 2026-10-27) | A React component (peer `react`, `react-dom`); depends on `unified`, `remark-parse`, `remark-gfm`, `remark-rehype`, `rehype-sanitize`, `rehype-harden`, `marked`, `remend`; exports `.` and `./styles.css`. The phone's `react-native-enriched-markdown@1.1.1` streams through react-native-streamdown (README:22) with `remend@1.3.0` in the tree. |
| Hot reload | guides/hot-reloading | `hutch electrobun dev --watch` rebuilds and relaunches the whole app; no in-process HMR; a Vite template would give the window HMR. |

## Probe (2026-10-27)

A scratch project from the `hello-world` template (Bun main process). `hutch electrobun build --env=dev` took 1.2 s
and produced a 90 MB `hello-world-dev.app`. Then, in one run of `hutch electrobun dev`:

- `src/mainview/index.tsx` imported `electrobun/browser/ui` and rendered `signal`/`live`/`For` into `document.body`;
  Hutch's view bundler read `jsxImportSource` from `tsconfig.json` without further configuration.
- The `views://mainview/index.html` page opened `ws://127.0.0.1:<port>` to a `Bun.serve` WebSocket server in the main
  process, the port passed through the window's `preload`; the echo round trip updated the DOM.
- `node:sqlite` (3.54.0) worked in the main process.
- The webview's `console.log` lines arrived in the terminal as `[webview:1] [console.log] …`.
- `Utils.quit(0)` ended the app and `hutch` returned 0 with no process left behind.

## Upstream seams the Mac app plugs into

| Seam | Contract | Mac implementation |
| --- | --- | --- |
| Reaching a server | chord `webSocketLink(socket)` takes a structural `WebSocketLike` (`dist/link.d.ts:84-92`), so the webview's own `WebSocket` qualifies; the server stamps every authorized connection `{ kind: 'owner' }` (`apps/mobile/server/listen.ts`). | The webview connects with the `Authorization: Bearer <secret>` header… which browsers cannot set on a WebSocket; see piece 2 for the chosen form. |
| The client's secret on a machine | `~/.infinichat/clients/<client ID>` (`listen.ts`, `authorized`), written by the install. | For this Mac, written locally through `NodeExecutionEnv`; for others, through pi-env's `RemoteExecutionEnv`, as the phone does. |
| Reaching another machine's loopback | pi-env `sshArguments` (`dist/ssh.js:43-73`) sets `-T -a -x`, `ClearAllForwardings=yes`, `ControlMaster=no`, and runs one command per process (`:90-91`); `Connection` (`dist/connection.d.ts`) carries requests, exec events and files, no socket. The phone's link doesn't use its ExecutionEnv either: `phone-dialer.ts:71` opens a second SSH connection and `:85-98` `forwardLocal`. | An `ssh -W 127.0.0.1:<port>` child built with `sshArguments(target, false, knownHostsFile)`, its stdio handed to `ws` (`createConnection`); `-L` to a free port as the fallback. |
| Host keys | pi-env `StrictHostKeyChecking=accept-new` when `strictHostKeys` is false (`ssh.js:67`); `HostKeyChangedError` (`:113-114`). | Same policy as the phone's `hosts.ts` (trust on first use; only a changed key asks). |
| Install and move | docs/infinichat-package pieces 4 and 7 "As built". | Unchanged package code with the Node implementations in `packages/infinichat/src/node`. |
