import type { Host } from '@earendil-works/chord';

import type { MacPrincipal } from '../../contract';
import { MachinesPane } from '../components/settings/machines';
import { useHeldMachines } from '../hooks/use-machines';

/** The Settings window: its panes in a source list, Machines first; Providers comes with piece 8. */
export function SettingsWindow({ host }: { host: Host<MacPrincipal> }) {
  const machines = useHeldMachines(host);
  return (
    <div className="settings">
      <nav className="settings-sources">
        <button type="button" className="row-button selected">Machines</button>
        <button type="button" className="row-button" disabled>Providers</button>
      </nav>
      <section className="pane">
        <MachinesPane machines={machines} />
      </section>
    </div>
  );
}
