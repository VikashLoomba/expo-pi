import { KeyRoundIcon, MessageSquareIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';

import type { ChatSummaryRecord } from '../../../contract';
import type { ChatsRef } from '../../hooks/use-chats';
import { useMember } from '../../hooks/use-ref';
import { useOpenSettings } from '../../lib/app-context';
import { Alert, AlertAction, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from '../ui/context-menu';
import {
  SidebarGroup, SidebarGroupAction, SidebarGroupContent, SidebarGroupLabel, SidebarInput, SidebarMenu,
  SidebarMenuButton, SidebarMenuItem,
} from '../ui/sidebar';

/** Rename or Delete, chosen for a chat in a menu; the window shows the dialog. */
export type ChatAction = { kind: 'rename' | 'delete'; chat: ChatSummaryRecord };

/** The phone's chats list footer: where to connect a provider before the first message. */
function ConnectCard() {
  const openSettings = useOpenSettings();
  return (
    <Card size="sm" className="mx-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5"><KeyRoundIcon className="size-3.5" />Connect a provider</CardTitle>
        <CardDescription>Use ChatGPT or an API key to send messages. Your chats stay on this Mac.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button type="button" variant="outline" size="xs" onClick={openSettings}>Open Settings…</Button>
      </CardContent>
    </Card>
  );
}

/**
 * The chats in the sidebar, as the phone's chats list: search once there are chats, each row opening its chat with
 * Rename, Model Settings and Delete in its context menu, New Chat from the group's action and ⌘N, and the Connect a
 * provider card while no provider can send.
 */
export function ChatsGroup({ chats: api, selected, connected, notice, onDismissNotice, onSelect, onCreate, onAction,
  onSettings }: {
  chats: ChatsRef; selected: string | undefined; connected: boolean;
  /** What the last New Chat ran into. */
  notice: string | undefined; onDismissNotice: () => void;
  onSelect: (id: string) => void; onCreate: () => void; onAction: (action: ChatAction) => void;
  onSettings: (id: string) => void;
}) {
  const chats = useMember(api.chats);
  const error = useMember(api.report);
  const [search, setSearch] = useState('');
  const query = search.trim().toLocaleLowerCase();
  const visible = (chats ?? []).filter((chat) =>
    !query || `${chat.title} ${chat.preview}`.toLocaleLowerCase().includes(query));
  const empty = chats === undefined || chats === null ? 'Opening your chats…'
    : chats.length === 0 ? 'No chats yet.' : query && visible.length === 0 ? 'No chats match.' : undefined;
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Chats</SidebarGroupLabel>
      <SidebarGroupAction title="New Chat" aria-label="New Chat" disabled={!chats} onClick={onCreate}>
        <PlusIcon />
      </SidebarGroupAction>
      <SidebarGroupContent className="flex flex-col gap-2">
        {chats && chats.length > 0 && (
          <SidebarInput value={search} placeholder="Search chats" aria-label="Search chats"
            onChange={(event) => setSearch(event.target.value)} />
        )}
        {(notice ?? error) && (
          <Alert variant="destructive">
            <AlertDescription>{notice ?? error}</AlertDescription>
            <AlertAction>
              <Button type="button" variant="link" size="xs"
                onClick={notice ? onDismissNotice : () => { void api.dismissError(); }}>Dismiss</Button>
            </AlertAction>
          </Alert>
        )}
        {empty && <p className="px-2 text-xs text-muted-foreground">{empty}</p>}
        <SidebarMenu>
          {visible.map((chat) => {
            const id = String(chat.id);
            return (
              <ContextMenu key={id}>
                <ContextMenuTrigger render={<SidebarMenuItem />}>
                  <SidebarMenuButton isActive={selected === id} title={chat.preview} onClick={() => onSelect(id)}>
                    <MessageSquareIcon />
                    <span className="truncate">{chat.title}</span>
                  </SidebarMenuButton>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => onAction({ kind: 'rename', chat })}>Rename…</ContextMenuItem>
                  <ContextMenuItem onClick={() => onSettings(id)}>Model Settings…</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onClick={() => onAction({ kind: 'delete', chat })}>
                    Delete…
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </SidebarMenu>
        {chats && !connected && <ConnectCard />}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
