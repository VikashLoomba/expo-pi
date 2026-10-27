import { uuidv7, type UserMessage } from '@earendil-works/pi-ai';
import type { ConversationId } from '@earendil-works/pi-durable';
import { findCatalogModel, getModelSettingsError } from '@pi-agent/infinichat/pi/model-catalog';
import { userInput } from '@pi-agent/infinichat/pi/user-input';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PlatformColor, Pressable, StyleSheet, Text, View, type TextInputInstance } from 'react-native';

import { useChatApp, useChatControls, useChatId, useChatStatus, useChatView } from '@/chat/chat-provider';
import { pickPhotos, type PhotoAttachment, type PhotoSource } from '@/chat/photo-attachments';
import { useChatActions } from '@/components/chat/chat-actions';
import { Composer } from '@/components/chat/composer';
import { ChatIcon } from '@/components/chat/icon';
import { ChatTranscript } from '@/components/chat/transcript';
import { InlineNotice } from '@/components/chat/primitives';
import { thinkingLevelLabel } from '@/components/chat/settings-controls';
import { useChatColors } from '@/hooks/use-chat-colors';

export default function ConversationRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const chatId = useChatId(id);
  // A different conversation owns a different draft, scroll position, and composer.
  return <ConversationScreen key={id} id={chatId} />;
}

function ConversationScreen({ id }: { id: ConversationId | undefined }) {
  const colors = useChatColors();
  const { ready, service, catalog, providerAccess, error: appError, dismissError } = useChatApp();
  const view = useChatView(id, true);
  const conversation = useChatControls(view);
  const status = useChatStatus(view);
  const shown = useRef(false);
  useEffect(() => {
    if (status === 'ready') shown.current = true;
    // A shown chat goes missing only when Delete in its menu deletes it, and then the chat list is what is left.
    else if (status === 'missing' && shown.current) router.back();
  }, [status]);
  // A draft keeps one request ID for every attempt to send it, so a resend after a failure does not submit twice.
  const emptyDraft = () => ({ text: '', images: [] as readonly PhotoAttachment[], requestId: uuidv7() });
  const [draft, setDraft] = useState(emptyDraft);
  const changeDraft = useCallback((text: string) => {
    setDraft((current) => current.text === text ? current : { ...current, text, requestId: uuidv7() });
  }, []);
  const removeImage = useCallback((imageId: string) => {
    setDraft((current) => ({ ...current, images: current.images.filter((image) => image.id !== imageId), requestId: uuidv7() }));
  }, []);
  const [attaching, setAttaching] = useState(false);
  const [admitting, setAdmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [steering, setSteering] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const actions = useChatActions(setLocalError);
  const input = useRef<TextInputInstance>(null);
  const busy = !!conversation?.busy;
  const providerId = conversation?.settings.model.provider;
  const provider = catalog.find((entry) => entry.id === providerId);
  const model = conversation ? findCatalogModel(catalog, conversation.settings.model) : undefined;
  const access = providerAccess(providerId || '');
  const settingsError = conversation ? getModelSettingsError(catalog, conversation.settings) : undefined;
  const settingsLabel = conversation
    ? `${provider?.name || providerId} · ${model?.name || conversation.settings.model.modelId} · `
      + thinkingLevelLabel(conversation.settings.thinkingLevel)
    : 'Loading settings…';
  const settingsDisabled = !ready || !conversation;
  const openSettings = () => {
    if (id !== undefined) router.push({ pathname: '/chat-settings/[id]', params: { id } });
  };
  const openAccount = () => router.push({ pathname: '/account', params: { provider: providerId } });
  // Undefined while the chat is loading, unavailable or deleted, which hides its menu.
  const chat = id !== undefined && conversation ? { id, title: conversation.title } : undefined;
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
      if (photos.length) setDraft((current) => ({ ...current, images: [...current.images, ...photos], requestId: uuidv7() }));
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'The photo could not be attached. Try again.');
    } finally {
      setAttaching(false);
    }
  };
  const sendMessage = async () => {
    const text = draft.text.trim();
    if (id === undefined || !service || (!text && !draft.images.length) || admitting || !access.ready || !access.connected) return;
    if (settingsError) return;
    if (draft.images.length && !model?.images) {
      setLocalError(`${model?.name || 'This model'} does not accept images. Remove the photos or choose another model.`);
      return;
    }
    setAdmitting(true);
    setLocalError(undefined);
    try {
      await service.send(id, userInput(text, draft.images), draft.requestId);
      setDraft(emptyDraft());
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'Your message could not be sent. Try again.');
    } finally {
      setAdmitting(false);
    }
  };
  const steerQueued = async (submissionId: number, content: UserMessage['content']) => {
    if (id === undefined || !service || steering) return;
    setSteering(true);
    setLocalError(undefined);
    try { await service.steerQueued(id, submissionId, content); }
    catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'The message could not be sent as a steer. Try again.');
    } finally {
      setSteering(false);
    }
  };
  const resume = async () => {
    const parked = conversation?.parked;
    if (!service || !parked) return;
    setLocalError(undefined);
    try { await service.retryParked(parked); }
    catch (cause) { setLocalError(cause instanceof Error ? cause.message : 'The work could not resume. Try again.'); }
  };
  const stop = async () => {
    if (id === undefined || !service || stopping) return;
    // Shown until the abort settles; it resolves once the chat is idle.
    setStopping(true);
    setLocalError(undefined);
    try { await service.cancel(id); }
    catch (cause) { setLocalError(cause instanceof Error ? cause.message : 'Something went wrong. Please try again.'); }
    finally { setStopping(false); }
  };
  const messageError = localError || conversation?.error || appError || access.error;
  const showsAppError = !localError && !conversation?.error && !!appError;
  const accountStatus = !access.ready ? 'Restoring your connection…'
    : access.error ? `Reconnect ${provider?.name || providerId} in Account`
      : `Connect ${provider?.name || providerId || 'your provider'} to send a message`;
  return <View testID="conversation-screen" style={[styles.screen, { backgroundColor: colors.background }]}>
    <Stack.Screen options={{ title: conversation?.title || 'New chat',
      headerTitle: () => <Pressable testID="open-chat-settings" accessibilityRole="button" accessibilityLabel={`Chat settings. ${settingsLabel}`}
        accessibilityHint="Change the provider, model, and reasoning effort for this chat." accessibilityState={{ disabled: settingsDisabled }}
        disabled={settingsDisabled} onPress={openSettings} style={styles.headerTitle}>
        <Text numberOfLines={1} style={[styles.headerName, { color: PlatformColor('label') }]}>{conversation?.title || 'New chat'}</Text>
        <View style={styles.headerSettings}>
          <Text numberOfLines={1} style={[styles.headerSubtitle, { color: PlatformColor('secondaryLabel') }]}>
            {busy ? `Working… · ${settingsLabel}` : settingsLabel}
          </Text>
          <ChatIcon name="down" color={PlatformColor('secondaryLabel')} size={9} />
        </View>
      </Pressable>,
    }} />
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel="Chat options" hidden={!chat}>
        <Stack.Toolbar.MenuAction icon="slider.horizontal.3" onPress={openSettings}>
          Model settings
        </Stack.Toolbar.MenuAction>
        <Stack.Toolbar.MenuAction icon="pencil" onPress={() => { if (chat) actions.rename(chat); }}>
          Rename
        </Stack.Toolbar.MenuAction>
        <Stack.Toolbar.MenuAction icon="trash" destructive onPress={() => { if (chat) actions.remove(chat); }}>
          Delete
        </Stack.Toolbar.MenuAction>
      </Stack.Toolbar.Menu>
    </Stack.Toolbar>
    <ChatTranscript view={view} ready={ready} stopping={stopping} onChoose={choosePrompt}
      onSteerQueued={steerQueued} composer={<>
        {settingsError && <View style={styles.banner}>
          <InlineNotice testID="conversation-settings-error" message={settingsError}
            action={!settingsDisabled ? 'Chat settings' : undefined} onAction={openSettings} />
        </View>}
        {conversation?.parked && <View style={styles.banner}>
          <InlineNotice testID="conversation-parked"
            message="Pi paused this chat's work because the app quit while it was running several times in a row."
            action="Resume" onAction={() => { void resume(); }} />
        </View>}
        {messageError && messageError !== settingsError && <View style={styles.banner}>
          <InlineNotice testID="conversation-error" message={messageError}
            action={localError || showsAppError ? 'Dismiss' : access.error ? 'Account' : undefined}
            onAction={localError ? () => setLocalError(undefined) : showsAppError ? dismissError
              : access.error ? openAccount : undefined} />
        </View>}
        <Composer value={draft.text} onChange={changeDraft} onSend={() => { void sendMessage(); }}
          onStop={() => { void stop(); }}
          onConnect={openAccount} busy={busy} admitting={admitting} connected={access.connected}
          disabled={!ready || !conversation || stopping || (!busy && (!access.ready || !!settingsError))}
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
