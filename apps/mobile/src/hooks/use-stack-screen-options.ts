import type { NativeStackNavigationOptions } from 'expo-router/native-stack';
import { PlatformColor } from 'react-native';

import { useChatColors } from './use-chat-colors';

/** The app's header and screen options, for the root Stack and each tab's own Stack. */
export function useStackScreenOptions(): NativeStackNavigationOptions {
  const colors = useChatColors();
  return {
    // Bar buttons use the system label color, as Liquid Glass bars do; without a tint expo-router falls back to the
    // theme's primary color, which is the accent.
    headerTintColor: PlatformColor('label'),
    headerBackButtonDisplayMode: 'minimal',
    contentStyle: { backgroundColor: colors.background },
  };
}
