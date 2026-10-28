import Electrobun, {
  ApplicationMenu, BrowserView, BrowserWindow, Updater, Utils, type ElectrobunEvent,
} from 'electrobun/main';

import type { WindowCommand, WindowRPC } from '../rpc';
import { createMacHost } from './host';
import { openImages } from './images';
import { listenForWindows } from './listen';
import { readSettings, writeSettings } from './settings';

const INITIAL_FRAME = { width: 1100, height: 720 };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
/** The action a clicked menu item was given in `setApplicationMenu`; Electrobun types the event as unknown. */
const clickedAction = (event: unknown): string | undefined =>
  isRecord(event) && isRecord(event.data) && typeof event.data.action === 'string' ? event.data.action : undefined;
const isCommand = (action: string): action is WindowCommand => action === 'new-chat' || action === 'settings';
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
  const host = createMacHost({ version, userData });
  const windows = await listenForWindows(host);
  // The chats' tools and the composer prepare images with it (piece 7); opened here to prove the copied resource.
  await openImages();
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

  setMenu();
  ApplicationMenu.on('application-menu-clicked', (event) => {
    const action = clickedAction(event);
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
      // It disposes its objects and closes the windows' links; then nothing listens.
      await host.close();
      await windows.close();
    })().then(() => { Utils.quit(); }, (error: unknown) => {
      console.error(error);
      Utils.quit(1);
    });
  });
  open();
}

main().catch((error: unknown) => {
  console.error(error);
  Utils.quit(1);
});
