import type { UserMessage } from '@earendil-works/pi-ai';
import { turnsOf, type Turn } from '@pi-agent/infinichat/chat/turns';
import type { MemoryView } from '@pi-agent/infinichat/chat/types';
import type { ChatViewSource } from '@pi-agent/infinichat/pi/chat-view';
import { FlashList } from '@shopify/flash-list';
import { GlassView } from 'expo-glass-effect';
import { router } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { memo, useCallback, useMemo, useState, type ReactNode, type Ref } from 'react';
import {
  ActivityIndicator, PlatformColor, Pressable, StyleSheet, Text, View, type ScrollViewProps,
} from 'react-native';
import {
  KeyboardChatScrollView, KeyboardStickyView, type KeyboardChatScrollViewRef,
} from 'react-native-keyboard-controller';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useChatControls, useChatError, useChatMessages, useChatStatus } from '@/chat/chat-provider';
import { useChatColors } from '@/hooks/use-chat-colors';
import { useTranscriptScroll } from '@/hooks/use-transcript-scroll';
import { ChatIcon, type ChatIconName } from './icon';
import { TurnItem } from './turn-item';
import { AgentMark, useChatAgentName } from './agent';
import { ActionButton } from './primitives';

const suggestions: { icon: ChatIconName; title: string; detail: string; prompt: string }[] = [
  { icon: 'idea', title: 'Make something of an idea', detail: 'Find a starting point, together.', prompt: 'Help me think through an idea. Ask me a few questions to get started.' },
  { icon: 'pencil', title: 'Find the right words', detail: 'A first draft, a fresh perspective.', prompt: 'Help me write something clearly. First, ask what I am writing and who it is for.' },
  { icon: 'number', title: 'Work it out', detail: 'A little help with the numbers.',
    prompt: 'Help me work through a calculation step by step. First, ask what I need to figure out.' },
];

function EmptyConversation({ onChoose }: { onChoose: (text: string) => void }) {
  const colors = useChatColors();
  const agentName = useChatAgentName();
  return <View style={styles.empty}>
    <AgentMark size={56} />
    <Text style={[styles.emptyTitle, { color: colors.text }]}>Where shall we start?</Text>
    <Text style={[styles.emptyCaption, { color: colors.secondary }]}>Bring your questions. We’ll take it from here.</Text>
    <View style={styles.suggestions}>{suggestions.map((item, index) => <Pressable key={item.title} testID={`suggestion-${index}`} accessibilityRole="button" onPress={() => onChoose(item.prompt)}
      style={({ pressed }) => [styles.suggestion, { borderColor: colors.border, backgroundColor: pressed ? colors.subtle : colors.surface }]}>
      <View style={[styles.suggestionIcon, { backgroundColor: colors.accentSoft }]}><ChatIcon name={item.icon} color={colors.accent} size={18} /></View>
      <View style={styles.suggestionCopy}><Text style={[styles.suggestionTitle, { color: colors.text }]}>{item.title}</Text><Text style={[styles.suggestionDetail, { color: colors.muted }]}>{item.detail}</Text></View>
      <ChatIcon name="chevron" color={colors.muted} size={11} />
    </Pressable>)}</View>
    <Text style={[styles.disclaimer, { color: colors.muted }]}>
      {agentName} can make mistakes. Check important details.
    </Text>
  </View>;
}

const keyExtractor = (turn: Turn) => turn.id;
const NO_TURNS: readonly string[] = [];

/**
 * FlashList's chat setting, as its docs give it: the list opens on the newest message; near it, new and streaming
 * output scrolls into view; further up, the reader's position holds.
 */
const chatPosition = { autoscrollToBottomThreshold: 0.2, startRenderingFromBottom: true };

/**
 * The transcript's scroll view, following keyboard-controller's virtualized-list example: the library sets the insets
 * that lift content with the keyboard and the floating composer, so the system's automatic insets stay off and the
 * glass header and the tab bar become explicit insets. FlashList's ref reaches the scroll view through `props`.
 */
function ChatScrollView({ composerHeight, onEndVisible, ...props }: ScrollViewProps & {
  ref?: Ref<KeyboardChatScrollViewRef>;
  composerHeight: SharedValue<number>;
  onEndVisible: (visible: boolean) => void;
}) {
  const headerHeight = useHeaderHeight();
  const { bottom } = useSafeAreaInsets();
  // The header reports new heights after mount and while it shrinks on scroll; only the first one places the list.
  const [contentOffset] = useState(() => ({ x: 0, y: -headerHeight }));
  return <KeyboardChatScrollView {...props} automaticallyAdjustContentInsets={false}
    contentInsetAdjustmentBehavior="never" contentInset={{ top: headerHeight, bottom }}
    scrollIndicatorInsets={{ top: headerHeight, bottom }} contentOffset={contentOffset}
    offset={bottom} extraContentPadding={composerHeight} onEndVisible={onEndVisible} />;
}

/**
 * Only this subtree subscribes to text deltas. `memo` stays because the chat screen that renders it is not compiled
 * by React Compiler (it contains `try … finally`). The composer floats over the transcript and moves with the
 * keyboard. The thread is folded by turn (owner, 2026-10-29): the newest turn open, the earlier ones a header each
 * that opens on a tap, and a new turn the only open one again; `memory` gives each turn the model's lines for it.
 */
export const ChatTranscript = memo(function ChatTranscript({
  view, ready, stopping, onChoose, onSteerQueued, composer, memory,
}: {
  view: ChatViewSource | undefined; ready: boolean; stopping: boolean; onChoose: (text: string) => void;
  onSteerQueued?: (submissionId: number, content: UserMessage['content']) => void;
  composer: ReactNode;
  memory?: MemoryView;
}) {
  const colors = useChatColors();
  const agentName = useChatAgentName();
  const messages = useChatMessages(view);
  const controls = useChatControls(view);
  const busy = !!controls?.busy;
  const status = useChatStatus(view);
  const error = useChatError(view);
  const turns = useMemo(() => turnsOf(messages, memory), [messages, memory]);
  // The turns open: the newest alone whenever a new one begins, plus the ones the reader opened since.
  const newest = turns.at(-1)?.id;
  const [opened, setOpened] = useState<{ newest: string | undefined; open: readonly string[] }>(
    () => ({ newest, open: newest === undefined ? NO_TURNS : [newest] }));
  if (opened.newest !== newest) setOpened({ newest, open: newest === undefined ? NO_TURNS : [newest] });
  const toggle = (id: string) => setOpened((current) => ({
    ...current,
    open: current.open.includes(id) ? current.open.filter((other) => other !== id) : [...current.open, id],
  }));
  const renderTurn = ({ item }: { item: Turn }) =>
    <TurnItem turn={item} open={opened.open.includes(item.id)} onToggle={() => toggle(item.id)} stopping={stopping}
      onSteerQueued={onSteerQueued} />;
  const working = stopping ? 'Stopping…' : controls?.compacting ? 'Summarizing earlier messages…'
    : controls?.retrying ? 'Retrying…' : `${agentName} is thinking…`;
  const { listRef, onEndVisible, scrollToLatest, showScrollDown } = useTranscriptScroll();
  const composerHeight = useSharedValue(0);
  const { bottom } = useSafeAreaInsets();
  // FlashList renders this as a component, so it needs one identity for the life of the list.
  const renderScrollComponent = useCallback((props: ScrollViewProps) =>
    <ChatScrollView {...props} composerHeight={composerHeight} onEndVisible={onEndVisible} />,
  [composerHeight, onEndVisible]);
  const showWorking = controls?.compacting
    || (busy && !messages.some((message) => message.streaming || message.tool?.status === 'running'));
  const unavailable = status === 'missing' || status === 'failed' || (ready && !view);
  // FlashList starts from the newest message when it mounts with its data, so the list waits for the conversation.
  const placeholder = unavailable ? <View style={styles.loading}>
    <Text style={[styles.missingTitle, { color: colors.text }]}>Chat unavailable</Text>
    <Text style={[styles.loadingText, { color: colors.secondary }]}>{status === 'failed' && error
      ? error : 'This conversation may have been deleted.'}</Text>
    <ActionButton title="Back to chats" secondary onPress={() => router.replace('/chats')} />
  </View>
    : !ready || status === 'loading' ? <View style={styles.loading}><ActivityIndicator color={colors.accent} />
      <Text style={[styles.loadingText, { color: colors.muted }]}>Opening this conversation…</Text></View>
    : undefined;
  return <View style={styles.transcript}>
    {placeholder ?? <FlashList ref={listRef} testID="message-list" data={turns} keyExtractor={keyExtractor}
      renderItem={renderTurn} extraData={opened.open} renderScrollComponent={renderScrollComponent}
      maintainVisibleContentPosition={chatPosition}
      keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled" scrollEventThrottle={16}
      contentContainerStyle={[styles.messages, !messages.length && styles.grow]}
      ListEmptyComponent={<EmptyConversation onChoose={onChoose} />}
      ListFooterComponent={messages.length ? <View style={styles.working}>
        {showWorking && <><ActivityIndicator color={colors.accent} size="small" />
          <Text testID="conversation-working" style={[styles.workingText, { color: colors.secondary }]}>{working}</Text></>}
      </View> : undefined}
    />}
    <KeyboardStickyView offset={{ opened: bottom }} style={[styles.composer, { bottom }]}
      onLayout={(event) => composerHeight.set(event.nativeEvent.layout.height)}>
      {showScrollDown && <GlassView isInteractive style={styles.scrollDown}>
        <Pressable testID="scroll-to-latest" accessibilityRole="button" accessibilityLabel="Scroll to latest message"
          onPress={scrollToLatest} style={styles.scrollDownButton}>
          <ChatIcon name="arrowDown" color={PlatformColor('label')} size={19} />
        </Pressable>
      </GlassView>}
      {composer}
    </KeyboardStickyView>
  </View>;
});

const styles = StyleSheet.create({
  transcript: { flex: 1 },
  messages: { paddingHorizontal: 22, paddingTop: 20, paddingBottom: 18, maxWidth: 800, width: '100%', alignSelf: 'center' },
  grow: { flexGrow: 1 },
  composer: { position: 'absolute', left: 0, right: 0 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 24, paddingBottom: 24, gap: 16 },
  emptyTitle: { fontSize: 27, fontWeight: '500', letterSpacing: -0.8, marginTop: 7, textAlign: 'center' },
  emptyCaption: { fontSize: 14, lineHeight: 21, textAlign: 'center', maxWidth: 250 },
  suggestions: { width: '100%', maxWidth: 440, gap: 10, marginTop: 15 },
  suggestion: { flexDirection: 'row', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 13, gap: 12 },
  suggestionIcon: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  suggestionCopy: { flex: 1, gap: 5 },
  suggestionTitle: { fontSize: 13, fontWeight: '500' },
  suggestionDetail: { fontSize: 11 },
  disclaimer: { fontSize: 11, lineHeight: 16, textAlign: 'center', marginTop: 6 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 70, gap: 17 },
  loadingText: { fontSize: 14, textAlign: 'center' },
  missingTitle: { fontSize: 22, fontWeight: '600' },
  working: { height: 44, flexDirection: 'row', gap: 10, alignItems: 'center' },
  workingText: { fontSize: 13 },
  // Rests just above the composer, so it rises with it when the keyboard opens.
  scrollDown: { position: 'absolute', top: -52, alignSelf: 'center', width: 42, height: 42, borderRadius: 21 },
  scrollDownButton: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
