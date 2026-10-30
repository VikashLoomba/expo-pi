import { uuidv7 } from '@earendil-works/pi-ai';
import type { InstallStage } from '@pi-agent/infinichat/pi/infinichat-remote/dialer';
import type { MoveStatus } from '@pi-agent/infinichat/pi/infinichat-remote/move';
import { findCatalogModel, getModelSettingsError } from '@pi-agent/infinichat/pi/model-catalog';
import { userInput } from '@pi-agent/infinichat/pi/user-input';
import { router, Stack } from 'expo-router';
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PlatformColor, Pressable, StyleSheet, Text, View, type TextInputInstance } from 'react-native';

import {
  useChatApp, useChatControls, useInfiniChatAccount, useInfiniChatAvatar, useInfiniChatConnection, useInfiniChatError,
  useInfiniChatView, useMachines,
} from '@/chat/chat-provider';
import { pickPhotos, type PhotoAttachment, type PhotoSource } from '@/chat/photo-attachments';
import { ChatAgentContext } from '@/components/chat/agent';
import { Composer } from '@/components/chat/composer';
import { ChatIcon } from '@/components/chat/icon';
import { InlineNotice } from '@/components/chat/primitives';
import { thinkingLevelLabel } from '@/components/chat/settings-controls';
import { ChatTranscript } from '@/components/chat/transcript';
import { useChatColors } from '@/hooks/use-chat-colors';

const TITLE = 'InfiniChat';
const MODELS_REQUIRED = 'Choose InfiniChat’s main and summary models in its settings to send a message.';
const PHONE = 'This iPhone';

const connecting = (machine: string, stage: InstallStage | undefined) => stage === 'installing'
  ? `Installing InfiniChat on ${machine}…`
  : stage === 'starting' ? `Starting InfiniChat on ${machine}…` : `Connecting to ${machine}…`;
const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(1);

/**
 * The step of a move, as the header's subtitle says it; then the machine's name, once it's done. `stage` is what the
 * machine's install is doing while the move connects, and `from` the machine a move between machines leaves.
 */
function moving(move: MoveStatus, machine: string, stage: InstallStage | undefined, from?: string): string {
  if (move.undoing) return move.error === undefined ? 'Cancelling the move…' : 'Couldn’t cancel the move';
  if (move.error !== undefined) {
    return move.to === 'machine' ? `Can’t move to ${machine}` : `Can’t move from ${machine}`;
  }
  const copied = move.copied ? ` · ${megabytes(move.copied.bytes)} of ${megabytes(move.copied.total)} MB` : '';
  if (move.to === 'machine') {
    if (from !== undefined) {
      return move.step === 'connecting' ? connecting(machine, stage)
        : move.step === 'closing' ? `Closing on ${from}…`
          : move.step === 'copying' ? `Copying from ${from} to ${machine}…` : `Opening on ${machine}…`;
    }
    return move.step === 'connecting' ? connecting(machine, stage)
      : move.step === 'closing' ? 'Closing InfiniChat…'
        : move.step === 'copying' ? `Copying to ${machine}${copied}` : `Opening on ${machine}…`;
  }
  return move.step === 'closing' ? `Closing on ${machine}…`
    : move.step === 'copying' ? `Copying from ${machine}${copied}` : `Opening on ${PHONE}…`;
}

/** A draft keeps one request ID for every attempt to send it, so a resend after a failure is admitted once. */
type Draft = { text: string; images: readonly PhotoAttachment[]; requestId: string };
const emptyDraft = (): Draft => ({ text: '', images: [], requestId: uuidv7() });

/** InfiniChat's one conversation, as the chat screen shows a chat, sent through OptChat's acceptance. */
export default function InfiniChatScreen() {
  const colors = useChatColors();
  const {
    infiniChat: service, error: appError, dismissError, remoteHosts, infiniChatHome: home, infiniChatMove: move, moves,
    infiniChatMoveNotice: moveNotice,
  } = useChatApp();
  // While the screens show a machine's InfiniChat, its models and sign-ins are that machine's.
  const { catalog, providerAccess, machine: shown } = useInfiniChatAccount();
  const view = useInfiniChatView();
  const conversation = useChatControls(view);
  const avatar = useInfiniChatAvatar();
  const agentName = conversation?.name || TITLE;
  const agent = useMemo(() => ({ name: agentName, avatar }), [agentName, avatar]);
  const serviceError = useInfiniChatError();
  const connection = useInfiniChatConnection();
  const hosts = useSyncExternalStore(remoteHosts.subscribe, remoteHosts.getSnapshot, remoteHosts.getSnapshot);
  const listed = useMachines();
  const remote = shown !== undefined;
  // The machine the conversation is on or moving to or from, by the name the conversation's document gives it, or
  // its host name until that is read; a launch never shows a placeholder name first.
  const machineId = move?.machineId ?? (home.home === 'machine' ? home.machineId : null);
  const nameOf = (endpoint: string) =>
    listed?.machines[endpoint]?.name ?? hosts.hosts.find((host) => host.id === endpoint)?.hostname;
  const machine = machineId === null ? undefined : nameOf(machineId);
  // Without credentials here, this iPhone can't reach the machine the conversation is on.
  const removed = machineId !== null && hosts.ready && !hosts.hosts.some((host) => host.id === machineId);
  // The checkmark is on where the conversation is going during a move, back where it was during a Cancel, and where
  // it lives otherwise.
  const chosen = move ? ((move.to === 'machine') !== !!move.undoing ? move.machineId : move.from ?? null)
    : home.home === 'machine' && home.phase !== 'moving-back' ? home.machineId : null;
  const movingNow = move !== undefined || (home.home === 'machine' && home.phase !== 'there');
  const there = home.home === 'machine' && home.phase === 'there';
  const [draft, setDraft] = useState(emptyDraft);
  const changeDraft = useCallback((text: string) => {
    setDraft((current) => current.text === text ? current : { ...current, text, requestId: uuidv7() });
  }, []);
  const removeImage = useCallback((imageId: string) => {
    setDraft((current) => ({ ...current, images: current.images.filter((image) => image.id !== imageId),
      requestId: uuidv7() }));
  }, []);
  const [attaching, setAttaching] = useState(false);
  const [admitting, setAdmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const input = useRef<TextInputInstance>(null);
  const busy = !!conversation?.busy;
  const configured = !!conversation?.configured;
  const providerId = conversation?.settings.model.provider;
  const provider = catalog.find((entry) => entry.id === providerId);
  const model = conversation ? findCatalogModel(catalog, conversation.settings.model) : undefined;
  const access = providerAccess(providerId || '');
  const settingsError = conversation && configured ? getModelSettingsError(catalog, conversation.settings) : undefined;
  const settingsLabel = !conversation ? 'Loading settings…'
    : !configured ? 'Models not chosen'
      : `${provider?.name || providerId} · ${model?.name || conversation.settings.model.modelId} · `
        + thinkingLevelLabel(conversation.settings.thinkingLevel);
  const openAccount = () => router.push({ pathname: remote ? '/infinichat-providers' : '/account',
    params: { provider: providerId } });
  const settingsDisabled = !conversation;
  const openSettings = () => router.push('/infinichat-settings');
  const choosePrompt = useCallback((text: string) => {
    changeDraft(text);
    input.current?.focus();
  }, [changeDraft]);
  const attach = async (source: PhotoSource) => {
    if (!model?.images || attaching) return;
    setAttaching(true);
    setLocalError(undefined);
    try {
      const photos = await pickPhotos(source, model.images);
      if (photos.length) {
        setDraft((current) => ({ ...current, images: [...current.images, ...photos], requestId: uuidv7() }));
      }
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'The photo could not be attached. Try again.');
    } finally {
      setAttaching(false);
    }
  };
  const sendMessage = async () => {
    const text = draft.text.trim();
    if ((!text && !draft.images.length) || admitting) return;
    if (!configured || settingsError || !access.ready || !access.connected) return;
    if (draft.images.length && !model?.images) {
      setLocalError(`${model?.name || 'This model'} does not accept images. `
        + 'Remove the photos or choose another model.');
      return;
    }
    setAdmitting(true);
    setLocalError(undefined);
    try {
      await service.accept(userInput(text, draft.images), draft.requestId);
      setDraft(emptyDraft());
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'Your message could not be sent. Try again.');
    } finally {
      setAdmitting(false);
    }
  };
  const stop = async () => {
    if (stopping) return;
    // Shown until the stop settles: OptChat cancels the inputs it has not sent and aborts the running turn.
    setStopping(true);
    setLocalError(undefined);
    try {
      await service.stop();
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'Something went wrong. Please try again.');
    } finally {
      setStopping(false);
    }
  };
  // A move that failed, and a machine that can't be reached, are tried again when the user asks and when the app
  // becomes active; a send that failed with the same error offers the same. A removed machine has nothing to try again.
  const moveError = move?.running === false ? move.error : undefined;
  const connectionError = there && connection?.status === 'failed' ? connection.error : undefined;
  const messageError = localError || moveError || connectionError || conversation?.error || serviceError || appError
    || access.error;
  const retry = moveError && !localError ? () => moves?.retry()
    : !removed && connectionError && (!localError || localError === connectionError) ? () => {
      setLocalError(undefined);
      connection?.retry();
    } : undefined;
  const dismiss = localError ? () => setLocalError(undefined)
    : connectionError || conversation?.error ? undefined
      : serviceError ? () => service.dismissError()
        : appError ? dismissError : undefined;
  const working = busy ? `Working… · ${settingsLabel}` : settingsLabel;
  const subtitle = removed ? 'Machine removed'
    : move && machine !== undefined
      ? moving(move, machine, connection?.status === 'connecting' ? connection.stage : undefined,
        move.from === undefined ? undefined : nameOf(move.from))
      : !there || machine === undefined ? working
        : connection?.status === 'failed' ? `Can’t connect to ${machine}`
          : connection?.status === 'connecting' ? connecting(machine, connection.stage)
            : `${machine} · ${working}`;
  const runsOn = machineId === null || home.home === 'phone' ? PHONE
    : removed ? 'a removed machine' : machine ?? 'a remote machine';
  const onMachine = remote ? ` on ${shown}` : '';
  const accountAction = remote ? 'Providers' : 'Account';
  const accountStatus = !access.ready ? 'Restoring your connection…'
    : access.error ? `Reconnect ${provider?.name || providerId}${remote ? onMachine : ' in Account'}`
      : `Connect ${provider?.name || providerId || 'your provider'}${onMachine} to send a message`;
  // With no model chosen there is no provider to connect; the models notice says what to do instead.
  const connected = !configured || access.connected;
  return <View testID="infinichat-screen" style={[styles.screen, { backgroundColor: colors.background }]}>
    <Stack.Screen options={{ title: agentName,
      headerTitle: () => <Pressable testID="open-infinichat-settings" accessibilityRole="button"
        accessibilityLabel={`${agentName} settings. ${subtitle}`}
        accessibilityHint="Choose its name, avatar, models and their reasoning effort."
        accessibilityState={{ disabled: settingsDisabled }} disabled={settingsDisabled} onPress={openSettings}
        style={styles.headerTitle}>
        <Text numberOfLines={1} style={[styles.headerName, { color: PlatformColor('label') }]}>{agentName}</Text>
        <View style={styles.headerSettings}>
          <Text numberOfLines={1} style={[styles.headerSubtitle, { color: PlatformColor('secondaryLabel') }]}>
            {subtitle}
          </Text>
          <ChatIcon name="down" color={PlatformColor('secondaryLabel')} size={9} />
        </View>
      </Pressable>,
    }} />
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Menu icon={chosen === null ? 'iphone' : 'server.rack'}
        accessibilityLabel={`InfiniChat runs on ${runsOn}`}
        accessibilityHint="Move InfiniChat to this iPhone or one of your remote machines, or add a machine.">
        {/* Each inline menu is a group with its own separator: the places InfiniChat can run, the move in progress,
            then the actions that open a sheet, whose ellipsis says more input follows. */}
        <Stack.Toolbar.Menu inline>
          {/* A move goes first; from a machine, the conversation moves straight to the machine chosen. */}
          <Stack.Toolbar.MenuAction icon="iphone" isOn={chosen === null} disabled={movingNow}
            onPress={() => moves?.choose(null)}>
            {PHONE}
          </Stack.Toolbar.MenuAction>
          {hosts.hosts.map((host) => <Stack.Toolbar.MenuAction key={host.id} icon="server.rack"
            isOn={host.id === chosen} disabled={movingNow}
            onPress={() => moves?.choose(host.id)}>
            {nameOf(host.id) ?? host.hostname}
          </Stack.Toolbar.MenuAction>)}
        </Stack.Toolbar.Menu>
        {move?.cancellable && <Stack.Toolbar.Menu inline>
          <Stack.Toolbar.MenuAction icon="xmark" destructive onPress={() => moves?.cancel()}>
            Cancel Move
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>}
        <Stack.Toolbar.Menu inline>
          <Stack.Toolbar.MenuAction icon="plus" disabled={!hosts.ready || !!hosts.error}
            onPress={() => router.push('/remote-hosts/edit')}>
            Add Machine…
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="pencil" onPress={() => router.push('/remote-hosts')}>
            Manage Machines…
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar.Menu>
      <Stack.Toolbar.Button icon="clock" accessibilityLabel="Scheduled tasks"
        onPress={() => router.push('/infinichat-schedule')} />
    </Stack.Toolbar>
    <ChatAgentContext value={agent}><ChatTranscript view={view} ready stopping={stopping} onChoose={choosePrompt}
      composer={<>
      {conversation && !configured && <View style={styles.banner}>
        <InlineNotice testID="infinichat-models-required" tone="neutral" message={MODELS_REQUIRED}
          action={settingsDisabled ? undefined : 'Settings'} onAction={openSettings} />
      </View>}
      {settingsError && <View style={styles.banner}>
        <InlineNotice testID="infinichat-settings-error" message={settingsError}
          action={settingsDisabled ? undefined : 'Settings'} onAction={openSettings} />
      </View>}
      {messageError && messageError !== settingsError && <View style={styles.banner}>
        <InlineNotice testID="infinichat-error" message={messageError}
          action={retry ? 'Try Again' : dismiss ? 'Dismiss' : access.error ? accountAction : undefined}
          onAction={retry ?? dismiss ?? (access.error ? openAccount : undefined)} />
      </View>}
      {moveNotice && !messageError && <View style={styles.banner}>
        <InlineNotice testID="infinichat-move-notice" tone="neutral" message={moveNotice}
          action="Dismiss" onAction={() => moves?.dismissNotice()} />
      </View>}
      {connection?.notice && !moveNotice && !messageError && <View style={styles.banner}>
        <InlineNotice testID="infinichat-machine-notice" tone="neutral" message={connection.notice}
          action="Dismiss" onAction={connection.dismissNotice} />
      </View>}
      <Composer value={draft.text} onChange={changeDraft} onSend={() => { void sendMessage(); }}
        onStop={() => { void stop(); }}
        onConnect={openAccount} busy={busy} admitting={admitting} connected={connected}
        disabled={!conversation || stopping
          || (!busy && (!configured || !access.ready || !!settingsError))}
        accountStatus={accountStatus} inputRef={input}
        attachments={draft.images} onAttach={(source) => { void attach(source); }} onRemoveAttachment={removeImage}
        attaching={attaching} imagesSupported={!!model?.images} />
    </>} /></ChatAgentContext>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  headerTitle: { alignItems: 'center', justifyContent: 'center', maxWidth: 230, minHeight: 44 },
  headerName: { fontSize: 15, fontWeight: '600' },
  headerSettings: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  headerSubtitle: { fontSize: 11, flexShrink: 1 },
  banner: { paddingHorizontal: 16, paddingTop: 5, paddingBottom: 4, maxWidth: 800, width: '100%', alignSelf: 'center' },
});
