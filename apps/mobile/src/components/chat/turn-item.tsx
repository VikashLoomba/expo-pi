import type { UserMessage } from '@earendil-works/pi-ai';
import { blocksOf, type Turn } from '@pi-agent/infinichat/chat/turns';
import type { ChatMessage } from '@pi-agent/infinichat/chat/types';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useChatColors } from '@/hooks/use-chat-colors';
import { ChatIcon } from './icon';
import { MessageRow } from './message-row';

type OnSteerQueued = (submissionId: number, content: UserMessage['content']) => void;
type History = NonNullable<ChatMessage['history']>;
/** Loads the entries a history row stands for: `ChatViewSource`'s `loadEarlier` or `fillGap`. */
export type OnLoadHistory = (history: History) => Promise<void>;

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
 * Transcript this phone has not loaded, as pi-durable's `ConversationTranscript` marks it: earlier messages above the
 * oldest one held, or messages missed in between. It loads once FlashList renders it, near the viewport, as the
 * transcript's README has a client load such a row when it scrolls into view; a failure offers a retry. A page that
 * leaves more makes a row with a new ID, which loads again while it is near.
 */
function HistoryRow({ id, history, onLoad }: { id: string; history: History; onLoad: OnLoadHistory }) {
  const colors = useChatColors();
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState<string>();
  const after = history.kind === 'gap' ? history.after : undefined;
  const upTo = history.kind === 'gap' ? history.upTo : undefined;
  // FlashList recycles a row's component for another row, so the row's ID is part of what starts a load.
  useEffect(() => {
    let current = true;
    const target: History = after === undefined || upTo === undefined
      ? { kind: 'earlier' } : { kind: 'gap', after, upTo };
    onLoad(target).catch(() => {
      if (current) setFailed(id);
    });
    return () => {
      current = false;
    };
  }, [id, after, upTo, attempt, onLoad]);
  const what = history.kind === 'earlier' ? 'earlier messages' : 'these messages';
  if (failed === id) {
    return <Pressable accessibilityRole="button" onPress={() => {
      setFailed(undefined);
      setAttempt((count) => count + 1);
    }} style={styles.history}>
      <Text style={[styles.historyText, { color: colors.secondary }]}>Couldn’t load {what}. </Text>
      <Text style={[styles.historyText, { color: colors.accent }]}>Try Again</Text>
    </Pressable>;
  }
  return <View style={styles.history} accessibilityLabel={`Loading ${what}`}>
    <ActivityIndicator size="small" color={colors.accent} />
    <Text style={[styles.historyText, { color: colors.muted }]}>Loading {what}…</Text>
  </View>;
}

/**
 * A turn of the thread, folded (owner, 2026-10-29): the person's messages and the agent's replies as they are, the
 * steps between them a run each that opens on a tap and on nothing else; the summary line says when it works. The
 * Mac's `turn-row.tsx` is its counterpart.
 */
export function TurnItem({ turn, open, onToggle, stopping, onSteerQueued, onLoadHistory }: {
  turn: Turn; open: boolean; onToggle: () => void; stopping: boolean; onSteerQueued?: OnSteerQueued;
  onLoadHistory: OnLoadHistory;
}) {
  if (turn.history) return <HistoryRow id={turn.id} history={turn.history} onLoad={onLoadHistory} />;
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
  history: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 44 },
  historyText: { fontSize: 13 },
});
