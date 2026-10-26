import { Stack } from 'expo-router';

import { useStackScreenOptions } from '@/hooks/use-stack-screen-options';

/** Remote machines as a sheet with its own Stack, so adding or editing a machine pushes its form. */
export default function RemoteHostsLayout() {
  const screenOptions = useStackScreenOptions();
  return <Stack screenOptions={screenOptions}>
    <Stack.Screen name="index" options={{ title: 'Remote machines' }} />
    <Stack.Screen name="edit" options={{ title: 'Machine' }} />
  </Stack>;
}
