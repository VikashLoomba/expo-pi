import type { NativeStackNavigationOptions } from 'expo-router/native-stack';

import { useChatColors } from './use-chat-colors';

/** The app's header and screen colors, for the root Stack and each tab's own Stack. */
export function useStackScreenOptions(): NativeStackNavigationOptions {
  const colors = useChatColors();
  return {
    headerStyle: { backgroundColor: colors.background },
    headerTintColor: colors.accent,
    headerTitleStyle: { color: colors.text, fontSize: 17, fontWeight: '600' },
    headerShadowVisible: false,
    headerBackButtonDisplayMode: 'minimal',
    contentStyle: { backgroundColor: colors.background },
  };
}
