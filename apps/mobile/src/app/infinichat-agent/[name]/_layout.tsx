import { router, Stack, useLocalSearchParams } from 'expo-router';

import { useAgentView, useChatApp, useChatControls, useChatError, useChatStatus } from '@/chat/chat-provider';
import { SettingsUnavailable } from '@/components/chat/settings-controls';
import { AgentModelDraftProvider } from '@/components/chat/settings-drafts';
import { useStackScreenOptions } from '@/hooks/use-stack-screen-options';

/** An agent's model as a sheet with its own Stack, so its model list pushes with the native back button. */
export default function AgentModelLayout() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const { error: appError } = useChatApp();
  const view = useAgentView(name);
  const conversation = useChatControls(view);
  const status = useChatStatus(view);
  const viewError = useChatError(view);
  const screenOptions = useStackScreenOptions();
  if (!conversation) {
    return <SettingsUnavailable loading={status === 'loading' && !appError}
      message={viewError || appError || 'This agent is not available.'} onClose={() => router.back()} />;
  }
  return <AgentModelDraftProvider key={name} name={name} initial={conversation.settings}>
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name="index" options={{ title: name }} />
      <Stack.Screen name="model" options={{ title: 'Model' }} />
    </Stack>
  </AgentModelDraftProvider>;
}
