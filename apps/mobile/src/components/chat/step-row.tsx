import type { ChatMessage } from '@pi-agent/infinichat/chat/types';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useChatColors } from '@/hooks/use-chat-colors';
import { useChatAgentName } from './agent';
import { ChatIcon, type ChatIconName } from './icon';
import { MessageContent } from './message-content';
import { ToolCard } from './tool-card';
import { WebSearchActivity } from './web-search';

/** UniiChat's work message: "[Name]" and the report, without the zoom pointer for the model. */
const REPORT = /^\[([^\]\r\n]+)\]\s*([\s\S]*?)(?:\s*Full chat: zoom\("[^"\r\n]*"\))?\s*$/;

/**
 * A line of a run with something behind it, closed until the reader opens it (owner, 2026-10-29: nothing opens on
 * its own); a plain line while it has nothing to open.
 */
function StepLine({ testID, icon, label, running, children }: {
  testID?: string; icon: ChatIconName; label: string; running: boolean; children?: ReactNode;
}) {
  const colors = useChatColors();
  const [open, setOpen] = useState(false);
  return <View>
    <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ expanded: open, busy: running }}
      disabled={!children} onPress={() => setOpen(!open)} style={styles.line}>
      <View style={styles.mark}>{running ? <ActivityIndicator size="small" color={colors.accent} />
        : <ChatIcon name={icon} color={colors.muted} size={14} />}</View>
      <Text style={[styles.label, { color: colors.secondary }]}>{label}</Text>
      {children ? <ChatIcon name={open ? 'down' : 'chevron'} color={colors.muted} size={11} /> : null}
    </Pressable>
    {open ? children : null}
  </View>;
}

/**
 * One row of a steps run: a tool call, a notice, an agent's report, or a reply's own thinking and searches. The
 * reply's text is a message of its own after the run, so it is not here. The Mac's `StepRows` is its counterpart.
 */
export function StepRow({ message, stopping }: { message: ChatMessage; stopping: boolean }) {
  const colors = useChatColors();
  const agentName = useChatAgentName();
  if (message.role === 'tool' && message.tool) return <ToolCard message={message} />;
  if (message.role === 'notice') {
    return <Text selectable testID={`message-${message.id}`} style={[styles.notice, { color: colors.secondary }]}>
      {message.text}
    </Text>;
  }
  const streaming = !!message.streaming;
  if (message.role === 'work') {
    const report = REPORT.exec(message.text);
    const author = report?.[1] ?? agentName;
    return <StepLine testID={`report-${message.id}`} icon="message" running={streaming}
      label={streaming ? `${author} is working` : `${author} reported`}>
      <View style={styles.report}><MessageContent text={report?.[2] ?? message.text} streaming={streaming} /></View>
    </StepLine>;
  }
  const waiting = streaming && !message.text;
  return <>
    {message.thinking ? <StepLine testID={`thinking-${message.id}`} icon="spark" running={waiting}
      label={waiting ? 'Thinking' : 'Thought'}>
      <Text selectable style={[styles.thinking, { color: colors.secondary, borderLeftColor: colors.border }]}>
        {message.thinking}
      </Text>
    </StepLine> : null}
    {message.webSearch ? <WebSearchActivity calls={message.webSearch.calls} messageId={message.id} /> : null}
    {!message.thinking && !message.webSearch && waiting
      ? <StepLine icon="spark" label="Thinking" running={!stopping} /> : null}
  </>;
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 32, alignSelf: 'flex-start' },
  // The spinner is wider than the icon it stands in for, so both sit in one slot and the label stays put.
  mark: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 13 },
  thinking: { fontSize: 14, lineHeight: 21, borderLeftWidth: 2, paddingLeft: 12, marginVertical: 8 },
  report: { paddingVertical: 8 },
  notice: { fontSize: 13, lineHeight: 20, textAlign: 'center', paddingHorizontal: 14, paddingVertical: 8 },
});
