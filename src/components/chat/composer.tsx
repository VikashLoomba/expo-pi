import { Button, Host, Menu } from '@expo/ui/swift-ui';
import {
  buttonBorderShape, buttonStyle, controlSize, disabled as disable, labelStyle, tint,
} from '@expo/ui/swift-ui/modifiers';
import { GlassView } from 'expo-glass-effect';
import { Image } from 'expo-image';
import type { RefObject } from 'react';
import {
  ActivityIndicator, PlatformColor, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputInstance,
} from 'react-native';

import type { PhotoAttachment, PhotoSource } from '@/chat/photo-attachments';
import { useChatColors } from '@/hooks/use-chat-colors';
import { ChatIcon } from './icon';

/** The message field and its controls, floating as Liquid Glass over the transcript. */
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
  return <View style={styles.container}>
    {!connected && <GlassView isInteractive style={styles.signIn}>
      <Pressable testID="composer-sign-in" accessibilityRole="button" onPress={onConnect} style={styles.signInButton}>
        <ChatIcon name="lock" color={colors.accent} size={13} />
        <Text style={[styles.signInText, { color: colors.accent }]}>
          {accountStatus || 'Connect your provider to send a message'}
        </Text>
        <ChatIcon name="chevron" color={colors.accent} size={10} />
      </Pressable>
    </GlassView>}
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
    <View style={styles.row}>
      {attaching ? <GlassView style={styles.attaching}>
        <ActivityIndicator color={PlatformColor('label')} size="small" />
      </GlassView>
        : <Host matchContents>
          <Menu label="Attach a photo" systemImage="plus" modifiers={[labelStyle('iconOnly'), buttonStyle('glass'),
            buttonBorderShape('circle'), controlSize('large'), tint({ type: 'hierarchical', style: 'primary' }),
            disable(!canAttach)]}>
            <Button label="Take Photo" systemImage="camera" onPress={() => onAttach('camera')} />
            <Button label="Choose Photos" systemImage="photo.on.rectangle" onPress={() => onAttach('library')} />
          </Menu>
        </Host>}
      <GlassView style={styles.field}>
        <TextInput ref={inputRef} testID="composer-input" accessibilityLabel="Message Pi" value={value}
          onChangeText={onChange} placeholder={busy ? 'Write a follow-up…' : 'Message Pi…'}
          placeholderTextColor={PlatformColor('placeholderText')} multiline maxLength={30000} editable={!admitting}
          style={[styles.input, { color: PlatformColor('label') }]} selectionColor={colors.accent} />
        <Pressable testID="send-message" accessibilityRole="button" accessibilityLabel="Send message"
          disabled={!canSend} onPress={onSend}
          style={({ pressed }) => [styles.send,
            { backgroundColor: canSend ? colors.accent : colors.subtle, opacity: pressed ? 0.65 : 1 }]}>
          {admitting ? <ActivityIndicator color={colors.secondary} size="small" />
            : <ChatIcon name="send" color={canSend ? colors.onAccent : colors.muted} size={18} />}
        </Pressable>
        {busy && <Pressable testID="stop-generation" accessibilityRole="button" accessibilityLabel="Stop response"
          onPress={onStop} disabled={disabled}
          style={({ pressed }) => [styles.send,
            { backgroundColor: colors.accentSoft, opacity: pressed || disabled ? 0.5 : 1 }]}>
          <ChatIcon name="stop" color={colors.accent} size={15} />
        </Pressable>}
      </GlassView>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 8, gap: 8, width: '100%', maxWidth: 800,
    alignSelf: 'center' },
  attachments: { gap: 10, paddingHorizontal: 6, paddingTop: 6, paddingBottom: 4 },
  attachment: { width: 72, height: 72 },
  thumbnail: { width: 72, height: 72, borderRadius: 14 },
  remove: { position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: 11, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  attaching: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  // A capsule while the message is one line; it keeps the radius as the field grows.
  field: { flex: 1, minHeight: 48, borderRadius: 24, flexDirection: 'row', alignItems: 'flex-end', paddingLeft: 16,
    paddingRight: 6, paddingVertical: 6, gap: 6 },
  input: { flex: 1, minHeight: 36, maxHeight: 145, paddingVertical: 7, fontSize: 16, lineHeight: 22 },
  send: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  signIn: { alignSelf: 'center', borderRadius: 18 },
  signInButton: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 14 },
  signInText: { fontSize: 12, fontWeight: '500' },
});
