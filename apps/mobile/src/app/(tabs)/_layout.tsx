import { NativeTabs } from 'expo-router/native-tabs';
import { DynamicColorIOS } from 'react-native';

import { chatPalettes } from '@/hooks/use-chat-colors';

// Liquid Glass picks light or dark from what lies beneath the tab bar, not from the color scheme, so the native
// side resolves the tint (Expo Router native tabs, "Customizing the icon color").
const tint = DynamicColorIOS({ light: chatPalettes.light.accent, dark: chatPalettes.dark.accent,
  highContrastLight: chatPalettes.lightContrast.accent, highContrastDark: chatPalettes.darkContrast.accent });

/**
 * The app's tabs: InfiniChat and the chats, each with its own Stack for its header and pushed screens. Neither tab
 * forces automatic insets on its first scroll view: the transcript's keyboard-controller list sets its own, and every
 * other list asks for automatic insets itself.
 */
export default function TabsLayout() {
  return (
    <NativeTabs tintColor={tint}>
      <NativeTabs.Trigger name="(infinichat)" disableAutomaticContentInsets>
        <NativeTabs.Trigger.Icon sf="infinity" />
        <NativeTabs.Trigger.Label>InfiniChat</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="chats" disableAutomaticContentInsets>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'bubble.left.and.bubble.right', selected: 'bubble.left.and.bubble.right.fill' }} />
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
