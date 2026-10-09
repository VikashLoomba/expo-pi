import { uuidv7 } from '@earendil-works/pi-ai';
import type { ConversationId } from '@earendil-works/pi-durable';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Pressable, StyleSheet, Text, View, type TextInputInstance, type ViewInstance } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useChatApp, useChatControls, useChatId, useChatStatus, useChatView } from '@/chat/chat-provider';
import { useChatActions } from '@/components/chat/chat-actions';
import { Composer } from '@/components/chat/composer';
import { ChatIcon } from '@/components/chat/icon';
import { ChatTranscript, type ChatTranscriptHandle } from '@/components/chat/transcript';
import { InlineNotice } from '@/components/chat/primitives';
import { thinkingLevelLabel } from '@/components/chat/settings-controls';
import { useChatColors } from '@/hooks/use-chat-colors';
import { findCatalogModel, getModelSettingsError } from '@/pi/model-catalog';

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
  const [draft, setDraft] = useState(() => ({ text: '', requestId: uuidv7() }));
  const changeDraft = useCallback((text: string) => {
    setDraft((current) => current.text === text ? current : { text, requestId: uuidv7() });
  }, []);
  const [admitting, setAdmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const actions = useChatActions(setLocalError);
  const [headerOffset, setHeaderOffset] = useState(0);
  const transcript = useRef<ChatTranscriptHandle>(null);
  const input = useRef<TextInputInstance>(null);
  const keyboardContainer = useRef<ViewInstance>(null);
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
  const sendMessage = async () => {
    const text = draft.text.trim();
    if (id === undefined || !service || !text || admitting || !access.ready || !access.connected || busy) return;
    if (settingsError) return;
    setAdmitting(true);
    setLocalError(undefined);
    try {
      await service.send(id, text, draft.requestId);
      setDraft({ text: '', requestId: uuidv7() });
      transcript.current?.scrollToLatest();
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'Your message could not be sent. Try again.');
    } finally {
      setAdmitting(false);
    }
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
  return <View ref={keyboardContainer} testID="conversation-screen" onLayout={() => keyboardContainer.current?.measureInWindow((_x, y) => setHeaderOffset(y))}
    style={[styles.screen, { backgroundColor: colors.background }]}>
    <Stack.Screen options={{ title: conversation?.title || 'New chat',
      headerTitle: () => <Pressable testID="open-chat-settings" accessibilityRole="button" accessibilityLabel={`Chat settings. ${settingsLabel}`}
        accessibilityHint="Change the provider, model, and reasoning effort for this chat." accessibilityState={{ disabled: settingsDisabled }}
        disabled={settingsDisabled} onPress={openSettings} style={styles.headerTitle}>
        <Text numberOfLines={1} style={[styles.headerName, { color: colors.text }]}>{conversation?.title || 'New chat'}</Text>
        <View style={styles.headerSettings}><Text numberOfLines={1} style={[styles.headerSubtitle, { color: colors.muted }]}>{busy ? `Working… · ${settingsLabel}` : settingsLabel}</Text><ChatIcon name="down" color={colors.muted} size={9} /></View>
      </Pressable>,
    }} />
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Menu icon="ellipsis.circle" accessibilityLabel="Chat options" hidden={!chat}>
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
    <KeyboardAvoidingView style={styles.screen} behavior="padding" keyboardVerticalOffset={headerOffset}>
      <SafeAreaView style={styles.screen} edges={['bottom']}>
        <ChatTranscript ref={transcript} view={view} ready={ready} stopping={stopping} onChoose={choosePrompt} />
        {settingsError && <View style={styles.banner}><InlineNotice testID="conversation-settings-error" message={settingsError}
          action={!settingsDisabled ? 'Chat settings' : undefined} onAction={openSettings} /></View>}
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
          accountStatus={accountStatus} inputRef={input} />
      </SafeAreaView>
    </KeyboardAvoidingView>
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
