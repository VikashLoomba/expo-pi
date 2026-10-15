import { Stack } from 'expo-router';

import { useChatColors } from '@/hooks/use-chat-colors';

/** InfiniChat's own native Stack: a native tab shows a header only through a Stack nested in it. */
export default function InfiniChatLayout() {
  const colors = useChatColors();
  return (
    <Stack screenOptions={{
      headerStyle: { backgroundColor: colors.background },
      headerTintColor: colors.accent,
      headerTitleStyle: { color: colors.text, fontSize: 17, fontWeight: '600' },
      headerShadowVisible: false,
      headerBackButtonDisplayMode: 'minimal',
      contentStyle: { backgroundColor: colors.background },
    }}>
      <Stack.Screen name="index" options={{ title: 'InfiniChat' }} />
    </Stack>
  );
}
