import type { Host } from '@earendil-works/chord';
import { useEffect, useState } from 'react';

import { MacApp, type MacPrincipal } from '../contract';
import { useMember, useStatus } from './hooks/use-ref';
import { AppContext } from './lib/app-context';
import type { Commands } from './lib/commands';
import { InfiniChatScreen } from './screens/infinichat';

/** The window: the conversations in a sidebar and the one shown beside it, under a toolbar the traffic lights share. */
export function App({ host, commands }: { host: Host<MacPrincipal>; commands: Commands }) {
  const [app] = useState(() => host.hold(MacApp, {}));
  useEffect(() => () => app.release(), [app]);
  // The screens that act on commands come with later pieces.
  useEffect(() => commands.subscribe((name) => console.log(`command: ${name}`)), [commands]);
  const status = useStatus(app);
  const about = useMember(app.about);
  return (
    <AppContext value={app}>
    <div className="window">
      <aside className="sidebar">
        <div className="toolbar" />
        <nav className="list">
          <button type="button" className="row-button selected">InfiniChat</button>
        </nav>
        <footer className="footer">{about === undefined ? status : `InfiniChat ${about.version}`}</footer>
      </aside>
      <main className="detail">
        <InfiniChatScreen host={host} />
      </main>
    </div>
    </AppContext>
  );
}
