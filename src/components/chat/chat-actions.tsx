import type { ConversationId } from '@earendil-works/pi-durable';
import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useChatApp } from '@/chat/chat-provider';
import { useChatColors } from '@/hooks/use-chat-colors';
import { ChatIcon } from './icon';
import { ActionButton, IconButton, InlineNotice } from './primitives';

export function ChatActions({ chat, onClose, onArchived }: {
  chat?: { id: ConversationId; title: string }; onClose: () => void; onArchived?: () => void;
}) {
  return chat ? <ChatActionsDialog key={`${chat.id}:${chat.title}`} chat={chat} onClose={onClose} onArchived={onArchived} /> : null;
}

function ChatActionsDialog({ chat, onClose, onArchived }: {
  chat: { id: ConversationId; title: string }; onClose: () => void; onArchived?: () => void;
}) {
  const colors = useChatColors();
  const insets = useSafeAreaInsets();
  const { ready, runtime } = useChatApp();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const [openingSettings, setOpeningSettings] = useState(false);
  const settingsDisabled = !ready || working;
  const navigateToSettings = () => {
    onClose();
    router.push({ pathname: '/chat-settings/[id]', params: { id: chat.id } });
  };
  const openSettings = () => {
    if (settingsDisabled) return;
    // Wait until UIKit finishes dismissing the options sheet before presenting
    // the settings route. Android and web do not need this presentation handoff.
    if (Platform.OS === 'ios') setOpeningSettings(true);
    else navigateToSettings();
  };
  const save = async () => {
    if (!chat || !title.trim() || working) return;
    setWorking(true); setError(undefined);
    try { await runtime.renameChat(chat.id, title.trim()); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not rename this chat.'); }
    finally { setWorking(false); }
  };
  const archive = async () => {
    if (!chat || working) return;
    setWorking(true); setError(undefined);
    try { await runtime.archiveChat(chat.id); onClose(); onArchived?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not archive this chat.'); }
    finally { setWorking(false); }
  };
  return <Modal visible={!openingSettings} transparent animationType="slide" onDismiss={() => { if (openingSettings) navigateToSettings(); }} onRequestClose={() => { if (!working) onClose(); }}>
    <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Pressable accessibilityLabel="Close chat options" style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]} onPress={() => { if (!working) onClose(); }} />
      <View accessibilityViewIsModal style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: Math.max(insets.bottom, 18) }]}>
        <View style={styles.headingRow}>
          <Text numberOfLines={1} style={[styles.heading, { color: colors.text }]}>{renaming ? 'Rename chat' : chat?.title || 'New chat'}</Text>
          <IconButton testID="close-chat-options" icon="close" label="Close" onPress={onClose} disabled={working} />
        </View>
        {error && <InlineNotice message={error} />}
        {renaming ? <View style={styles.renameForm}>
          <TextInput testID="rename-chat-input" accessibilityLabel="Chat title" autoFocus value={title} onChangeText={setTitle} maxLength={100}
            editable={!working} returnKeyType="done" onSubmitEditing={() => { void save(); }} selectTextOnFocus
            placeholder="Chat title" placeholderTextColor={colors.muted} style={[styles.titleInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]} />
          <ActionButton testID="save-chat-title" title="Save name" loading={working} disabled={!title.trim()} onPress={() => { void save(); }} />
        </View> : <View style={styles.options}>
          <Pressable testID="chat-model-settings" accessibilityRole="button" accessibilityState={{ disabled: settingsDisabled }} onPress={openSettings} disabled={settingsDisabled}
            style={[styles.option, { opacity: settingsDisabled ? 0.45 : 1 }]}>
            <ChatIcon name="spark" color={colors.secondary} size={20} /><View style={styles.archiveText}>
              <Text style={[styles.optionLabel, { color: colors.text }]}>Model settings</Text>
              <Text style={[styles.caption, { color: colors.muted }]}>Provider, model, and reasoning effort.</Text>
            </View>
          </Pressable>
          <Pressable testID="rename-chat" accessibilityRole="button" onPress={() => setRenaming(true)} disabled={working} style={styles.option}>
            <ChatIcon name="pencil" color={colors.secondary} size={20} /><Text style={[styles.optionLabel, { color: colors.text }]}>Rename</Text>
          </Pressable>
          <Pressable testID="archive-chat" accessibilityRole="button" onPress={() => { void archive(); }} disabled={working} style={styles.option}>
            <ChatIcon name="archive" color={colors.secondary} size={20} /><View style={styles.archiveText}>
              <Text style={[styles.optionLabel, { color: colors.text }]}>{working ? 'Archiving…' : 'Archive chat'}</Text>
              <Text style={[styles.caption, { color: colors.muted }]}>Remove from your chat list.</Text>
            </View>
          </Pressable>
        </View>}
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 22, paddingTop: 14, width: '100%', maxWidth: 620, alignSelf: 'center', gap: 12 },
  headingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  heading: { fontSize: 20, fontWeight: '600', flex: 1 },
  options: { paddingBottom: 8 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 17, minHeight: 64, paddingVertical: 13 },
  optionLabel: { fontSize: 16 },
  caption: { fontSize: 12, marginTop: 5 },
  archiveText: { flex: 1 },
  renameForm: { gap: 18, paddingTop: 7, paddingBottom: 12 },
  titleInput: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 15, paddingVertical: 15, fontSize: 17 },
});
