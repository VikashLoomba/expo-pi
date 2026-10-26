import { Stack } from 'expo-router';

import { useStackScreenOptions } from '@/hooks/use-stack-screen-options';

// A chat opened from a link has the chat list beneath it to go back to.
export const unstable_settings = { anchor: 'index' };

/** The Chats tab's own Stack: the chat list and the chats it opens. */
export default function ChatsLayout() {
  const screenOptions = useStackScreenOptions();
  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name="index" options={{ title: 'Chats' }} />
      <Stack.Screen name="chat/[id]" options={{ title: 'New chat' }} />
    </Stack>
  );
}
