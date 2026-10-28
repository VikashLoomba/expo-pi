import { Electroview } from 'electrobun/view';
import { createRoot } from 'react-dom/client';

import type { WindowRPC } from '../rpc';
import { App } from './app';
import { connectToMain } from './lib/client';
import { createCommands } from './lib/commands';

declare global {
  interface Window {
    /** Where this launch's main process listens and the secret that admits this window, preloaded by it. */
    __mac?: { port: number; secret: string };
  }
}

const bootstrap = window.__mac;
if (bootstrap === undefined) throw new Error('This page is only served by the InfiniChat app.');
const container = document.getElementById('app');
if (container === null) throw new Error('The page has no #app element.');

const commands = createCommands();
const rpc = Electroview.defineRPC<WindowRPC>({
  handlers: { requests: {}, messages: { command: ({ name }) => commands.dispatch(name) } },
});
new Electroview({ rpc });
createRoot(container).render(<App host={connectToMain(bootstrap)} commands={commands} />);
