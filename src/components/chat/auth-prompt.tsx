import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import type { PendingAuthPrompt } from '@/chat/auth-prompt-controller';
import { useChatColors } from '@/hooks/use-chat-colors';
import { ActionButton } from './primitives';

/** Key by pending.id so answers never survive a step change or cancelled login. */
export function AuthPromptForm({ pending, submit, openBrowser, browserOpen }: {
  pending: PendingAuthPrompt;
  submit(id: number, value: string): boolean;
  openBrowser?: () => void;
  browserOpen: boolean;
}) {
  const colors = useChatColors();
  const [value, setValue] = useState('');
  const { prompt, id } = pending;
  const manual = prompt.type === 'manual_code';
  const send = (answer: string) => {
    if (submit(id, answer)) setValue('');
  };
  return <View testID={`auth-prompt-${prompt.type}`} style={styles.container}>
    <Text accessibilityLiveRegion="polite" style={[styles.instructions, { color: colors.secondary }]}>
      {manual ? 'Finish sign-in in your browser, then copy the full address of the final callback page and paste it below, even if that page does not load. Keep this screen open until sign-in finishes.' : prompt.message}
    </Text>
    {manual && openBrowser && <ActionButton testID="auth-prompt-open-browser" title="Open in browser" secondary
      disabled={browserOpen} onPress={openBrowser} />}
    {prompt.type === 'select' ? prompt.options.map((option) => <View key={option.id} style={styles.option}>
      <ActionButton testID={`auth-prompt-option-${option.id}`} title={option.label} secondary onPress={() => send(option.id)} />
      {option.description && <Text style={[styles.instructions, { color: colors.secondary }]}>{option.description}</Text>}
    </View>) : <>
      <TextInput testID="auth-prompt-input" accessibilityLabel={manual ? 'Sign-in callback URL' : prompt.message}
        value={value} onChangeText={setValue} onSubmitEditing={() => send(value)} returnKeyType="done"
        autoCapitalize="none" autoCorrect={false} autoComplete="off" textContentType="none"
        secureTextEntry={manual || prompt.type === 'secret'}
        placeholder={manual ? 'Paste the full callback URL' : prompt.placeholder} placeholderTextColor={colors.muted}
        style={[styles.input, { color: colors.text, backgroundColor: colors.background, borderColor: colors.border }]} />
      <ActionButton testID="auth-prompt-submit" title="Continue" disabled={!value.trim()} onPress={() => send(value)} />
    </>}
  </View>;
}

const styles = StyleSheet.create({
  container: { gap: 14 },
  instructions: { fontSize: 13, lineHeight: 20 },
  option: { gap: 8 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 14, minHeight: 48, fontSize: 14 },
});
