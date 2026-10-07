import * as Clipboard from 'expo-clipboard';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import type { ChatMessage } from '@/chat/types';
import { useChatColors } from '@/hooks/use-chat-colors';
import { ChatIcon } from './icon';
import { MessageContent } from './message-content';
import { PiMark } from './primitives';
import { ToolCard } from './tool-card';
import { WebSearchActivity, WebSearchSources } from './web-search';
import { collectSearchSources, inlineCitations } from './web-search-presentation';

export const MessageRow = memo(function MessageRow({ message, stopping = false }: {
  message: ChatMessage; stopping?: boolean;
}) {
  const colors = useChatColors();
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const sources = useMemo(() => message.webSearch ? collectSearchSources(message.webSearch) : [], [message.webSearch]);
  const citations = useMemo(() => inlineCitations(message.text, message.webSearch?.citations ?? [], sources), [message.text, message.webSearch, sources]);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timeout.current), []);
  const copy = async () => {
    try {
      if (!await Clipboard.setStringAsync(message.text)) throw new Error('Clipboard unavailable');
      setCopied(true);
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setCopied(false), 2000);
    } catch { Alert.alert('Could not copy', 'You can select the message and copy it manually.'); }
  };
  if (message.role === 'tool' && message.tool) return <View style={styles.toolWrapper}><ToolCard message={message} /></View>;
  if (message.role === 'notice') return <Text selectable testID={`message-${message.id}`} style={[styles.notice, { color: colors.secondary }]}>{message.text}</Text>;
  if (message.role === 'user') return <View style={styles.userRow}>
    <View style={[styles.userBubble, { backgroundColor: colors.user }]}>
      <Text testID={`message-${message.id}`} selectable style={[styles.userText, { color: colors.text }]}>{message.text}</Text>
    </View>
  </View>;
  return <View testID={`message-${message.id}`} style={styles.assistant}>
    <View style={styles.assistantIdentity}>
      <PiMark size={25} />
      <Text style={[styles.assistantName, { color: colors.secondary }]}>Pi</Text>
      <Text numberOfLines={1} style={[styles.streamingLabel, { color: colors.muted }]}>
        {message.streaming ? stopping ? 'Stopping…' : 'Responding' : message.interrupted ? 'Interrupted' : ' '}
      </Text>
    </View>
    {message.webSearch ? <WebSearchActivity calls={message.webSearch.calls} messageId={message.id} /> : null}
    {message.thinking ? <View>
      <Pressable testID={`thinking-${message.id}`} accessibilityRole="button" accessibilityState={{ expanded: thinkingExpanded }} onPress={() => setThinkingExpanded(!thinkingExpanded)} style={styles.thinkingHeader}>
        <ChatIcon name="spark" color={colors.muted} size={14} />
        <Text style={[styles.thinkingLabel, { color: colors.secondary }]}>Thinking</Text>
        <ChatIcon name={thinkingExpanded ? 'down' : 'chevron'} color={colors.muted} size={11} />
      </Pressable>
      {thinkingExpanded && <Text selectable style={[styles.thinkingText, { color: colors.secondary, borderLeftColor: colors.border }]}>{message.thinking}</Text>}
    </View> : null}
    {message.text ? <MessageContent text={message.text} streaming={message.streaming} citations={citations} />
      : message.streaming && !message.webSearch?.calls.some((call) => call.status === 'running')
        ? <View style={styles.waiting}><ActivityIndicator size="small" color={colors.accent} /></View> : null}
    <WebSearchSources sources={sources} messageId={message.id} />
    {message.error ? <Text selectable style={[styles.messageError, { color: colors.danger }]}>{message.error}</Text> : null}
    <Pressable testID={`copy-${message.id}`} accessibilityRole="button" accessibilityLabel={copied ? 'Message copied' : 'Copy message'}
      disabled={!message.text} accessibilityElementsHidden={!message.text} importantForAccessibility={message.text ? 'auto' : 'no-hide-descendants'}
      onPress={() => { void copy(); }} style={[styles.copyButton, { opacity: message.text ? 1 : 0 }]}>
      <ChatIcon name={copied ? 'check' : 'copy'} color={colors.muted} size={16} />
      <Text style={[styles.copiedLabel, { color: colors.muted }]}>{copied ? 'Copied' : ' '}</Text>
    </Pressable>
  </View>;
});

const styles = StyleSheet.create({
  userRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingTop: 10, paddingBottom: 21 },
  userBubble: { maxWidth: '88%', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 22, borderBottomRightRadius: 7 },
  userText: { fontSize: 16, lineHeight: 24 },
  assistant: { paddingVertical: 6, paddingBottom: 17, gap: 13 },
  assistantIdentity: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  assistantName: { fontSize: 13, fontWeight: '600' },
  streamingLabel: { flex: 1, fontSize: 12 },
  waiting: { height: 25, alignItems: 'flex-start', justifyContent: 'center' },
  copyButton: { minHeight: 36, minWidth: 82, flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6 },
  copiedLabel: { fontSize: 12 },
  thinkingHeader: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 32, alignSelf: 'flex-start' },
  thinkingLabel: { fontSize: 13 },
  thinkingText: { fontSize: 14, lineHeight: 21, borderLeftWidth: 2, paddingLeft: 12, marginVertical: 8 },
  messageError: { fontSize: 14, lineHeight: 21 },
  notice: { fontSize: 13, lineHeight: 20, textAlign: 'center', paddingHorizontal: 14, paddingVertical: 18 },
  toolWrapper: { paddingBottom: 16 },
});
