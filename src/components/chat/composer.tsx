import type { RefObject } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputInstance } from 'react-native';

import { useChatColors } from '@/hooks/use-chat-colors';
import { ChatIcon } from './icon';

export function Composer({ value, onChange, onSend, onStop, onConnect, busy, admitting, disabled, connected, accountStatus, inputRef }: {
  value: string; onChange: (text: string) => void; onSend: () => void; onStop: () => void; onConnect: () => void;
  busy: boolean; admitting: boolean; disabled: boolean; connected: boolean; accountStatus?: string; inputRef: RefObject<TextInputInstance | null>;
}) {
  const colors = useChatColors();
  const canSend = connected && !disabled && !admitting && !!value.trim();
  return <View style={[styles.container, { backgroundColor: colors.background }]}>
    {!connected && <Pressable testID="composer-sign-in" accessibilityRole="button" onPress={onConnect} style={styles.signIn}>
      <ChatIcon name="lock" color={colors.accent} size={13} />
      <Text style={[styles.signInText, { color: colors.accent }]}>{accountStatus || 'Connect your provider to send a message'}</Text>
      <ChatIcon name="chevron" color={colors.accent} size={10} />
    </Pressable>}
    <View style={[styles.inputShell, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <TextInput ref={inputRef} testID="composer-input" accessibilityLabel="Message Pi" value={value} onChangeText={onChange}
        placeholder={busy ? 'Write a follow-up…' : 'Message Pi…'} placeholderTextColor={colors.muted}
        multiline maxLength={30000} editable={!admitting} textAlignVertical="top" style={[styles.input, { color: colors.text }]}
        selectionColor={colors.accent} />
      {busy ? <Pressable testID="stop-generation" accessibilityRole="button" accessibilityLabel="Stop response" onPress={onStop} disabled={disabled}
        style={({ pressed }) => [styles.send, { backgroundColor: colors.accentSoft, opacity: pressed || disabled ? 0.5 : 1 }]}>
        <ChatIcon name="stop" color={colors.accent} size={17} />
      </Pressable> : <Pressable testID="send-message" accessibilityRole="button" accessibilityLabel="Send message" disabled={!canSend} onPress={onSend}
        style={({ pressed }) => [styles.send, { backgroundColor: canSend ? colors.accent : colors.subtle, opacity: pressed ? 0.65 : 1 }]}>
        {admitting ? <ActivityIndicator color={colors.secondary} size="small" /> : <ChatIcon name="send" color={canSend ? colors.onAccent : colors.muted} size={20} />}
      </Pressable>}
    </View>
    <Text style={[styles.footnote, { color: colors.muted }]}>{busy ? 'Pi is working. You can stop at any time.' : 'Pi can make mistakes. Check important details.'}</Text>
  </View>;
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 16, paddingTop: 9, paddingBottom: 5, width: '100%', maxWidth: 800, alignSelf: 'center' },
  inputShell: { flexDirection: 'row', alignItems: 'flex-end', borderWidth: 1, borderRadius: 26, padding: 7, paddingLeft: 17, gap: 10 },
  input: { flex: 1, minHeight: 42, maxHeight: 145, paddingVertical: 10, fontSize: 16, lineHeight: 22 },
  send: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginBottom: 1 },
  signIn: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, minHeight: 36, marginBottom: 5 },
  signInText: { fontSize: 12, fontWeight: '500' },
  footnote: { fontSize: 10, lineHeight: 16, textAlign: 'center', marginTop: 7, marginBottom: 2 },
});
