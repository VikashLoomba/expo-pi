// Installs `crypto.getRandomValues` for Pi before any Pi module can run; side effect only.
import '@/pi/random-values';

import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { ChatProvider } from '@/chat/chat-provider';
import { useChatColors } from '@/hooks/use-chat-colors';
import { useStackScreenOptions } from '@/hooks/use-stack-screen-options';

// A modal opened from a link has the tabs beneath it to return to.
export const unstable_settings = { anchor: '(tabs)' };

/** The tabs, with the modals every tab opens presented above them. */
export default function RootLayout() {
  const colors = useChatColors();
  const screenOptions = useStackScreenOptions();
  const baseTheme = colors.dark ? DarkTheme : DefaultTheme;
  return (
    <ThemeProvider value={{ ...baseTheme, colors: { ...baseTheme.colors, primary: colors.accent,
      background: colors.background, card: colors.background, text: colors.text, border: colors.border } }}>
      <ChatProvider>
        <StatusBar style={colors.dark ? 'light' : 'dark'} />
        <Stack screenOptions={screenOptions}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="chat-settings/[id]" options={{ title: 'Chat settings', presentation: 'modal' }} />
          <Stack.Screen name="infinichat-settings" options={{ title: 'InfiniChat settings', presentation: 'modal' }} />
          <Stack.Screen name="remote-hosts" options={{ title: 'Remote machines', presentation: 'modal' }} />
          <Stack.Screen name="account" options={{ title: 'Account', presentation: 'modal' }} />
        </Stack>
      </ChatProvider>
    </ThemeProvider>
  );
}
