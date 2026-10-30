import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { fileCredentialBackend } from '@pi-agent/infinichat/node/credentials';
import Electrobun, {
  ApplicationMenu, BrowserView, BrowserWindow, Updater, Utils, type ElectrobunEvent,
} from 'electrobun/main';

import type { SettingsTarget } from '../contract';
import type { WindowCommand, WindowRPC } from '../rpc';
import { MacAccount } from './account';
import { MacAvatar } from './avatar';
import { MacChats } from './chats';
import { macHome } from './home';
import { createMacHost } from './host';
import { macClient } from './identity';
import { openImages } from './images';
import { MacInfiniChat } from './infinichat';
import { listenForWindows } from './listen';
import { MacMachines, thisMac } from './machines';
import { ScheduledNotifier } from './notifications';
import { serveChats } from './serve-chats';
import { serveInfiniChat } from './serve-infinichat';
import { serveMachines } from './serve-machines';
import { readSettings, writeSettings } from './settings';
import { SignInRelay } from './sign-in-relay';

const INITIAL_FRAME = { width: 1100, height: 720 };
const SETTINGS_FRAME = { width: 780, height: 560 };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
/** The action a clicked menu item was given in `setApplicationMenu`; Electrobun types the event as unknown. */
const clickedAction = (event: unknown): string | undefined =>
  isRecord(event) && isRecord(event.data) && typeof event.data.action === 'string' ? event.data.action : undefined;
const isCommand = (action: string): action is WindowCommand => action === 'new-chat';
const windowRpc = () => BrowserView.defineRPC<WindowRPC>({ handlers: { requests: {}, messages: {} } });

interface OpenWindow {
  window: BrowserWindow;
  rpc: ReturnType<typeof windowRpc>;
  /** Keeps the window's frame for the next launch. */
  remember(): void;
}

function setMenu(): void {
  ApplicationMenu.setApplicationMenu([
    { label: 'InfiniChat', submenu: [
      { role: 'about' },
      { type: 'separator' },
      { label: 'Settings…', action: 'settings', accelerator: ',' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'showAll' },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    { label: 'File', submenu: [
      { label: 'New Chat', action: 'new-chat', accelerator: 'n' },
      { type: 'separator' },
      { role: 'close' },
    ] },
    { label: 'Edit', submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'delete' },
      { role: 'selectAll' },
    ] },
    { label: 'View', submenu: [{ role: 'toggleFullScreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ]);
}

/**
 * The app: its Chord host, where the windows reach it, one main window, the menu, and the Mac lifecycle: the app stays
 * open without a window, the Dock reopens one, and quitting closes the host before the process ends.
 */
async function main(): Promise<void> {
  const settings = readSettings();
  const { version } = await Updater.getLocalInfo();
  const userData = Utils.paths.userData;
  // Electrobun's path getters don't create the directory; everything below writes into it.
  mkdirSync(userData, { recursive: true });
  const client = await macClient(settings);
  // The app's secrets for the machines' servers and, later, its own provider credentials, as the server keeps them.
  const secrets = fileCredentialBackend(join(userData, 'credentials.json'));
  const mac = thisMac(client.name);
  // The composer's photos and, later, the chats' tools are prepared with it.
  const images = await openImages();
  const infinichat = new MacInfiniChat(macHome(mac.id), mac, client, secrets, images);
  // The other machines, reached from this Mac over pi-env; the conversation's document lists them.
  const machines = new MacMachines(infinichat.shown, client, secrets, mac, settings);
  infinichat.useMachines(machines);
  // This Mac's avatar file, the browser side of a sign-in on the holder, and the scheduled tasks' notifications.
  const avatar = new MacAvatar(settings);
  const relay = new SignInRelay(infinichat, (promptId, value) => infinichat.answer(promptId, value));
  const notifier = new ScheduledNotifier(infinichat.shown.scheduled);
  // This Mac's own providers and chats, whose tools run here in a folder per chat or on a machine. Its own sign-in
  // runs here too, so its browser opens here and pi-ai's flow catches the callback itself.
  const account = new MacAccount(secrets);
  const own = new SignInRelay({ subscribe: account.signIn.subscribe, getSignIn: account.signIn.getSnapshot });
  const chats = new MacChats(account, machines, images);
  // The Settings window opens from the menu and from the screens' notices; it exists once the windows listen.
  const ui = { openSettings: (_target?: SettingsTarget) => {} };
  const host = createMacHost({ version, userData }, ui);
  serveInfiniChat(host, infinichat, avatar);
  serveMachines(host, infinichat, machines);
  serveChats(host, chats, account, machines);
  const windows = await listenForWindows(host);
  console.log(`InfiniChat ${version}: data in ${userData}, windows on 127.0.0.1:${windows.port}`);

  let current: OpenWindow | undefined;
  const open = (): OpenWindow => {
    if (current) {
      current.window.activate();
      return current;
    }
    const rpc = windowRpc();
    const window = new BrowserWindow({
      title: 'InfiniChat',
      url: 'views://app/index.html',
      frame: settings.windowFrame ?? INITIAL_FRAME,
      titleBarStyle: 'hiddenInset',
      preload: `window.__mac = ${JSON.stringify({ port: windows.port, secret: windows.secret })};`,
      // The avatar is a file under the user data, which the page loads as `appdata://` (Electrobun "Paths").
      allowedProtocols: { views: true, appData: true },
      rpc,
    });
    const opened: OpenWindow = {
      window,
      rpc,
      remember: () => {
        settings.windowFrame = window.getFrame();
        writeSettings(settings);
      },
    };
    window.on('will-close', opened.remember);
    window.on('close', () => {
      if (current === opened) current = undefined;
    });
    current = opened;
    return opened;
  };

  // One Settings window, its own page over the same bundle (`settings.html`), reused while it is open. A target
  // pane reaches a new window with its bootstrap and an open one as a command.
  let settingsWindow: { window: BrowserWindow; rpc: ReturnType<typeof windowRpc> } | undefined;
  const openSettings = (target?: SettingsTarget) => {
    if (settingsWindow) {
      settingsWindow.window.activate();
      if (target !== undefined) settingsWindow.rpc.send.show(target);
      return;
    }
    const rpc = windowRpc();
    const bootstrap = {
      port: windows.port, secret: windows.secret, ...(target === undefined ? {} : { settings: target }),
    };
    const window = new BrowserWindow({
      title: 'Settings',
      url: 'views://app/settings.html',
      frame: SETTINGS_FRAME,
      preload: `window.__mac = ${JSON.stringify(bootstrap)};`,
      rpc,
    });
    window.on('close', () => {
      if (settingsWindow?.window === window) settingsWindow = undefined;
    });
    settingsWindow = { window, rpc };
  };
  ui.openSettings = openSettings;

  setMenu();
  ApplicationMenu.on('application-menu-clicked', (event) => {
    const action = clickedAction(event);
    if (action === 'settings') {
      openSettings();
      return;
    }
    if (action === undefined || !isCommand(action)) return;
    open().rpc.send.command({ name: action });
  });
  Electrobun.events.on('reopen', () => open());
  let quitting: Promise<void> | undefined;
  Electrobun.events.on('before-quit', (event: ElectrobunEvent<unknown, { allow: boolean }>) => {
    // The first ask is refused while the host closes; the quit that follows is allowed.
    if (quitting) return;
    event.response = { allow: false };
    current?.remember();
    quitting = (async () => {
      // The clients close first, then the host disposes its objects and closes the windows' links, then nothing
      // listens; every step runs, and the first failure is reported after the rest, as the phone's teardown does.
      let failure: unknown;
      for (const step of [async () => { relay.close(); own.close(); notifier.close(); }, () => infinichat.close(),
        () => chats.close(), async () => machines.close(), () => host.close(), async () => account.close(),
        () => windows.close()]) {
        try {
          await step();
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== undefined) throw failure;
    })().then(() => { Utils.quit(); }, (error: unknown) => {
      console.error(error);
      Utils.quit(1);
    });
  });
  open();
  infinichat.open();
  chats.open();
}

main().catch((error: unknown) => {
  console.error(error);
  Utils.quit(1);
});
