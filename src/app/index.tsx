import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useChatApp } from '@/chat/chat-provider';
import type { ChatSummary } from '@/chat/types';
import { ChatActions } from '@/components/chat/chat-actions';
import { ChatIcon } from '@/components/chat/icon';
import { ActionButton, IconButton, InlineNotice, PiMark } from '@/components/chat/primitives';
import { useChatColors } from '@/hooks/use-chat-colors';

function dateLabel(timestamp: number) {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function ChatsScreen() {
  const colors = useChatColors();
  const insets = useSafeAreaInsets();
  const { ready, error, chats, hasConnectedProvider, catalog, providerAccess, signOutPending, runtime } = useChatApp();
  const connectionsReady = catalog.every((provider) => providerAccess(provider.id).ready);
  const connectionError = catalog.map((provider) => providerAccess(provider.id).error).find(Boolean);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [selected, setSelected] = useState<ChatSummary>();
  const query = search.trim().toLocaleLowerCase();
  const visibleChats = query ? chats.filter((chat) => `${chat.title} ${chat.preview}`.toLocaleLowerCase().includes(query)) : chats;
  const newChat = async () => {
    if (creating || !ready) return;
    setCreating(true); setLocalError(undefined);
    try {
      const id = await runtime.createChat();
      router.push({ pathname: '/chat/[id]', params: { id } });
    }
    catch (cause) { setLocalError(cause instanceof Error ? cause.message : 'Could not create a chat.'); }
    finally { setCreating(false); }
  };
  return <View testID="chats-screen" style={[styles.screen, { backgroundColor: colors.background }]}>
    <Stack.Screen options={{ title: 'Chats',
      headerLeft: () => <IconButton testID="account-button" icon="person" label="Account" onPress={() => router.push('/account')} />,
      headerRight: () => <IconButton testID="new-chat" icon="compose" label="New chat" disabled={!ready || creating} onPress={() => { void newChat(); }} />,
    }} />
    <FlatList testID="chat-list" data={visibleChats} keyExtractor={(chat) => String(chat.id)}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      contentContainerStyle={[styles.listContent, { paddingBottom: Math.max(insets.bottom, 20) + 24 }]}
      ListHeaderComponent={<View style={styles.listHeader}>
        <View style={styles.brandRow}><PiMark size={36} /><View style={styles.brandCopy}>
          <Text style={[styles.brandTitle, { color: colors.text }]}>Room for a good conversation.</Text>
          <Text style={[styles.brandCaption, { color: colors.muted }]}>Pick up where you left off.</Text>
        </View></View>
        {chats.length > 0 && <View style={[styles.search, { backgroundColor: colors.subtle }]}>
          <ChatIcon name="search" color={colors.muted} size={18} />
          <TextInput testID="search-chats" accessibilityLabel="Search chats" value={search} onChangeText={setSearch} placeholder="Search chats" placeholderTextColor={colors.muted}
            autoCorrect={false} returnKeyType="search" style={[styles.searchInput, { color: colors.text }]} />
          {!!search && <IconButton icon="close" label="Clear search" onPress={() => setSearch('')} />}
        </View>}
        {(localError || error) && <InlineNotice testID="chat-list-error" message={localError || error || ''} />}
        {chats.length > 0 && <View style={styles.sectionRow}>
          <Text style={[styles.sectionTitle, { color: colors.secondary }]}>{query ? `${visibleChats.length} results` : 'YOUR CONVERSATIONS'}</Text>
          <Text style={[styles.savedLabel, { color: colors.muted }]}>Saved on this device</Text>
        </View>}
      </View>}
      renderItem={({ item }) => <Pressable testID={`chat-row-${item.id}`} accessibilityRole="button" accessibilityLabel={`${item.title || 'New chat'}. ${item.preview || 'No messages yet'}`}
        onPress={() => router.push({ pathname: '/chat/[id]', params: { id: item.id } })} onLongPress={() => setSelected(item)}
        style={({ pressed }) => [styles.chatRow, { borderBottomColor: colors.border, backgroundColor: pressed ? colors.subtle : 'transparent' }]}>
        <View style={[styles.chatGlyph, { backgroundColor: colors.surface }]}><ChatIcon name="message" color={colors.secondary} size={19} /></View>
        <View style={styles.chatInfo}>
          <View style={styles.chatHeading}><Text numberOfLines={1} style={[styles.chatTitle, { color: colors.text }]}>{item.title || 'New chat'}</Text>
            <Text style={[styles.chatDate, { color: colors.muted }]}>{dateLabel(item.updatedAt)}</Text></View>
          <Text numberOfLines={2} style={[styles.chatPreview, { color: colors.secondary }]}>{item.preview || 'A fresh start. What’s on your mind?'}</Text>
        </View>
        <Pressable testID={`chat-options-${item.id}`} accessibilityRole="button" accessibilityLabel={`Options for ${item.title || 'New chat'}`} onPress={() => setSelected(item)} hitSlop={8} style={styles.rowOptions}>
          <ChatIcon name="more" color={colors.muted} size={18} />
        </Pressable>
      </Pressable>}
      ListEmptyComponent={!ready ? <View style={styles.loading}><ActivityIndicator color={colors.accent} /><Text style={[styles.loadingText, { color: colors.muted }]}>Opening your chats…</Text></View>
        : query ? <View style={styles.noResults}><Text style={[styles.noResultsTitle, { color: colors.text }]}>No chats found</Text><Text style={[styles.emptyBody, { color: colors.secondary }]}>Try another word or start something new.</Text></View>
        : <View style={styles.empty}>
          <PiMark size={70} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>What’s on{'\n'}your mind?</Text>
          <Text style={[styles.emptyBody, { color: colors.secondary }]}>A question, a half-formed idea, or a plan.{'\n'}Start here and make something of it.</Text>
          <View style={styles.startButton}><ActionButton testID="start-first-chat" title="Start a conversation" icon="plus" loading={creating} onPress={() => { void newChat(); }} /></View>
          <View style={styles.localNote}><ChatIcon name="phone" color={colors.muted} size={14} /><Text style={[styles.localNoteText, { color: colors.muted }]}>Your conversations are saved on this device.</Text></View>
        </View>}
      ListFooterComponent={(!hasConnectedProvider || connectionError || signOutPending) && ready ? <Pressable testID="history-sign-in" accessibilityRole="button" onPress={() => router.push('/account')} style={[styles.accountCard, { backgroundColor: colors.accentSoft }]}>
        <ChatIcon name="person" color={colors.accent} size={23} /><View style={styles.accountCopy}>
          <Text style={[styles.accountTitle, { color: colors.accent }]}>{signOutPending ? 'Finish signing out' : !connectionsReady ? 'Restoring your connections' : connectionError ? 'A connection needs attention' : 'Connect a provider'}</Text>
          <Text style={[styles.accountCaption, { color: colors.secondary }]}>{signOutPending ? 'Open Account to finish removing the saved connection.' : !connectionsReady ? 'Your saved chats are available while we reconnect.' : connectionError || 'Use ChatGPT or an API key to send messages. Your history stays here.'}</Text>
        </View><ChatIcon name="chevron" color={colors.accent} size={12} />
      </Pressable> : undefined}
    />
    <ChatActions chat={selected} onClose={() => setSelected(undefined)} />
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  listContent: { flexGrow: 1, paddingHorizontal: 22, maxWidth: 760, width: '100%', alignSelf: 'center' },
  listHeader: { gap: 20, paddingTop: 13 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 },
  brandCopy: { flex: 1 },
  brandTitle: { fontSize: 15, fontWeight: '500' },
  brandCaption: { fontSize: 12, marginTop: 5 },
  search: { minHeight: 46, borderRadius: 14, flexDirection: 'row', alignItems: 'center', paddingLeft: 14, gap: 9 },
  searchInput: { flex: 1, fontSize: 16, paddingVertical: 11, paddingRight: 12 },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 9, paddingBottom: 4 },
  sectionTitle: { fontSize: 10, fontWeight: '600', letterSpacing: 1.1 },
  savedLabel: { fontSize: 11 },
  chatRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 19, borderBottomWidth: StyleSheet.hairlineWidth },
  chatGlyph: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  chatInfo: { flex: 1, gap: 6 },
  chatHeading: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  chatTitle: { flex: 1, fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  chatDate: { fontSize: 10 },
  chatPreview: { fontSize: 13, lineHeight: 19 },
  rowOptions: { minWidth: 28, minHeight: 40, alignItems: 'flex-end', justifyContent: 'center' },
  loading: { paddingVertical: 100, alignItems: 'center', gap: 14 },
  loadingText: { fontSize: 14 },
  noResults: { paddingVertical: 70, alignItems: 'center', gap: 10 },
  noResultsTitle: { fontSize: 20, fontWeight: '600' },
  empty: { alignItems: 'center', paddingTop: 63, paddingBottom: 44, gap: 23 },
  emptyTitle: { fontSize: 37, lineHeight: 44, fontWeight: '500', letterSpacing: -1.3, textAlign: 'center' },
  emptyBody: { fontSize: 15, lineHeight: 23, textAlign: 'center' },
  startButton: { marginTop: 8, width: '100%', maxWidth: 290 },
  localNote: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  localNoteText: { fontSize: 10 },
  accountCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 18, padding: 16, marginTop: 25 },
  accountCopy: { flex: 1, gap: 5 },
  accountTitle: { fontSize: 14, fontWeight: '600' },
  accountCaption: { fontSize: 12, lineHeight: 18 },
});
