import { router } from 'expo-router';
import { memo, useImperativeHandle, type Ref } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { useChatConversation } from '@/chat/chat-provider';
import type { ChatMessage } from '@/chat/types';
import { useChatColors } from '@/hooks/use-chat-colors';
import { useTranscriptScroll } from '@/hooks/use-transcript-scroll';
import { ChatIcon, type ChatIconName } from './icon';
import { MessageRow } from './message-row';
import { ActionButton, PiMark } from './primitives';

const suggestions: { icon: ChatIconName; title: string; detail: string; prompt: string }[] = [
  { icon: 'idea', title: 'Make something of an idea', detail: 'Find a starting point, together.', prompt: 'Help me think through an idea. Ask me a few questions to get started.' },
  { icon: 'pencil', title: 'Find the right words', detail: 'A first draft, a fresh perspective.', prompt: 'Help me write something clearly. First, ask what I am writing and who it is for.' },
  { icon: 'number', title: 'Work it out', detail: 'A little help with the numbers.', prompt: 'Use add_numbers to add 19 and 23, then explain the result in one sentence.' },
];

function EmptyConversation({ onChoose }: { onChoose: (text: string) => void }) {
  const colors = useChatColors();
  return <View style={styles.empty}>
    <PiMark size={56} />
    <Text style={[styles.emptyTitle, { color: colors.text }]}>Where shall we start?</Text>
    <Text style={[styles.emptyCaption, { color: colors.secondary }]}>Bring your questions. We’ll take it from here.</Text>
    <View style={styles.suggestions}>{suggestions.map((item, index) => <Pressable key={item.title} testID={`suggestion-${index}`} accessibilityRole="button" onPress={() => onChoose(item.prompt)}
      style={({ pressed }) => [styles.suggestion, { borderColor: colors.border, backgroundColor: pressed ? colors.subtle : colors.surface }]}>
      <View style={[styles.suggestionIcon, { backgroundColor: colors.accentSoft }]}><ChatIcon name={item.icon} color={colors.accent} size={18} /></View>
      <View style={styles.suggestionCopy}><Text style={[styles.suggestionTitle, { color: colors.text }]}>{item.title}</Text><Text style={[styles.suggestionDetail, { color: colors.muted }]}>{item.detail}</Text></View>
      <ChatIcon name="chevron" color={colors.muted} size={11} />
    </Pressable>)}</View>
  </View>;
}

const keyExtractor = (message: ChatMessage) => message.id;
const renderMessage = ({ item }: { item: ChatMessage }) => <MessageRow message={item} />;

export interface ChatTranscriptHandle { scrollToLatest: () => void }

/** Only this subtree subscribes to text deltas. Header, composer and history rows stay still. */
export const ChatTranscript = memo(function ChatTranscript({ id, ready, onChoose, ref }: {
  id: string; ready: boolean; onChoose: (text: string) => void; ref: Ref<ChatTranscriptHandle>;
}) {
  const colors = useChatColors();
  const { conversation } = useChatConversation(id);
  const { list, onScroll, onContentSizeChange, onLayout, scrollToLatest, showScrollDown } = useTranscriptScroll();
  useImperativeHandle(ref, () => ({ scrollToLatest }), [scrollToLatest]);
  const messages = conversation?.messages ?? [];
  const showWorking = !!conversation?.busy && !messages.some((message) => message.streaming || message.tool?.status === 'running');
  if (!messages.length) return <View style={styles.transcript}>
    {!ready ? <View style={styles.loading}><ActivityIndicator color={colors.accent} /><Text style={[styles.loadingText, { color: colors.muted }]}>Opening this conversation…</Text></View>
      : !conversation ? <View style={styles.loading}><Text style={[styles.missingTitle, { color: colors.text }]}>Chat unavailable</Text><Text style={[styles.loadingText, { color: colors.secondary }]}>This conversation may have been archived.</Text><ActionButton title="Back to chats" secondary onPress={() => router.replace('/')} /></View>
      : <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.emptyMessages}><EmptyConversation onChoose={onChoose} /></ScrollView>}
  </View>;
  return <View style={styles.transcript}>
    <Animated.FlatList ref={list} testID="message-list" data={messages} keyExtractor={keyExtractor} renderItem={renderMessage}
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} keyboardShouldPersistTaps="handled"
      scrollEventThrottle={16} initialNumToRender={20} contentContainerStyle={styles.messages}
      onScroll={onScroll} onContentSizeChange={onContentSizeChange} onLayout={onLayout}
      ListFooterComponent={<View style={styles.working}>
        {showWorking && <><ActivityIndicator color={colors.accent} size="small" /><Text style={[styles.workingText, { color: colors.secondary }]}>Pi is thinking…</Text></>}
      </View>}
    />
    {showScrollDown && <Pressable testID="scroll-to-latest" accessibilityRole="button" accessibilityLabel="Scroll to latest message" onPress={scrollToLatest}
      style={[styles.scrollDown, { backgroundColor: colors.surface, borderColor: colors.border }]}><ChatIcon name="arrowDown" color={colors.accent} size={19} /></Pressable>}
  </View>;
});

const styles = StyleSheet.create({
  transcript: { flex: 1 },
  messages: { paddingHorizontal: 22, paddingTop: 20, paddingBottom: 18, maxWidth: 800, width: '100%', alignSelf: 'center' },
  emptyMessages: { flexGrow: 1, paddingHorizontal: 22 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 24, paddingBottom: 24, gap: 16 },
  emptyTitle: { fontSize: 27, fontWeight: '500', letterSpacing: -0.8, marginTop: 7, textAlign: 'center' },
  emptyCaption: { fontSize: 14, lineHeight: 21, textAlign: 'center', maxWidth: 250 },
  suggestions: { width: '100%', maxWidth: 440, gap: 10, marginTop: 15 },
  suggestion: { flexDirection: 'row', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 13, gap: 12 },
  suggestionIcon: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  suggestionCopy: { flex: 1, gap: 5 },
  suggestionTitle: { fontSize: 13, fontWeight: '500' },
  suggestionDetail: { fontSize: 11 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 70, gap: 17 },
  loadingText: { fontSize: 14, textAlign: 'center' },
  missingTitle: { fontSize: 22, fontWeight: '600' },
  working: { height: 44, flexDirection: 'row', gap: 10, alignItems: 'center' },
  workingText: { fontSize: 13 },
  scrollDown: { position: 'absolute', bottom: 10, alignSelf: 'center', width: 42, height: 42, borderWidth: 1, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
});
