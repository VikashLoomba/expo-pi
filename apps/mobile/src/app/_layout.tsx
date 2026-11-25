// Installs `crypto.getRandomValues` for Pi before any Pi module can run; side effect only.
import '@/pi/random-values';
// Installs the compression streams Chord's session sync moves InfiniChat's conversation with; side effect only.
import '@/pi/compression-streams';

import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { ChatProvider } from '@/chat/chat-provider';
import { useChatColors } from '@/hooks/use-chat-colors';
import { useScheduledTaskTaps } from '@/hooks/use-scheduled-task-taps';
import { useStackScreenOptions } from '@/hooks/use-stack-screen-options';

// A modal opened from a link has the tabs beneath it to return to.
export const unstable_settings = { anchor: '(tabs)' };

/** The tabs, with the modals every tab opens presented above them. */
export default function RootLayout() {
  const colors = useChatColors();
  const screenOptions = useStackScreenOptions();
  useScheduledTaskTaps();
  const baseTheme = colors.dark ? DarkTheme : DefaultTheme;
  return (
    <ThemeProvider value={{ ...baseTheme, colors: { ...baseTheme.colors, primary: colors.accent,
      background: colors.background, card: colors.background, text: colors.text, border: colors.border } }}>
      <KeyboardProvider>
        <ChatProvider>
          <StatusBar style={colors.dark ? 'light' : 'dark'} />
          <Stack screenOptions={screenOptions}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            {/* These sheets have their own Stacks, whose screens show the headers. */}
            <Stack.Screen name="chat-settings/[id]" options={{ presentation: 'modal', headerShown: false }} />
            <Stack.Screen name="infinichat-settings" options={{ presentation: 'modal', headerShown: false }} />
            <Stack.Screen name="infinichat-schedule" options={{ presentation: 'modal', headerShown: false }} />
            <Stack.Screen name="infinichat-agent/[name]" options={{ presentation: 'modal', headerShown: false }} />
            <Stack.Screen name="remote-hosts" options={{ presentation: 'modal', headerShown: false }} />
            <Stack.Screen name="account" options={{ title: 'Account', presentation: 'modal' }} />
            <Stack.Screen name="infinichat-providers" options={{ title: 'Providers', presentation: 'modal' }} />
            <Stack.Screen name="infinichat-mcp" options={{ title: 'MCP servers', presentation: 'modal' }} />
            <Stack.Screen name="infinichat-questions" options={{ title: 'Questions', presentation: 'modal' }} />
            <Stack.Screen name="infinichat-secrets" options={{ title: 'Active credentials', presentation: 'modal' }} />
          </Stack>
        </ChatProvider>
      </KeyboardProvider>
    </ThemeProvider>
  );
}
