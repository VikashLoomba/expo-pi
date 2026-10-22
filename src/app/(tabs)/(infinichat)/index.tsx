import { uuidv7 } from '@earendil-works/pi-ai';
import { router, Stack } from 'expo-router';
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { PlatformColor, Pressable, StyleSheet, Text, View, type TextInputInstance } from 'react-native';

import {
  useChatApp, useChatControls, useInfiniChatAccount, useInfiniChatConnection, useInfiniChatError, useInfiniChatView,
} from '@/chat/chat-provider';
import { pickPhotos, type PhotoAttachment, type PhotoSource } from '@/chat/photo-attachments';
import { Composer } from '@/components/chat/composer';
import { ChatIcon } from '@/components/chat/icon';
import { InlineNotice } from '@/components/chat/primitives';
import { thinkingLevelLabel } from '@/components/chat/settings-controls';
import { ChatTranscript } from '@/components/chat/transcript';
import { useChatColors } from '@/hooks/use-chat-colors';
import type { InstallStage } from '@/pi/infinichat-remote/install';
import { findCatalogModel, getModelSettingsError } from '@/pi/model-catalog';
import { userInput } from '@/pi/user-input';

const TITLE = 'InfiniChat';
const MODELS_REQUIRED = 'Choose InfiniChat’s main and summary models in its settings to send a message.';
const PHONE = 'This iPhone';

const connecting = (machine: string, stage: InstallStage | undefined) => stage === 'uploading'
  ? `Installing InfiniChat on ${machine}…`
  : stage === 'starting' ? `Starting InfiniChat on ${machine}…` : `Connecting to ${machine}…`;

/** A draft keeps one request ID for every attempt to send it, so a resend after a failure is admitted once. */
type Draft = { text: string; images: readonly PhotoAttachment[]; requestId: string };
const emptyDraft = (): Draft => ({ text: '', images: [], requestId: uuidv7() });

/** InfiniChat's one conversation, as the chat screen shows a chat, sent through OptChat's acceptance. */
export default function InfiniChatScreen() {
  const colors = useChatColors();
  const {
    infiniChat: service, error: appError, dismissError, remoteHosts, infiniChatMachine, chooseInfiniChatMachine,
  } = useChatApp();
  // While InfiniChat runs on a machine, its models and sign-ins are that machine's.
  const { catalog, providerAccess } = useInfiniChatAccount();
  const ready = service !== undefined;
  const view = useInfiniChatView();
  const conversation = useChatControls(view);
  const serviceError = useInfiniChatError();
  const connection = useInfiniChatConnection();
  const machines = useSyncExternalStore(remoteHosts.subscribe, remoteHosts.getSnapshot, remoteHosts.getSnapshot);
  const remote = infiniChatMachine !== null;
  // Named once the machines are restored, so a launch never shows a placeholder name first.
  const machine = machines.hosts.find((host) => host.id === infiniChatMachine)?.name;
  const removed = remote && machines.ready && machine === undefined;
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
  const settingsDisabled = !ready || !conversation;
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
    if (!service || (!text && !draft.images.length) || admitting) return;
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
    if (!service || stopping) return;
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
  // A machine that can't be reached is tried again when the user asks, and when the app becomes active; a send that
  // failed with the same error offers the same. A removed machine has nothing to try again.
  const connectionError = connection?.status === 'failed' ? connection.error : undefined;
  const messageError = localError || connectionError || conversation?.error || serviceError || appError
    || access.error;
  const retry = !removed && connectionError && (!localError || localError === connectionError) ? () => {
    setLocalError(undefined);
    connection?.retry();
  } : undefined;
  const dismiss = localError ? () => setLocalError(undefined)
    : connectionError || conversation?.error ? undefined
      : serviceError ? () => service?.dismissError()
        : appError ? dismissError : undefined;
  const working = busy ? `Working… · ${settingsLabel}` : settingsLabel;
  const subtitle = removed ? 'Machine removed'
    : machine === undefined ? working
      : connection?.status === 'failed' ? `Can’t connect to ${machine}`
        : connection?.status === 'connecting' ? connecting(machine, connection.stage)
          : `${machine} · ${working}`;
  const runsOn = !remote ? PHONE : removed ? 'a removed machine' : machine ?? 'a remote machine';
  const onMachine = remote ? ` on ${machine ?? 'the machine'}` : '';
  const accountAction = remote ? 'Providers' : 'Account';
  const accountStatus = !access.ready ? 'Restoring your connection…'
    : access.error ? `Reconnect ${provider?.name || providerId}${remote ? onMachine : ' in Account'}`
      : `Connect ${provider?.name || providerId || 'your provider'}${onMachine} to send a message`;
  // With no model chosen there is no provider to connect; the models notice says what to do instead.
  const connected = !configured || access.connected;
  return <View testID="infinichat-screen" style={[styles.screen, { backgroundColor: colors.background }]}>
    <Stack.Screen options={{ title: TITLE,
      headerTitle: () => <Pressable testID="open-infinichat-settings" accessibilityRole="button"
        accessibilityLabel={`InfiniChat settings. ${subtitle}`}
        accessibilityHint="Choose the main and summary models and their reasoning effort."
        accessibilityState={{ disabled: settingsDisabled }} disabled={settingsDisabled} onPress={openSettings}
        style={styles.headerTitle}>
        <Text numberOfLines={1} style={[styles.headerName, { color: PlatformColor('label') }]}>{TITLE}</Text>
        <View style={styles.headerSettings}>
          <Text numberOfLines={1} style={[styles.headerSubtitle, { color: PlatformColor('secondaryLabel') }]}>
            {subtitle}
          </Text>
          <ChatIcon name="down" color={PlatformColor('secondaryLabel')} size={9} />
        </View>
      </Pressable>,
    }} />
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Menu icon={remote ? 'server.rack' : 'iphone'} accessibilityLabel={`InfiniChat runs on ${runsOn}`}
        accessibilityHint="Choose this iPhone or one of your remote machines.">
        <Stack.Toolbar.MenuAction icon="iphone" isOn={!remote} onPress={() => chooseInfiniChatMachine(null)}>
          {PHONE}
        </Stack.Toolbar.MenuAction>
        {machines.hosts.map((host) => <Stack.Toolbar.MenuAction key={host.id} icon="server.rack"
          isOn={host.id === infiniChatMachine} onPress={() => chooseInfiniChatMachine(host.id)}>
          {host.name}
        </Stack.Toolbar.MenuAction>)}
      </Stack.Toolbar.Menu>
      <Stack.Toolbar.Button icon="clock" accessibilityLabel="Scheduled tasks" disabled={!ready}
        onPress={() => router.push('/infinichat-schedule')} />
    </Stack.Toolbar>
    <ChatTranscript view={view} ready={ready} stopping={stopping} onChoose={choosePrompt} composer={<>
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
      {connection?.notice && !messageError && <View style={styles.banner}>
        <InlineNotice testID="infinichat-machine-notice" tone="neutral" message={connection.notice}
          action="Dismiss" onAction={connection.dismissNotice} />
      </View>}
      <Composer value={draft.text} onChange={changeDraft} onSend={() => { void sendMessage(); }}
        onStop={() => { void stop(); }}
        onConnect={openAccount} busy={busy} admitting={admitting} connected={connected}
        disabled={!ready || !conversation || stopping
          || (!busy && (!configured || !access.ready || !!settingsError))}
        accountStatus={accountStatus} inputRef={input}
        attachments={draft.images} onAttach={(source) => { void attach(source); }} onRemoveAttachment={removeImage}
        attaching={attaching} imagesSupported={!!model?.images} />
    </>} />
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
