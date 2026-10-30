import { Electroview } from 'electrobun/view';
import { createRoot } from 'react-dom/client';

import type { SettingsTarget } from '../contract';
import type { WindowRPC } from '../rpc';
import { App } from './app';
import { connectToMain } from './lib/client';
import { createCommands, createSettingsTargets } from './lib/commands';
import { SettingsWindow } from './screens/settings';

declare global {
  interface Window {
    /**
     * Where this launch's main process listens and the secret that admits this window, preloaded by it; for the
     * Settings window, the pane it was opened for.
     */
    __mac?: { port: number; secret: string; settings?: SettingsTarget };
  }
}

const bootstrap = window.__mac;
if (bootstrap === undefined) throw new Error('This page is only served by the InfiniChat app.');
const container = document.getElementById('app');
if (container === null) throw new Error('The page has no #app element.');

const commands = createCommands();
const targets = createSettingsTargets(bootstrap.settings);
const rpc = Electroview.defineRPC<WindowRPC>({
  handlers: { requests: {}, messages: {
    command: ({ name }) => commands.dispatch(name), show: (target) => targets.show(target),
  } },
});
new Electroview({ rpc });
const host = connectToMain(bootstrap);
// Which window this page is: the main one, or Settings (`settings.html` says so on its body).
createRoot(container).render(document.body.dataset.window === 'settings'
  ? <SettingsWindow host={host} targets={targets} /> : <App host={host} commands={commands} />);
