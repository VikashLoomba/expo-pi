import { GlassView } from 'expo-glass-effect';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { PlatformColor, Pressable, StyleSheet, Text, View } from 'react-native';

import { pendingQuestionsBanner } from '@pi-agent/infinichat/pi/infinichat/ask';

import {
  useAgentView, useChatApp, useChatControls, useInfiniChatAgents, useInfiniChatQuestions, useInfiniChatView,
} from '@/chat/chat-provider';
import { ChatAgentContext } from '@/components/chat/agent';
import { ChatIcon } from '@/components/chat/icon';
import { InlineNotice } from '@/components/chat/primitives';
import { ChatTranscript } from '@/components/chat/transcript';
import { useChatColors } from '@/hooks/use-chat-colors';

const TITLE = 'InfiniChat';
const noChoice = () => {};

export default function AgentRoute() {
  const { name } = useLocalSearchParams<{ name: string }>();
  // Another agent owns another transcript and scroll position.
  return <AgentScreen key={name} name={name} />;
}

/**
 * One agent's chat, as UniiChat's views show any unii's: its messages with its parent and what it did between them,
 * to read. The user stops its turn, continues a run that failed and picks its model here, and talks only to root, so
 * there is no composer.
 */
function AgentScreen({ name }: { name: string }) {
  const colors = useChatColors();
  const { infiniChat } = useChatApp();
  const view = useAgentView(name);
  const conversation = useChatControls(view);
  const rootName = useChatControls(useInfiniChatView())?.name || TITLE;
  const description = useInfiniChatAgents()?.find((each) => each.name === name)?.description;
  const pendingForAgent = (useInfiniChatQuestions() ?? []).filter((batch) => batch.agent === name);
  const agent = useMemo(() => ({ name, avatar: undefined }), [name]);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();
  const busy = !!conversation?.busy;
  const act = async (work: () => Promise<void>, failed: string) => {
    setError(undefined);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : failed);
    }
  };
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    await act(() => infiniChat.agent(name).stop(), 'Something went wrong. Please try again.');
    setStopping(false);
  };
  const failure = busy ? undefined : conversation?.runFailure;
  const openModel = () => router.push({ pathname: '/infinichat-agent/[name]', params: { name } });
  return <View testID="infinichat-agent-screen" style={[styles.screen, { backgroundColor: colors.background }]}>
    <Stack.Screen options={{ title: name,
      headerTitle: () => <Pressable testID="open-agent-model" accessibilityRole="button"
        accessibilityLabel={`${name}’s model`} accessibilityHint="Choose the model and reasoning effort it runs on."
        accessibilityState={{ disabled: !conversation }} disabled={!conversation} onPress={openModel}
        style={styles.headerTitle}>
        <Text numberOfLines={1} style={[styles.headerName, { color: PlatformColor('label') }]}>{name}</Text>
        <View style={styles.headerDetail}>
          <Text numberOfLines={1} style={[styles.headerSubtitle, { color: PlatformColor('secondaryLabel') }]}>
            {busy ? 'Working…' : description || 'Agent'}
          </Text>
          <ChatIcon name="down" color={PlatformColor('secondaryLabel')} size={9} />
        </View>
      </Pressable>,
    }} />
    <ChatAgentContext value={agent}><ChatTranscript view={view} ready stopping={stopping} onChoose={noChoice}
      composer={<View style={styles.bar}>
        {failure && <InlineNotice testID="agent-run-failure" message={failure.message}
          tone={failure.reason === 'aborted' ? 'neutral' : 'error'} action="Continue"
          onAction={() => { void act(() => infiniChat.agent(name).continue(),
            'The response could not continue. Try again.'); }} />}
        {error && <InlineNotice testID="agent-error" message={error} action="Dismiss"
          onAction={() => setError(undefined)} />}
        {pendingForAgent.length > 0 && <InlineNotice testID="agent-pending-questions" tone="neutral"
          message={pendingQuestionsBanner(pendingForAgent, rootName)}
          action="Answer" onAction={() => router.push({ pathname: '/infinichat-questions', params: { agent: name } })} />}
        <GlassView style={styles.note}>
          <Text style={[styles.noteText, { color: PlatformColor('secondaryLabel') }]}>
            Only {rootName} takes your messages. Ask it to tell {name}.
          </Text>
          {busy && <Pressable testID="stop-agent" accessibilityRole="button" accessibilityLabel={`Stop ${name}`}
            disabled={stopping} onPress={() => { void stop(); }}
            style={({ pressed }) => [styles.stop,
              { backgroundColor: colors.accent, opacity: pressed || stopping ? 0.6 : 1 }]}>
            <ChatIcon name="stop" color={colors.onAccent} size={13} />
          </Pressable>}
        </GlassView>
      </View>} /></ChatAgentContext>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  headerTitle: { alignItems: 'center', justifyContent: 'center', maxWidth: 230, minHeight: 44 },
  headerName: { fontSize: 15, fontWeight: '600' },
  headerDetail: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  headerSubtitle: { fontSize: 11, flexShrink: 1 },
  bar: { paddingHorizontal: 16, paddingTop: 5, paddingBottom: 8, gap: 8, maxWidth: 800, width: '100%',
    alignSelf: 'center' },
  note: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, borderRadius: 24, paddingLeft: 18,
    paddingRight: 8, paddingVertical: 8 },
  noteText: { flex: 1, fontSize: 13, lineHeight: 18 },
  stop: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
});
