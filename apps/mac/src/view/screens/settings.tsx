import type { Host } from '@earendil-works/chord';
import { KeyRoundIcon, ServerIcon } from 'lucide-react';

import type { MacPrincipal } from '../../contract';
import { MachinesPane } from '../components/settings/machines';
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarInset, SidebarMenu, SidebarMenuButton,
  SidebarMenuItem, SidebarProvider,
} from '../components/ui/sidebar';
import { TooltipProvider } from '../components/ui/tooltip';
import { useHeldMachines } from '../hooks/use-machines';

/** The Settings window: its panes in a sidebar, Machines first; Providers comes with piece 8. */
export function SettingsWindow({ host }: { host: Host<MacPrincipal> }) {
  const machines = useHeldMachines(host);
  return (
    <TooltipProvider>
      <SidebarProvider className="window">
        {/* Narrower than the main window's: the width is read from the nearest definition, this element's. */}
        <Sidebar collapsible="none" className="h-full [--sidebar-width:12rem]">
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton isActive><ServerIcon /><span>Machines</span></SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton disabled><KeyRoundIcon /><span>Providers</span></SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
        <SidebarInset className="pane">
          <MachinesPane machines={machines} />
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
