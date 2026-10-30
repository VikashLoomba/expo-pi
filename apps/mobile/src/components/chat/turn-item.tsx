import type { UserMessage } from '@earendil-works/pi-ai';
import { blocksOf, type Turn } from '@pi-agent/infinichat/chat/turns';
import type { ChatMessage } from '@pi-agent/infinichat/chat/types';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useChatColors } from '@/hooks/use-chat-colors';
import { ChatIcon } from './icon';
import { MessageRow } from './message-row';

type OnSteerQueued = (submissionId: number, content: UserMessage['content']) => void;

const running = (row: ChatMessage): boolean => row.tool?.status === 'running'
  || (!!row.streaming && !row.text) || (row.webSearch?.calls.some((call) => call.status === 'running') ?? false);

/** The steps between a message and a reply, folded under a summary line that opens them with their turn. */
function StepsRun({ rows, open, onToggle, stopping, onSteerQueued }: {
  rows: readonly ChatMessage[]; open: boolean; onToggle: () => void; stopping: boolean; onSteerQueued?: OnSteerQueued;
}) {
  const colors = useChatColors();
  const busy = rows.some(running);
  const count = rows.length;
  const summary = `${busy ? 'Working' : 'Worked'} in ${count} ${count === 1 ? 'step' : 'steps'}`;
  return <View style={styles.run}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }}
      accessibilityLabel={open ? `Hide the steps: ${summary}` : `Show the steps: ${summary}`} onPress={onToggle}
      style={({ pressed }) => [styles.summary, { opacity: pressed ? 0.6 : 1 }]}>
      {busy ? <ActivityIndicator size="small" color={colors.accent} />
        : <ChatIcon name={open ? 'down' : 'chevron'} color={colors.muted} size={12} />}
      <Text style={[styles.summaryText, { color: colors.secondary }]}>{summary}</Text>
    </Pressable>
    {open ? <View style={[styles.steps, { borderLeftColor: colors.border }]}>
      {rows.map((row) => <MessageRow key={row.id} message={row} stopping={stopping && !!row.streaming}
        onSteerQueued={onSteerQueued} />)}
    </View> : null}
  </View>;
}

/**
 * A turn of the thread, folded (owner, 2026-10-29): the person's messages and the agent's replies as they are, the
 * steps between them a run each that opens on a tap and on nothing else; the summary line says when it works. The
 * Mac's `turn-row.tsx` is its counterpart.
 */
export function TurnItem({ turn, open, onToggle, stopping, onSteerQueued }: {
  turn: Turn; open: boolean; onToggle: () => void; stopping: boolean; onSteerQueued?: OnSteerQueued;
}) {
  return <View>
    {blocksOf(turn.rows).map((block) => block.kind === 'message'
      ? <MessageRow key={block.row.id} message={block.row} stopping={stopping && !!block.row.streaming}
        onSteerQueued={onSteerQueued} hideSteps />
      : <StepsRun key={block.id} rows={block.rows} open={open} onToggle={onToggle} stopping={stopping}
        onSteerQueued={onSteerQueued} />)}
  </View>;
}

const styles = StyleSheet.create({
  run: { paddingBottom: 12 },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  summaryText: { fontSize: 13, fontWeight: '500' },
  steps: { borderLeftWidth: StyleSheet.hairlineWidth, paddingLeft: 12, marginLeft: 5, marginTop: 4 },
});
