import type { Host } from '@earendil-works/chord';
import { INFINICHAT_COMMANDS, type ChatCommand } from '@pi-agent/infinichat/chat/commands';
import type { InstallStage } from '@pi-agent/infinichat/pi/infinichat-remote/dialer';
import { getModelSettingsError } from '@pi-agent/infinichat/pi/model-catalog';
import type { ProviderAccess } from '@pi-agent/infinichat/pi/provider-credentials';
import { userInput } from '@pi-agent/infinichat/pi/user-input';
import { useCallback, useMemo, useState } from 'react';

import { CheckIcon, ChevronDownIcon, ClockIcon, PlusIcon, ServerIcon, SettingsIcon, XIcon } from 'lucide-react';

import type { MacPrincipal, MoveStatus } from '../../contract';
import { ChatAgentContext } from '../components/chat/agent';
import { Composer } from '../components/chat/composer';
import { Notice } from '../components/chat/notices';
import { Placeholder } from '../components/chat/placeholder';
import { ThreadSourceContext } from '../components/chat/thread-source';
import { Transcript } from '../components/chat/transcript';
import { useSheet } from '../components/infinichat/form-sheet';
import { ProvidersSheet } from '../components/infinichat/providers-sheet';
import { ScheduledSheet } from '../components/infinichat/scheduled-sheet';
import { SettingsSheet } from '../components/infinichat/settings-sheet';
import { Button } from '../components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { useDraft } from '../hooks/use-draft';
import { InfiniChatContext, useHeldInfiniChat, useInfiniChatRef } from '../hooks/use-infinichat';
import { errorText, useMember } from '../hooks/use-ref';
import { useOpenSettings } from '../lib/app-context';

const TITLE = 'InfiniChat';
const MODELS_REQUIRED = 'Choose InfiniChat’s main and summary models in its settings to send a message.';
const NOT_READY: ProviderAccess = { ready: false, connected: false };

const connecting = (machine: string, stage: InstallStage | undefined) => stage === 'installing'
  ? `Installing InfiniChat on ${machine}…`
  : stage === 'starting' ? `Starting InfiniChat on ${machine}…` : `Connecting to ${machine}…`;
const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(1);

/** The step of a move, as the header's subtitle says it (the phone's `moving`), between machines only here. */
function moving(move: MoveStatus, machine: string, stage: InstallStage | undefined, from: string): string {
  if (move.undoing) return move.error === undefined ? 'Cancelling the move…' : 'Couldn’t cancel the move';
  if (move.error !== undefined) return `Can’t move to ${machine}`;
  const copied = move.copied ? ` · ${megabytes(move.copied.bytes)} of ${megabytes(move.copied.total)} MB` : '';
  return move.step === 'connecting' ? connecting(machine, stage)
    : move.step === 'closing' ? `Closing on ${from}…`
      : move.step === 'copying' ? `Copying from ${from} to ${machine}${copied}` : `Opening on ${machine}…`;
}

/** InfiniChat's one conversation: holds the window's reference and shows it, as the thread's source too. */
export function InfiniChatScreen({ host }: { host: Host<MacPrincipal> }) {
  const ref = useHeldInfiniChat(host);
  return (
    <InfiniChatContext value={ref}>
      <ThreadSourceContext value={ref}>
        <InfiniChat />
      </ThreadSourceContext>
    </InfiniChatContext>
  );
}

/**
 * The screen as the phone's `(infinichat)/index.tsx`: the header, the transcript, what stands in the way, and the
 * composer whose draft it owns. The transcript subscribes to the messages itself and is memoized, so a keystroke
 * renders only this component and the composer.
 */
function InfiniChat() {
  const ref = useInfiniChatRef();
  const snapshot = useMember(ref.snapshot);
  const controls = useMember(ref.controls);
  const connection = useMember(ref.connection);
  const held = useMember(ref.held);
  const machine = useMember(ref.machine);
  const listed = useMember(ref.machines);
  const move = useMember(ref.move) ?? undefined;
  const moveNotice = useMember(ref.moveNotice) ?? undefined;
  const avatar = useMember(ref.avatar) ?? undefined;
  const catalog = useMember(ref.catalog);
  const accesses = useMember(ref.access);
  const openSettings = useOpenSettings();
  const openMachines = () => openSettings({ pane: 'machines' });
  const settingsSheet = useSheet();
  const providersSheet = useSheet();
  const scheduledSheet = useSheet();
  const [focusProvider, setFocusProvider] = useState<string>();
  const { draft, changeDraft, removeImage, choosePrompt, attach, attachFiles, attaching, localError, setLocalError,
    reset, input } = useDraft(ref);
  const [admitting, setAdmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  /** What the last command the composer ran said, until dismissed. */
  const [commandResult, setCommandResult] = useState<{ text: string; failed: boolean }>();
  const name = controls?.name || TITLE;
  const agent = useMemo(() => ({ name, avatar }), [name, avatar]);
  const busy = !!controls?.busy;
  const configured = !!controls?.configured;
  const machineName = machine?.name ?? 'this Mac';
  // The models and sign-ins are the shown machine's, as on the phone; the main model's provider must be connected.
  const providerId = controls?.settings.model.provider;
  const access = (providerId !== undefined && accesses?.[providerId]) || NOT_READY;
  const settingsError = controls && configured && catalog ? getModelSettingsError(catalog, controls.settings)
    : undefined;
  const connected = !configured || access.connected;
  const providerLabel = catalog?.find((entry) => entry.id === providerId)?.name || providerId || 'your provider';
  const showProviders = providersSheet.show;
  const openProviders = useCallback((provider?: string) => {
    setFocusProvider(provider);
    showProviders();
  }, [showProviders]);

  const send = useCallback(() => {
    const text = draft.text.trim();
    if ((!text && !draft.images.length) || admitting || !configured || !connected || settingsError) return;
    setAdmitting(true);
    setLocalError(undefined);
    void ref.accept({ content: userInput(text, draft.images), requestId: draft.requestId }).then(reset,
      (cause: unknown) => { setLocalError(errorText(cause, 'Your message could not be sent. Try again.')); },
    ).finally(() => setAdmitting(false));
  }, [admitting, configured, connected, draft, ref, reset, setLocalError, settingsError]);
  // Commands run here, never reaching the agent; a failed one keeps its draft, so sending it again retries.
  const runCommand = useCallback((command: ChatCommand) => {
    if (admitting || command.name !== 'reload-plugins') return;
    setAdmitting(true);
    setCommandResult(undefined);
    void ref.reloadPlugins().then((text) => {
      setCommandResult({ text, failed: false });
      reset();
    }, (cause: unknown) => {
      setCommandResult({ text: errorText(cause, 'The plugins could not be reloaded. Try again.'), failed: true });
    }).finally(() => setAdmitting(false));
  }, [admitting, ref, reset]);
  const stop = useCallback(() => {
    if (stopping) return;
    setStopping(true);
    setLocalError(undefined);
    void ref.stop().catch((cause: unknown) => {
      setLocalError(errorText(cause, 'Something went wrong. Please try again.'));
    }).finally(() => setStopping(false));
  }, [ref, setLocalError, stopping]);

  const connectionError = connection?.status === 'failed' ? connection.error : undefined;
  const messageError = localError || connectionError || controls?.error || snapshot?.report || snapshot?.view.error;
  const retry = connectionError && (!localError || localError === connectionError) ? () => {
    setLocalError(undefined);
    void ref.reconnect();
  } : undefined;
  const dismiss = localError ? () => setLocalError(undefined)
    : connectionError || controls?.error ? undefined
      : snapshot?.report ? () => { void ref.dismissError(); } : undefined;
  const nameOf = (endpoint: string) => listed?.machines[endpoint]?.name ?? (endpoint === machine?.id ? machineName
    : 'the machine');
  // The checkmark is on where the conversation is going during a move, back where it was during a Cancel, and where
  // it lives otherwise.
  const chosen = move ? (!move.undoing ? move.machineId : move.from ?? null) : machine?.id ?? null;
  const subtitle = move ? moving(move, nameOf(move.machineId), connection?.status === 'connecting'
    ? connection.stage : undefined, move.from === undefined ? machineName : nameOf(move.from))
    : connection?.status === 'failed' ? `Can’t connect to ${machineName}`
      : connection?.status === 'connecting' ? connecting(machineName, connection.stage)
        : `${machineName}${busy ? ' · Working…' : ''}`;
  // The server holds the conversation open only while it is here; its cell says where it went otherwise.
  const away = !move && held !== null && held !== undefined && !held.active
    ? held.heldBy ? `InfiniChat is on ${held.heldBy.name}.`
      : `InfiniChat isn’t on ${machineName} yet. Move it here from your iPhone.` : undefined;
  const machines = Object.entries(listed?.machines ?? {}).sort(([, a], [, b]) => a.name.localeCompare(b.name));
  return (
    <ChatAgentContext value={agent}>
      <div className="flex h-full min-h-0 min-w-0 flex-col">
        <header className="toolbar grid grid-cols-[1fr_auto_1fr] items-center border-b px-3">
          <Button type="button" variant="ghost" size="sm" disabled={!controls} onClick={settingsSheet.show}
            aria-label={`${name} settings. ${subtitle}`}
            className="col-start-2 h-auto min-w-0 flex-col gap-0 px-3 py-1 [-webkit-app-region:no-drag]
              [app-region:no-drag]">
            <span className="font-semibold">{name}</span>
            <span className="flex items-center gap-1 text-[11px] font-normal text-muted-foreground">
              {subtitle}<ChevronDownIcon className="size-3" />
            </span>
          </Button>
          <div className="col-start-3 flex gap-1 justify-self-end [-webkit-app-region:no-drag] [app-region:no-drag]">
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Scheduled tasks"
                onClick={scheduledSheet.show} />}>
                <ClockIcon />
              </TooltipTrigger>
              <TooltipContent>Scheduled tasks</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm"
                aria-label={`InfiniChat runs on ${machineName}`} />}>
                <ServerIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {machines.map(([endpoint, record]) => (
                  <DropdownMenuItem key={endpoint} disabled={!!move || endpoint === chosen}
                    onClick={() => { void ref.chooseMove({ machineId: endpoint }); }}>
                    {endpoint === chosen ? <CheckIcon /> : <span className="size-4" />}
                    {record.name}
                  </DropdownMenuItem>
                ))}
                {machines.length === 0 && <DropdownMenuItem disabled>No machines yet</DropdownMenuItem>}
                {move?.cancellable && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => { void ref.cancelMove(); }}>
                      <XIcon />Cancel Move
                    </DropdownMenuItem>
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={openMachines}><PlusIcon />Add Machine…</DropdownMenuItem>
                <DropdownMenuItem onClick={openMachines}><SettingsIcon />Manage Machines…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        {away ? <Placeholder>{away}</Placeholder> : <Transcript stopping={stopping} onChoose={choosePrompt} />}
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-2 px-6 pb-6">
        {controls && !configured && (
          <Notice tone="neutral" message={MODELS_REQUIRED} action="Settings" onAction={settingsSheet.show} />
        )}
        {settingsError !== undefined && (
          <Notice message={settingsError} action="Settings" onAction={settingsSheet.show} />
        )}
        {configured && settingsError === undefined && access.ready && !access.connected && !away && (
          <Notice tone={access.error === undefined ? 'neutral' : 'error'}
            message={access.error ?? `Connect ${providerLabel} on ${machineName} to send a message`}
            action="Providers" onAction={() => openProviders(providerId)} />
        )}
        {move?.error !== undefined && !messageError && (
          <Notice message={move.error} action="Try Again" onAction={() => { void ref.retryMove(); }} />
        )}
        {messageError && (
          <Notice message={messageError} action={retry ? 'Try Again' : dismiss ? 'Dismiss' : undefined}
            onAction={retry ?? dismiss} />
        )}
        {moveNotice && !messageError && (
          <Notice tone="neutral" message={moveNotice} action="Dismiss"
            onAction={() => { void ref.dismissMoveNotice(); }} />
        )}
        {connection?.notice && !moveNotice && !messageError && (
          <Notice tone="neutral" message={connection.notice} action="Dismiss"
            onAction={() => { void ref.dismissNotice(); }} />
        )}
        {commandResult && (
          <Notice tone={commandResult.failed ? 'error' : 'neutral'} message={commandResult.text} action="Dismiss"
            onAction={() => setCommandResult(undefined)} />
        )}
        <Composer value={draft.text} onChange={changeDraft} onSend={send} onStop={stop} busy={busy}
          admitting={admitting} disabled={!controls || stopping || !!away || !!move
            || (!busy && (!configured || !connected || settingsError !== undefined))}
          inputRef={input}
          attachments={draft.images} onAttach={attach} onFiles={attachFiles} onRemoveAttachment={removeImage}
          attaching={attaching} imagesSupported={configured} commands={INFINICHAT_COMMANDS} onCommand={runCommand} />
        </div>
        <SettingsSheet key={settingsSheet.session} open={settingsSheet.open} onClose={settingsSheet.hide}
          onOpenProviders={openProviders} />
        <ProvidersSheet key={providersSheet.session} open={providersSheet.open} onClose={providersSheet.hide}
          focus={focusProvider} />
        <ScheduledSheet key={scheduledSheet.session} open={scheduledSheet.open} onClose={scheduledSheet.hide} />
      </div>
    </ChatAgentContext>
  );
}
