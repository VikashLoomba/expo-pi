import { Stack } from 'expo-router';

import { useStackScreenOptions } from '@/hooks/use-stack-screen-options';

/**
 * InfiniChat's own native Stack: a native tab shows a header only through a Stack nested in it. An agent's chat pushes
 * over root's.
 */
export default function InfiniChatLayout() {
  const screenOptions = useStackScreenOptions();
  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name="index" options={{ title: 'InfiniChat' }} />
      <Stack.Screen name="agent/[name]" />
    </Stack>
  );
}
