import type { Host } from '@earendil-works/chord';
import { useEffect, useState } from 'react';

import { MacApp, type MacPrincipal } from '../contract';
import type { Commands } from './commands';
import { useMember, useStatus } from './use-ref';

/** The window: the conversations in a sidebar and the one shown beside it, under a toolbar the traffic lights share. */
export function App({ host, commands }: { host: Host<MacPrincipal>; commands: Commands }) {
  const [app] = useState(() => host.hold(MacApp, {}));
  useEffect(() => () => app.release(), [app]);
  // The screens that act on commands come with later pieces.
  useEffect(() => commands.subscribe((name) => console.log(`command: ${name}`)), [commands]);
  const status = useStatus(app);
  const about = useMember(app.about);
  return (
    <div className="window">
      <aside className="sidebar">
        <div className="toolbar" />
        <nav className="list">
          <button type="button" className="row selected">InfiniChat</button>
        </nav>
        <footer className="footer">{about === undefined ? status : `InfiniChat ${about.version}`}</footer>
      </aside>
      <main className="detail">
        <div className="toolbar" />
        <p className="placeholder">Select a conversation</p>
      </main>
    </div>
  );
}
