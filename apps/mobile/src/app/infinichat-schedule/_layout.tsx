import { Stack } from 'expo-router';

import { useStackScreenOptions } from '@/hooks/use-stack-screen-options';

/** InfiniChat's scheduled tasks as a sheet with its own Stack, so editing a task pushes its form. */
export default function ScheduledTasksLayout() {
  const screenOptions = useStackScreenOptions();
  return <Stack screenOptions={screenOptions}>
    <Stack.Screen name="index" options={{ title: 'Scheduled tasks' }} />
    <Stack.Screen name="edit" options={{ title: 'Edit task' }} />
  </Stack>;
}
