import { router, Stack } from 'expo-router';

import {
  useChatApp, useChatControls, useChatError, useChatStatus, useInfiniChatAvatar, useInfiniChatView,
} from '@/chat/chat-provider';
import { SettingsUnavailable } from '@/components/chat/settings-controls';
import { InfiniChatSettingsDraftProvider } from '@/components/chat/settings-drafts';
import { useStackScreenOptions } from '@/hooks/use-stack-screen-options';
import type { ChatModelSettings } from '@/pi/model-catalog';

/** OptChat has no default model; an unchosen one is shown as such until the user picks it. */
const unchosen: ChatModelSettings = { model: { provider: '', modelId: '' }, thinkingLevel: 'off' };

/** InfiniChat's settings as a sheet with its own Stack, so its model lists push with the native back button. */
export default function InfiniChatSettingsLayout() {
  const { error: appError } = useChatApp();
  const view = useInfiniChatView();
  const conversation = useChatControls(view);
  const status = useChatStatus(view);
  const viewError = useChatError(view);
  const avatar = useInfiniChatAvatar();
  const screenOptions = useStackScreenOptions();
  if (!conversation) {
    return <SettingsUnavailable loading={status === 'loading' && !appError}
      message={viewError || appError || 'InfiniChat is not available.'} onClose={() => router.back()} />;
  }
  return <InfiniChatSettingsDraftProvider view={view} initial={{ main: conversation.settings,
    summary: conversation.summary ?? unchosen, instructions: conversation.instructions, name: conversation.name,
    avatar }}>
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name="index" options={{ title: 'InfiniChat settings' }} />
      <Stack.Screen name="model" options={{ title: 'Model' }} />
    </Stack>
  </InfiniChatSettingsDraftProvider>;
}
