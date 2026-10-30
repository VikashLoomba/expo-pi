import type { Host } from '@earendil-works/chord';
import { KeyRoundIcon, ServerIcon } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { MacApp, type MacPrincipal } from '../../contract';
import { MachinesPane } from '../components/settings/machines';
import { ProvidersPane } from '../components/settings/providers';
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarInset, SidebarMenu, SidebarMenuButton,
  SidebarMenuItem, SidebarProvider,
} from '../components/ui/sidebar';
import { TooltipProvider } from '../components/ui/tooltip';
import { useHeldAccount } from '../hooks/use-chats';
import { useHeldMachines } from '../hooks/use-machines';
import { AppContext } from '../lib/app-context';
import type { SettingsTargets } from '../lib/commands';

/** The Settings window: its panes in a sidebar, the one `targets` names shown, Machines by default. */
export function SettingsWindow({ host, targets }: { host: Host<MacPrincipal>; targets: SettingsTargets }) {
  // The app, for the sign-in rows' Open in browser.
  const [app] = useState(() => host.hold(MacApp, {}));
  useEffect(() => () => app.release(), [app]);
  const machines = useHeldMachines(host);
  const account = useHeldAccount(host);
  const target = useSyncExternalStore(targets.subscribe, targets.getSnapshot);
  return (
    <AppContext value={app}>
    <TooltipProvider>
      <SidebarProvider className="window">
        {/* Narrower than the main window's: the width is read from the nearest definition, this element's. */}
        <Sidebar collapsible="none" className="h-full [--sidebar-width:12rem]">
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton isActive={target.pane === 'machines'}
                      onClick={() => targets.show({ pane: 'machines' })}>
                      <ServerIcon /><span>Machines</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton isActive={target.pane === 'providers'}
                      onClick={() => targets.show({ pane: 'providers' })}>
                      <KeyRoundIcon /><span>Providers</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
        <SidebarInset className="pane">
          {target.pane === 'providers'
            ? <ProvidersPane account={account} focus={target.provider} />
            : <MachinesPane machines={machines} />}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
    </AppContext>
  );
}
