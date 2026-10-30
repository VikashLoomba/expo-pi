import type { Host } from '@earendil-works/chord';
import { findCatalogModel, getModelSettingsError, type ModelCatalog } from '@pi-agent/infinichat/pi/model-catalog';
import type { ProviderAccess } from '@pi-agent/infinichat/pi/provider-credentials';
import { userInput } from '@pi-agent/infinichat/pi/user-input';
import { EllipsisIcon, PencilIcon, SlidersHorizontalIcon, Trash2Icon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MacPrincipal } from '../../contract';
import { ChatSettingsSheet, thinkingLevelLabel } from '../components/chat/chat-settings';
import { Composer } from '../components/chat/composer';
import { Notice } from '../components/chat/notices';
import { ThreadSourceContext, type ThreadSource } from '../components/chat/thread-source';
import { Transcript } from '../components/chat/transcript';
import { Button } from '../components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { useAccountRef, useHeldChat, type ChatRef } from '../hooks/use-chats';
import { useDraft } from '../hooks/use-draft';
import { errorText, useMember } from '../hooks/use-ref';
import { providersPane, useOpenSettings } from '../lib/app-context';

const NO_CATALOG: ModelCatalog = [];
const NO_ACCESS: ProviderAccess = { ready: false, connected: false };
const PARKED = 'Pi paused this chat’s work because the app quit while it was running several times in a row.';

interface ChatScreenProps {
  host: Host<MacPrincipal>;
  id: string;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  onRename: () => void;
  onDelete: () => void;
  /** The shown chat was deleted; the window shows something else, as the phone goes back to its list. */
  onDeleted: () => void;
}

/** One of this Mac's chats: holds the window's reference and shows it as the thread's source. */
export function ChatScreen({ host, id, ...props }: ChatScreenProps) {
  const ref = useHeldChat(host, id);
  const source = useMemo((): ThreadSource => ({
    snapshot: ref.snapshot, controls: ref.controls, messages: ref.messages,
    steerQueued: (submissionId, content) => ref.steer({ submissionId, content }),
  }), [ref]);
  return (
    <ThreadSourceContext value={source}>
      <Chat host={host} chat={ref} {...props} />
    </ThreadSourceContext>
  );
}

/**
 * The screen as the phone's `chats/chat/[id].tsx`: the header with the model summary and the chat's menu, the
 * transcript, what stands in the way (settings, a parked task, an error, a provider to connect), the composer whose
 * draft it owns, and the settings sheet.
 */
function Chat({ host, chat: ref, settingsOpen, onSettingsOpenChange, onRename, onDelete, onDeleted }:
  Omit<ChatScreenProps, 'id'> & { chat: ChatRef }) {
  const account = useAccountRef();
  const catalog = useMember(account.catalog) ?? NO_CATALOG;
  const accesses = useMember(account.access);
  const controls = useMember(ref.controls) ?? undefined;
  const status = useMember(ref.snapshot)?.view.status;
  // A shown chat goes missing only when Delete deletes it (the phone's `[id].tsx`).
  const shown = useRef(false);
  useEffect(() => {
    if (status === 'ready') shown.current = true;
    else if (status === 'missing' && shown.current) onDeleted();
  }, [onDeleted, status]);
  const openSettings = useOpenSettings();
  const { draft, changeDraft, removeImage, choosePrompt, attach, attachFiles, attaching, localError, setLocalError,
    reset, input } = useDraft(ref);
  const [admitting, setAdmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const busy = !!controls?.busy;
  const providerId = controls?.settings.model.provider;
  const provider = catalog.find((entry) => entry.id === providerId);
  const model = controls ? findCatalogModel(catalog, controls.settings.model) : undefined;
  const access = (providerId !== undefined ? accesses?.[providerId] : undefined) ?? NO_ACCESS;
  const settingsError = controls ? getModelSettingsError(catalog, controls.settings) : undefined;
  const title = controls?.title || 'New chat';
  const settingsLabel = controls
    ? `${provider?.name || providerId} · ${model?.name || controls.settings.model.modelId} · `
      + thinkingLevelLabel(controls.settings.thinkingLevel)
    : 'Loading settings…';

  const send = useCallback(() => {
    const text = draft.text.trim();
    if ((!text && !draft.images.length) || admitting || !access.connected || settingsError) return;
    if (draft.images.length && !model?.images) {
      setLocalError(`${model?.name || 'This model'} does not accept images. Remove the photos or choose another model.`);
      return;
    }
    setAdmitting(true);
    setLocalError(undefined);
    void ref.send({ content: userInput(text, draft.images), requestId: draft.requestId }).then(reset,
      (cause: unknown) => { setLocalError(errorText(cause, 'Your message could not be sent. Try again.')); },
    ).finally(() => setAdmitting(false));
  }, [access.connected, admitting, draft, model, ref, reset, setLocalError, settingsError]);
  const stop = useCallback(() => {
    if (stopping) return;
    setStopping(true);
    setLocalError(undefined);
    void ref.cancel().catch((cause: unknown) => {
      setLocalError(errorText(cause, 'Something went wrong. Please try again.'));
    }).finally(() => setStopping(false));
  }, [ref, setLocalError, stopping]);
  const resume = () => {
    setLocalError(undefined);
    void ref.retryParked().catch((cause: unknown) => {
      setLocalError(errorText(cause, 'The work could not resume. Try again.'));
    });
  };

  const messageError = localError || controls?.error || access.error;
  const accountStatus = !access.ready ? 'Restoring your connection…'
    : `Connect ${provider?.name || providerId || 'your provider'} to send a message.`;
  const openProviders = () => openSettings(providersPane(providerId));
  const openSheet = () => onSettingsOpenChange(true);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="toolbar grid grid-cols-[1fr_auto_1fr] items-center border-b px-3">
        <div className="col-start-2 flex min-w-0 flex-col items-center">
          <div className="max-w-md truncate font-semibold">{title}</div>
          <div className="max-w-md truncate text-[11px] text-muted-foreground">
            {busy ? `Working… · ${settingsLabel}` : settingsLabel}
          </div>
        </div>
        <div className="col-start-3 flex gap-1 justify-self-end [-webkit-app-region:no-drag] [app-region:no-drag]">
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Chat Settings"
              disabled={!controls} onClick={openSheet} />}>
              <SlidersHorizontalIcon />
            </TooltipTrigger>
            <TooltipContent>Chat Settings</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Chat options"
              disabled={!controls} />}>
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={openSheet}><SlidersHorizontalIcon />Model Settings…</DropdownMenuItem>
              <DropdownMenuItem onClick={onRename}><PencilIcon />Rename…</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}><Trash2Icon />Delete…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <Transcript stopping={stopping} onChoose={choosePrompt} />
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-2 px-6 pb-6">
        {settingsError && <Notice message={settingsError} action="Chat Settings" onAction={openSheet} />}
        {controls?.parked && <Notice tone="neutral" message={PARKED} action="Resume" onAction={resume} />}
        {messageError && messageError !== settingsError && (
          <Notice message={messageError} action={localError ? 'Dismiss' : access.error ? 'Open Settings' : undefined}
            onAction={localError ? () => setLocalError(undefined) : access.error ? openProviders : undefined} />
        )}
        {controls && !access.connected && !access.error && (
          <Notice tone="neutral" message={accountStatus} action={access.ready ? 'Open Settings' : undefined}
            onAction={openProviders} />
        )}
        <Composer value={draft.text} onChange={changeDraft} onSend={send} onStop={stop} busy={busy}
          admitting={admitting} inputRef={input}
          disabled={!controls || stopping || (!busy && (!access.connected || !!settingsError))}
          attachments={draft.images} onAttach={attach} onFiles={attachFiles} onRemoveAttachment={removeImage}
          attaching={attaching} imagesSupported={!!model?.images} />
      </div>
      {controls && (
        <ChatSettingsSheet host={host} chat={ref} controls={controls} open={settingsOpen}
          onOpenChange={onSettingsOpenChange} />
      )}
    </div>
  );
}
