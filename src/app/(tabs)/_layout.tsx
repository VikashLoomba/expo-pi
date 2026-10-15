import { NativeTabs } from 'expo-router/native-tabs';

import { useChatColors } from '@/hooks/use-chat-colors';

/** The app's tabs: the chats and InfiniChat, each with its own Stack for its header and pushed screens. */
export default function TabsLayout() {
  const colors = useChatColors();
  return (
    <NativeTabs tintColor={colors.accent}>
      <NativeTabs.Trigger name="(chats)">
        <NativeTabs.Trigger.Icon
          sf={{ default: 'bubble.left.and.bubble.right', selected: 'bubble.left.and.bubble.right.fill' }} />
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="infinichat">
        <NativeTabs.Trigger.Icon sf="infinity" />
        <NativeTabs.Trigger.Label>InfiniChat</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
