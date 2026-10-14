import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { ChatMessage } from '@/chat/types';
import { useChatColors } from '@/hooks/use-chat-colors';
import { ChatIcon } from './icon';
import { MessageImages } from './message-images';

export function ToolCard({ message }: { message: ChatMessage }) {
  const colors = useChatColors();
  const [expanded, setExpanded] = useState(false);
  const tool = message.tool;
  if (!tool) return null;
  const file = tool.file;
  const label = tool.name.replace(/_/g, ' ');
  const status = tool.status === 'running' ? 'Working' : tool.status === 'error' ? 'Failed' : 'Complete';
  return <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
    <Pressable testID={`tool-${message.id}`} accessibilityRole="button"
      accessibilityLabel={`${label}${file ? ` ${file.path}, ${file.summary}` : ''}, ${status}. ${expanded ? 'Hide' : 'Show'} details`}
      accessibilityState={{ expanded }} aria-expanded={expanded}
      onPress={() => setExpanded((value) => !value)} style={styles.header}>
      <View style={styles.icon}>{tool.status === 'running' ? <ActivityIndicator size="small" color={colors.accent} />
        : <ChatIcon name={tool.status === 'error' ? 'warning' : 'check'} color={tool.status === 'error' ? colors.danger : colors.accent} size={17} />}</View>
      <View style={styles.identity}>
        <Text numberOfLines={1} style={[styles.name, { color: colors.text }]}>{label}</Text>
        {file ? <Text numberOfLines={1} style={[styles.path, { color: colors.secondary }]}>{file.path}</Text> : null}
      </View>
      <Text style={[styles.status, { color: tool.status === 'error' ? colors.danger : colors.muted }]}>{status}</Text>
      <ChatIcon name={expanded ? 'down' : 'chevron'} color={colors.muted} size={12} />
    </Pressable>
    {expanded ? <View style={[styles.details, { borderTopColor: colors.border }]}>
      {file ? <>
        <Text selectable style={[styles.output, { color: colors.secondary }]}>{file.path}</Text>
        <Text style={[styles.summary, { color: colors.muted }]}>{file.summary}</Text>
      </> : tool.args ? <>
        <Text style={[styles.label, { color: colors.muted }]}>INPUT</Text>
        <Text selectable style={[styles.output, { color: colors.secondary }]}>{tool.args}</Text>
      </> : null}
      <Text style={[styles.label, { color: colors.muted }]}>RESULT</Text>
      {message.images?.length ? <MessageImages images={message.images} messageId={message.id} /> : null}
      {tool.output || !message.images?.length ? <Text selectable testID={`tool-output-${message.id}`} style={[styles.output, { color: colors.text }]}>
        {tool.output || (tool.status === 'running' ? 'Waiting for a result…' : 'No text output.')}
      </Text> : null}
      {file?.diff !== undefined ? <>
        <Text style={[styles.label, { color: colors.muted }]}>CHANGES{file.firstChangedLine ? ` · LINE ${file.firstChangedLine}` : ''}</Text>
        <Text selectable testID={`tool-diff-${message.id}`} style={[styles.output, { color: colors.text }]}>{file.diff}</Text>
      </> : null}
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 14, paddingVertical: 10, gap: 10 },
  icon: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  identity: { flex: 1, gap: 3 },
  name: { fontSize: 14, fontWeight: '500', textTransform: 'capitalize' },
  path: { fontSize: 12 },
  status: { fontSize: 11 },
  details: { borderTopWidth: StyleSheet.hairlineWidth, padding: 14, gap: 8 },
  label: { fontSize: 10, fontWeight: '600', letterSpacing: 1.1, marginTop: 4 },
  summary: { fontSize: 12 },
  output: { fontFamily: 'Menlo', fontSize: 12, lineHeight: 19 },
});
