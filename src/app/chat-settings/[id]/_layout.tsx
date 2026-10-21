import { router, Stack, useLocalSearchParams } from 'expo-router';

import { useChatApp, useChatControls, useChatId, useChatStatus, useChatView } from '@/chat/chat-provider';
import { SettingsUnavailable } from '@/components/chat/settings-controls';
import { ChatSettingsDraftProvider } from '@/components/chat/settings-drafts';
import { useStackScreenOptions } from '@/hooks/use-stack-screen-options';

/** Chat settings as a sheet with its own Stack, so its pickers push with the native back button. */
export default function ChatSettingsLayout() {
  const { id: routeId } = useLocalSearchParams<{ id: string }>();
  const id = useChatId(routeId);
  const { ready, error: appError } = useChatApp();
  const view = useChatView(id);
  const conversation = useChatControls(view);
  const status = useChatStatus(view);
  const screenOptions = useStackScreenOptions();
  if (!conversation || id === undefined) {
    return <SettingsUnavailable loading={(!ready || status === 'loading') && !appError && id !== undefined}
      message={appError || 'This chat is no longer available.'} onClose={() => router.back()} />;
  }
  return <ChatSettingsDraftProvider key={id} id={id} view={view}
    initial={{ settings: conversation.settings, execution: conversation.execution }}>
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name="index" options={{ title: 'Chat settings' }} />
      <Stack.Screen name="model" options={{ title: 'Model' }} />
      <Stack.Screen name="directory" options={{ title: 'Folders' }} />
    </Stack>
  </ChatSettingsDraftProvider>;
}
