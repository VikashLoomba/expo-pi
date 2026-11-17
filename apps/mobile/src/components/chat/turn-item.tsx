import type { UserMessage } from '@earendil-works/pi-ai';
import { blocksOf, type Turn } from '@pi-agent/infinichat/chat/turns';
import type { ChatMessage } from '@pi-agent/infinichat/chat/types';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useChatColors } from '@/hooks/use-chat-colors';
import { ChatIcon } from './icon';
import { MessageRow } from './message-row';
import { StepRow } from './step-row';

type OnSteerQueued = (submissionId: number, content: UserMessage['content']) => void;
type History = NonNullable<ChatMessage['history']>;
/** Loads the entries a history row stands for: `ChatViewSource`'s `loadEarlier` or `fillGap`. */
export type OnLoadHistory = (history: History) => Promise<void>;

const running = (row: ChatMessage): boolean => row.tool?.status === 'running'
  || (!!row.streaming && !row.text) || (row.webSearch?.calls.some((call) => call.status === 'running') ?? false);

/** Where a run is in its turn's row, as laid out when the reader taps it. */
export type RunFrame = { top: number; height: number };

/**
 * The steps between a message and a reply, folded under a summary line that opens them. The line says when the run
 * works and, by its chevron, whether it is open; the tap reports where the run is in its turn's row, which the
 * transcript needs to bring the opened steps into view.
 */
function StepsRun({ id, rows, open, onToggle, stopping }: {
  id: string; rows: readonly ChatMessage[]; open: boolean; onToggle: (frame: RunFrame) => void; stopping: boolean;
}) {
  const colors = useChatColors();
  const frame = useRef<RunFrame>({ top: 0, height: 0 });
  const busy = rows.some(running);
  const count = rows.length;
  const summary = `${busy ? 'Working' : 'Worked'} in ${count} ${count === 1 ? 'step' : 'steps'}`;
  return <View style={styles.run} onLayout={({ nativeEvent: { layout } }) => {
    frame.current = { top: layout.y, height: layout.height };
  }}>
    <Pressable testID={`run-${id}`} accessibilityRole="button" accessibilityState={{ expanded: open, busy }}
      accessibilityLabel={open ? `Hide the steps: ${summary}` : `Show the steps: ${summary}`}
      onPress={() => onToggle(frame.current)} style={({ pressed }) => [styles.summary, { opacity: pressed ? 0.6 : 1 }]}>
      {busy ? <ActivityIndicator size="small" color={colors.accent} /> : null}
      <Text style={[styles.summaryText, { color: colors.secondary }]}>{summary}</Text>
      <ChatIcon name={open ? 'down' : 'chevron'} color={colors.muted} size={12} />
    </Pressable>
    {open ? <View style={[styles.steps, { borderLeftColor: colors.border }]}>
      {rows.map((row) => <StepRow key={row.id} message={row} stopping={stopping} />)}
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
 * steps between them a run each that opens on a tap and on nothing else; the summary line says when it works. A tap
 * opens the run it is on and no other (owner, 2026-11-17): the turn's other runs are above it in the same row, and
 * opening them too would move the line from under the finger. The Mac's `turn-row.tsx` is its counterpart.
 */
export function TurnItem({ turn, open, onToggle, stopping, onSteerQueued, onLoadHistory }: {
  turn: Turn; open: readonly string[]; onToggle: (run: string, frame: RunFrame) => void; stopping: boolean;
  onSteerQueued?: OnSteerQueued; onLoadHistory: OnLoadHistory;
}) {
  if (turn.history) return <HistoryRow id={turn.id} history={turn.history} onLoad={onLoadHistory} />;
  return <View>
    {blocksOf(turn.rows).map((block) => {
      if (block.kind === 'message') {
        return <MessageRow key={block.row.id} message={block.row} stopping={stopping && !!block.row.streaming}
          onSteerQueued={onSteerQueued} />;
      }
      const run = `${turn.id}/${block.id}`;
      return <StepsRun key={block.id} id={run} rows={block.rows} open={open.includes(run)}
        onToggle={(frame) => onToggle(run, frame)} stopping={stopping} />;
    })}
  </View>;
}

const styles = StyleSheet.create({
  run: { paddingBottom: 12 },
  // As tall as the spinner makes it, so the line keeps its height when the run stops working.
  summary: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 },
  summaryText: { fontSize: 13, fontWeight: '500' },
  steps: { borderLeftWidth: StyleSheet.hairlineWidth, paddingLeft: 12, marginLeft: 5, marginTop: 4, gap: 8 },
  history: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 44 },
  historyText: { fontSize: 13 },
});
