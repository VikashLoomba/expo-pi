import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { ChatProvider } from '@/chat/chat-provider';
import { useChatColors } from '@/hooks/use-chat-colors';

export default function RootLayout() {
  const colors = useChatColors();
  const baseTheme = colors.dark ? DarkTheme : DefaultTheme;
  return (
    <ThemeProvider value={{ ...baseTheme, colors: { ...baseTheme.colors, primary: colors.accent, background: colors.background, card: colors.background, text: colors.text, border: colors.border } }}>
      <ChatProvider>
        <StatusBar style={colors.dark ? 'light' : 'dark'} />
        <Stack screenOptions={{
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.accent,
          headerTitleStyle: { color: colors.text, fontSize: 17, fontWeight: '600' },
          headerShadowVisible: false,
          headerBackButtonDisplayMode: 'minimal',
          contentStyle: { backgroundColor: colors.background },
        }}>
          <Stack.Screen name="index" options={{ title: 'Chats' }} />
          <Stack.Screen name="chat/[id]" options={{ title: 'New chat' }} />
          <Stack.Screen name="chat-settings/[id]" options={{ title: 'Chat settings', presentation: 'modal' }} />
          <Stack.Screen name="account" options={{ title: 'Account', presentation: 'modal' }} />
        </Stack>
      </ChatProvider>
    </ThemeProvider>
  );
}
