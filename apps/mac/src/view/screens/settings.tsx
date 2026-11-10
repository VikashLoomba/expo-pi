import { useHold } from '@earendil-works/chord/react';
import { KeyRoundIcon, ServerIcon } from 'lucide-react';
import { useSyncExternalStore } from 'react';

import { MacAccount, MacApp, MacMachines } from '../../contract';
import { MachinesPane } from '../components/settings/machines';
import { ProvidersPane } from '../components/settings/providers';
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarInset, SidebarMenu, SidebarMenuButton,
  SidebarMenuItem, SidebarProvider,
} from '../components/ui/sidebar';
import { TooltipProvider } from '../components/ui/tooltip';
import { AppContext } from '../lib/app-context';
import type { SettingsTargets } from '../lib/commands';

/**
 * The Settings window: its panes in a sidebar, the one `targets` names shown, Machines by default. It holds the
 * machines and this Mac's providers for its lifetime; a pane shows once its reference exists, the render after the
 * first.
 */
export function SettingsWindow({ targets }: { targets: SettingsTargets }) {
  // The app, for the sign-in rows' Open in browser.
  const app = useHold(MacApp, {});
  const machines = useHold(MacMachines, {});
  const account = useHold(MacAccount, {});
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
            ? account && <ProvidersPane account={account} focus={target.provider} />
            : machines && <MachinesPane machines={machines} />}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
    </AppContext>
  );
}
