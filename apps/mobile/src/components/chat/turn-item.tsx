import type { UserMessage } from '@earendil-works/pi-ai';
import type { Turn } from '@pi-agent/infinichat/chat/turns';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useChatColors } from '@/hooks/use-chat-colors';
import { ChatIcon } from './icon';
import { MessageRow } from './message-row';

/** One line of a message, as the turn's header shows the input that opened it. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * A turn of the thread, folded (owner, 2026-10-29): a header with the input that opened it and the lines the model
 * holds for it right now, its memory of the turn; open, the turn in full under it: the message, the steps and the
 * reply. The Mac's `turn-row.tsx` is its counterpart.
 */
export function TurnItem({ turn, open, onToggle, stopping, onSteerQueued }: {
  turn: Turn; open: boolean; onToggle: () => void; stopping: boolean;
  onSteerQueued?: (submissionId: number, content: UserMessage['content']) => void;
}) {
  const colors = useChatColors();
  const opener = turn.opener;
  const title = opener === undefined ? 'Earlier'
    : oneLine(opener.text) || (opener.images?.length ? 'Photo' : 'Message');
  const steps = turn.rows.filter((row) => row.role === 'tool').length;
  return <View style={styles.turn}>
    <Pressable testID={`turn-${turn.id}`} accessibilityRole="button" accessibilityState={{ expanded: open }}
      accessibilityLabel={open ? `Collapse the turn: ${title}` : `Expand the turn: ${title}`} onPress={onToggle}
      style={({ pressed }) => [styles.header, { opacity: pressed ? 0.6 : 1 }]}>
      <View style={styles.chevron}><ChatIcon name={open ? 'down' : 'chevron'} color={colors.muted} size={12} /></View>
      <View style={styles.copy}>
        <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>
          {title}
          {steps > 0 ? <Text style={{ color: colors.muted }}>{`  ·  ${steps} ${steps === 1 ? 'step' : 'steps'}`}</Text>
            : null}
        </Text>
        {turn.lines.map((line, index) => <Text key={index} selectable
          style={[styles.memory, { color: colors.secondary }]}>
          {line.text}
          {line.shared > 1 ? <Text style={{ color: colors.muted }}>{`  ·  covers ${line.shared} turns`}</Text> : null}
        </Text>)}
      </View>
    </Pressable>
    {open ? turn.rows.map((message) => <MessageRow key={message.id} message={message}
      stopping={stopping && !!message.streaming} onSteerQueued={onSteerQueued} />) : null}
  </View>;
}

const styles = StyleSheet.create({
  turn: { paddingBottom: 6 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 10 },
  chevron: { width: 14, alignItems: 'center', marginTop: 4 },
  copy: { flex: 1, gap: 4 },
  title: { fontSize: 15, fontWeight: '500', lineHeight: 20 },
  memory: { fontSize: 13, lineHeight: 18 },
});
