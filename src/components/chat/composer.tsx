import { Image } from 'expo-image';
import type { RefObject } from 'react';
import {
  ActionSheetIOS, ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputInstance,
} from 'react-native';

import type { PhotoAttachment, PhotoSource } from '@/chat/photo-attachments';
import { useChatColors } from '@/hooks/use-chat-colors';
import { ChatIcon } from './icon';

const PHOTO_SOURCES: readonly PhotoSource[] = ['camera', 'library'];

export function Composer({ value, onChange, onSend, onStop, onConnect, busy, admitting, disabled, connected, accountStatus,
  inputRef, attachments, onAttach, onRemoveAttachment, attaching, imagesSupported }: {
  value: string; onChange: (text: string) => void; onSend: () => void; onStop: () => void; onConnect: () => void;
  busy: boolean; admitting: boolean; disabled: boolean; connected: boolean; accountStatus?: string;
  inputRef: RefObject<TextInputInstance | null>;
  attachments: readonly PhotoAttachment[];
  onAttach: (source: PhotoSource) => void;
  onRemoveAttachment: (id: string) => void;
  /** Photos are being prepared for the model. */
  attaching: boolean;
  /** The chat's model takes images; without it the attach control is unavailable. */
  imagesSupported: boolean;
}) {
  const colors = useChatColors();
  const canSend = connected && !disabled && !admitting && !attaching && (!!value.trim() || attachments.length > 0);
  const canAttach = imagesSupported && !disabled && !admitting && !attaching;
  const chooseSource = () => ActionSheetIOS.showActionSheetWithOptions(
    { options: ['Take Photo', 'Choose Photos', 'Cancel'], cancelButtonIndex: 2 },
    (index) => {
      const source = PHOTO_SOURCES[index];
      if (source) onAttach(source);
    });
  return <View style={[styles.container, { backgroundColor: colors.background }]}>
    {!connected && <Pressable testID="composer-sign-in" accessibilityRole="button" onPress={onConnect} style={styles.signIn}>
      <ChatIcon name="lock" color={colors.accent} size={13} />
      <Text style={[styles.signInText, { color: colors.accent }]}>{accountStatus || 'Connect your provider to send a message'}</Text>
      <ChatIcon name="chevron" color={colors.accent} size={10} />
    </Pressable>}
    {attachments.length > 0 && <ScrollView horizontal keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false} contentContainerStyle={styles.attachments}>
      {attachments.map((attachment, index) => <View key={attachment.id} style={styles.attachment}>
        <Image source={{ uri: attachment.uri }} contentFit="cover" accessibilityLabel={`Attached photo ${index + 1}`}
          style={[styles.thumbnail, { backgroundColor: colors.subtle }]} />
        <Pressable testID={`remove-attachment-${index}`} accessibilityRole="button"
          accessibilityLabel={`Remove photo ${index + 1}`} disabled={admitting}
          onPress={() => onRemoveAttachment(attachment.id)}
          style={[styles.remove, { backgroundColor: colors.text, borderColor: colors.background }]}>
          <ChatIcon name="close" color={colors.background} size={10} />
        </Pressable>
      </View>)}
    </ScrollView>}
    <View style={[styles.inputShell, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Pressable testID="attach-photo" accessibilityRole="button" accessibilityLabel="Attach a photo"
        accessibilityHint={imagesSupported ? 'Take a photo or choose photos from your library.'
          : 'This model does not accept images.'}
        accessibilityState={{ disabled: !canAttach, busy: attaching }} disabled={!canAttach} onPress={chooseSource}
        style={({ pressed }) => [styles.attach, { opacity: canAttach ? pressed ? 0.6 : 1 : 0.35 }]}>
        {attaching ? <ActivityIndicator color={colors.secondary} size="small" />
          : <ChatIcon name="plus" color={colors.secondary} size={20} />}
      </Pressable>
      <TextInput ref={inputRef} testID="composer-input" accessibilityLabel="Message Pi" value={value} onChangeText={onChange}
        placeholder={busy ? 'Write a follow-up…' : 'Message Pi…'} placeholderTextColor={colors.muted}
        multiline maxLength={30000} editable={!admitting} style={[styles.input, { color: colors.text }]}
        selectionColor={colors.accent} />
      <Pressable testID="send-message" accessibilityRole="button" accessibilityLabel="Send message" disabled={!canSend} onPress={onSend}
        style={({ pressed }) => [styles.send, { backgroundColor: canSend ? colors.accent : colors.subtle, opacity: pressed ? 0.65 : 1 }]}>
        {admitting ? <ActivityIndicator color={colors.secondary} size="small" /> : <ChatIcon name="send" color={canSend ? colors.onAccent : colors.muted} size={20} />}
      </Pressable>
      {busy && <Pressable testID="stop-generation" accessibilityRole="button" accessibilityLabel="Stop response" onPress={onStop} disabled={disabled}
        style={({ pressed }) => [styles.send, { backgroundColor: colors.accentSoft, opacity: pressed || disabled ? 0.5 : 1 }]}>
        <ChatIcon name="stop" color={colors.accent} size={17} />
      </Pressable>}
    </View>
    <Text style={[styles.footnote, { color: colors.muted }]}>{busy ? 'Pi is working. Send a follow-up, or stop at any time.' : 'Pi can make mistakes. Check important details.'}</Text>
  </View>;
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 16, paddingTop: 9, paddingBottom: 5, width: '100%', maxWidth: 800, alignSelf: 'center' },
  attachments: { gap: 10, paddingHorizontal: 6, paddingTop: 6, paddingBottom: 12 },
  attachment: { width: 72, height: 72 },
  thumbnail: { width: 72, height: 72, borderRadius: 14 },
  remove: { position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: 11, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center' },
  inputShell: { flexDirection: 'row', alignItems: 'flex-end', borderWidth: 1, borderRadius: 26, padding: 7, paddingLeft: 7, gap: 6 },
  attach: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginBottom: 1 },
  input: { flex: 1, minHeight: 42, maxHeight: 145, paddingVertical: 10, fontSize: 16, lineHeight: 22 },
  send: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginBottom: 1 },
  signIn: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, minHeight: 36, marginBottom: 5 },
  signInText: { fontSize: 12, fontWeight: '500' },
  footnote: { fontSize: 10, lineHeight: 16, textAlign: 'center', marginTop: 7, marginBottom: 2 },
});
