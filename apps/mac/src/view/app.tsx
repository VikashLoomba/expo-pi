import type { Host } from '@earendil-works/chord';
import { InfinityIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { MacApp, type MacPrincipal } from '../contract';
import { ChatActionDialogs } from './components/chat/chat-actions';
import { ChatsGroup, type ChatAction } from './components/chat/chats-sidebar';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarInset,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider,
} from './components/ui/sidebar';
import { TooltipProvider } from './components/ui/tooltip';
import { AccountContext, useHeldAccount, useHeldChats } from './hooks/use-chats';
import { errorText, useMember, useStatus } from './hooks/use-ref';
import { AppContext } from './lib/app-context';
import type { Commands } from './lib/commands';
import { ChatScreen } from './screens/chat';
import { InfiniChatScreen } from './screens/infinichat';

/** What the detail pane shows: InfiniChat, or one of this Mac's chats by its ID. */
type Selection = { kind: 'infinichat' } | { kind: 'chat'; id: string };
const INFINICHAT: Selection = { kind: 'infinichat' };

/**
 * The window: InfiniChat and this Mac's chats in shadcn's sidebar and the one selected beside it, under the
 * traffic-light toolbar. The sidebar owns the selection, the chat menus' dialogs and which chat's settings sheet is
 * open; New Chat comes from the sidebar's action and the File menu's ⌘N.
 */
export function App({ host, commands }: { host: Host<MacPrincipal>; commands: Commands }) {
  const [app] = useState(() => host.hold(MacApp, {}));
  useEffect(() => () => app.release(), [app]);
  const chats = useHeldChats(host);
  const account = useHeldAccount(host);
  const [selected, setSelected] = useState<Selection>(INFINICHAT);
  const [action, setAction] = useState<ChatAction>();
  const [settingsFor, setSettingsFor] = useState<string>();
  const [createError, setCreateError] = useState<string>();
  const status = useStatus(app);
  const about = useMember(app.about);
  const list = useMember(chats.chats);
  const access = useMember(account.access);
  // No card until the access states are known; then one while no provider can send.
  const connected = access === undefined || Object.values(access).some((provider) => provider.connected);
  const chatId = selected.kind === 'chat' ? selected.id : undefined;
  const showInfiniChat = useCallback(() => setSelected(INFINICHAT), []);
  const create = useCallback(() => {
    setCreateError(undefined);
    void chats.createChat().then(({ id }) => setSelected({ kind: 'chat', id }), (cause: unknown) => {
      setCreateError(errorText(cause, 'Could not create a chat.'));
    });
  }, [chats]);
  useEffect(() => commands.subscribe((name) => {
    if (name === 'new-chat') create();
  }), [commands, create]);
  const act = (kind: ChatAction['kind']) => {
    const chat = list?.find((entry) => String(entry.id) === chatId);
    if (chat) setAction({ kind, chat });
  };
  return (
    <AppContext value={app}>
    <AccountContext value={account}>
    <TooltipProvider>
      <SidebarProvider className="window">
        <Sidebar collapsible="none" className="h-full">
          <SidebarHeader className="toolbar" />
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton isActive={selected.kind === 'infinichat'} onClick={showInfiniChat}>
                      <InfinityIcon />
                      <span>InfiniChat</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <ChatsGroup chats={chats} selected={chatId} connected={connected} notice={createError}
              onDismissNotice={() => setCreateError(undefined)} onSelect={(id) => setSelected({ kind: 'chat', id })}
              onCreate={create} onAction={setAction} onSettings={(id) => {
                setSelected({ kind: 'chat', id });
                setSettingsFor(id);
              }} />
          </SidebarContent>
          <SidebarFooter className="text-xs text-muted-foreground">
            {about === undefined ? status : `InfiniChat ${about.version}`}
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="detail">
          {chatId === undefined
            ? <InfiniChatScreen host={host} />
            : <ChatScreen key={chatId} host={host} id={chatId} settingsOpen={settingsFor === chatId}
              onSettingsOpenChange={(open) => setSettingsFor(open ? chatId : undefined)}
              onRename={() => act('rename')} onDelete={() => act('delete')}
              onDeleted={showInfiniChat} />}
        </SidebarInset>
      </SidebarProvider>
      <ChatActionDialogs chats={chats} action={action} onClose={() => setAction(undefined)} />
    </TooltipProvider>
    </AccountContext>
    </AppContext>
  );
}
