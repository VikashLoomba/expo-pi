import type { UserMessage } from '@earendil-works/pi-ai';
import type { SubmissionId } from '@earendil-works/pi-durable';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import type { ChatMessage } from '@/chat/types';
import { useChatColors } from '@/hooks/use-chat-colors';
import { userInput } from '@/pi/user-input';
import { ChatIcon } from './icon';
import { MessageContent } from './message-content';
import { MessageImages } from './message-images';
import { PiMark } from './primitives';
import { ToolCard } from './tool-card';
import { WebSearchActivity, WebSearchSources } from './web-search';
import { collectSearchSources } from './web-search-presentation';

export function MessageRow({ message, stopping = false, onSteerQueued }: {
  message: ChatMessage; stopping?: boolean;
  onSteerQueued?: (submissionId: SubmissionId, content: UserMessage['content']) => void;
}) {
  const colors = useChatColors();
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [steering, setSteering] = useState(false);
  const sources = message.webSearch ? collectSearchSources(message.webSearch) : [];
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
  const steer = async () => {
    if (message.queued?.mode !== 'followUp' || !onSteerQueued || steering) return;
    setSteering(true);
    try { await onSteerQueued(message.queued.submissionId, userInput(message.text, message.images ?? [])); }
    finally { setSteering(false); }
  };
  const userBubble = <View style={[styles.userBubble, { backgroundColor: colors.user }]}>
    {message.images?.length ? <MessageImages images={message.images} messageId={message.id} /> : null}
    {message.text ? <Text testID={`message-${message.id}`} selectable style={[styles.userText, { color: colors.text }]}>{message.text}</Text> : null}
  </View>;
  if (message.role === 'tool' && message.tool) return <View style={styles.toolWrapper}><ToolCard message={message} /></View>;
  if (message.role === 'notice') return <Text selectable testID={`message-${message.id}`} style={[styles.notice, { color: colors.secondary }]}>{message.text}</Text>;
  if (message.role === 'user' && message.queued) return <View style={styles.userQueuedRow}>
    {userBubble}
    <View style={styles.queuedMeta}>
      <Text style={[styles.queuedMetaText, { color: colors.muted }]}>
        {message.queued.mode === 'steer' ? 'Queued · steer'
          : message.queued.mode === 'followUp' ? 'Queued · follow-up' : 'Queued'}
      </Text>
      {message.queued.mode === 'followUp' && onSteerQueued ? <Pressable testID={`steer-${message.id}`}
        accessibilityRole="button" accessibilityLabel="Send as steer" disabled={steering}
        onPress={() => { void steer(); }} style={[styles.steerAction, { opacity: steering ? 0.5 : 1 }]}>
        <Text style={[styles.steerActionText, { color: colors.accent }]}>Send as steer</Text>
      </Pressable> : null}
    </View>
  </View>;
  if (message.role === 'user') return <View style={styles.userRow}>{userBubble}</View>;
  // An agent's report is UniiChat's work message, "[Name]" and its text: the name heads the row and the text is its
  // body, without the zoom pointer for the model, as UniiChat's `report_read` shows one.
  const report = message.role === 'work'
    ? /^\[([^\]\r\n]+)\]\s*([\s\S]*?)(?:\s*Full chat: zoom\("[^"\r\n]*"\))?\s*$/.exec(message.text)
    : null;
  const author = report?.[1] ?? 'Pi';
  const body = report?.[2] ?? message.text;
  return <View testID={`message-${message.id}`} style={styles.assistant}>
    <View style={styles.assistantIdentity}>
      <PiMark size={25} />
      <Text style={[styles.assistantName, { color: colors.secondary }]}>{author}</Text>
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
    {body ? <MessageContent text={body} streaming={message.streaming} />
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
}

const styles = StyleSheet.create({
  userRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingTop: 10, paddingBottom: 21 },
  userQueuedRow: { alignItems: 'flex-end', paddingTop: 10, paddingBottom: 21 },
  userBubble: { maxWidth: '88%', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 22, borderBottomRightRadius: 7, gap: 10 },
  queuedMeta: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
  queuedMetaText: { fontSize: 12 },
  steerAction: { minHeight: 32, justifyContent: 'center' },
  steerActionText: { fontSize: 12, fontWeight: '500' },
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
