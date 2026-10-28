import type { Host } from '@earendil-works/chord';
import { InfinityIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { MacApp, type MacPrincipal } from '../contract';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarInset,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider,
} from './components/ui/sidebar';
import { TooltipProvider } from './components/ui/tooltip';
import { useMember, useStatus } from './hooks/use-ref';
import { AppContext } from './lib/app-context';
import type { Commands } from './lib/commands';
import { InfiniChatScreen } from './screens/infinichat';

/** The window: the conversations in shadcn's sidebar and the one shown beside it, under the traffic-light toolbar. */
export function App({ host, commands }: { host: Host<MacPrincipal>; commands: Commands }) {
  const [app] = useState(() => host.hold(MacApp, {}));
  useEffect(() => () => app.release(), [app]);
  // The screens that act on commands come with later pieces.
  useEffect(() => commands.subscribe((name) => console.log(`command: ${name}`)), [commands]);
  const status = useStatus(app);
  const about = useMember(app.about);
  return (
    <AppContext value={app}>
    <TooltipProvider>
      <SidebarProvider className="window">
        <Sidebar collapsible="none" className="h-full">
          <SidebarHeader className="toolbar" />
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton isActive>
                      <InfinityIcon />
                      <span>InfiniChat</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter className="text-xs text-muted-foreground">
            {about === undefined ? status : `InfiniChat ${about.version}`}
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="detail">
          <InfiniChatScreen host={host} />
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
    </AppContext>
  );
}
