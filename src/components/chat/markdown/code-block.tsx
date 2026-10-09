import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useChatColors } from '@/hooks/use-chat-colors';
import { ChatIcon } from '../icon';

export function CodeBlock({ language, code }: { language: string; code: string }) {
  const colors = useChatColors();
  const [copied, setCopied] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timeout.current), []);

  const copy = async () => {
    try {
      if (!await Clipboard.setStringAsync(code)) throw new Error('Clipboard unavailable');
      setCopied(true);
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      Alert.alert('Could not copy', 'You can select the text and copy it manually.');
    }
  };

  return <View style={[styles.container, { backgroundColor: colors.subtle, borderColor: colors.border }]}>
    <View style={[styles.header, { borderBottomColor: colors.border }]}>
      <Text numberOfLines={1} style={[styles.language, { color: colors.secondary }]}>{language || 'Code'}</Text>
      <Pressable accessibilityLabel={copied ? 'Code copied' : 'Copy code'} accessibilityRole="button"
        onPress={() => { void copy(); }} style={styles.copyButton}>
        <ChatIcon name={copied ? 'check' : 'copy'} color={colors.secondary} size={15} />
        <Text style={[styles.copyLabel, { color: colors.secondary }]}>{copied ? 'Copied' : 'Copy'}</Text>
      </Pressable>
    </View>
    <ScrollView horizontal contentContainerStyle={styles.scroll}>
      <Text selectable style={[styles.code, { color: colors.text }]}>{code || ' '}</Text>
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  container: { borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 13, paddingRight: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  language: { flex: 1, fontSize: 12, fontWeight: '500' },
  copyButton: { minHeight: 44, minWidth: 80, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 5 },
  copyLabel: { fontSize: 12 },
  scroll: { padding: 13, minHeight: 47 },
  code: { fontFamily: 'Menlo', fontSize: 13, lineHeight: 21 },
});
