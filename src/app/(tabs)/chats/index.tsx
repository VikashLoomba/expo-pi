import { Link, router, Stack } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { useChatApp } from '@/chat/chat-provider';
import { useChatActions } from '@/components/chat/chat-actions';
import { ChatIcon } from '@/components/chat/icon';
import { ActionButton, InlineNotice, PiMark } from '@/components/chat/primitives';
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
  const { ready, error, dismissError, chats, hasConnectedProvider, catalog, providerAccess, signOutPending, service } =
    useChatApp();
  const connectionsReady = catalog.every((provider) => providerAccess(provider.id).ready);
  const connectionError = catalog.map((provider) => providerAccess(provider.id).error).find(Boolean);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const actions = useChatActions(setLocalError);
  const query = search.trim().toLocaleLowerCase();
  const visibleChats = query ? chats.filter((chat) => `${chat.title} ${chat.preview}`.toLocaleLowerCase().includes(query)) : chats;
  const newChat = async () => {
    if (creating || !service) return;
    setCreating(true); setLocalError(undefined);
    try {
      const id = await service.createChat();
      router.push({ pathname: '/chats/chat/[id]', params: { id } });
    }
    catch (cause) { setLocalError(cause instanceof Error ? cause.message : 'Could not create a chat.'); }
    finally { setCreating(false); }
  };
  // The list is the screen's first view, so the large title collapses into the bar as it scrolls.
  return <>
    <Stack.Screen options={{ title: 'Chats', headerLargeTitleEnabled: true,
      headerSearchBarOptions: chats.length ? { placeholder: 'Search chats', autoCapitalize: 'none',
        onChangeText: (event) => setSearch(event.nativeEvent.text), onCancelButtonPress: () => setSearch('') }
        : undefined }} />
    <Stack.Toolbar placement="left">
      <Stack.Toolbar.Button icon="person" accessibilityLabel="Account" onPress={() => router.push('/account')} />
    </Stack.Toolbar>
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Button icon="square.and.pencil" accessibilityLabel="New chat" disabled={!ready || creating}
        onPress={() => { void newChat(); }} />
    </Stack.Toolbar>
    <FlatList testID="chat-list" data={visibleChats} keyExtractor={(chat) => String(chat.id)}
      contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      contentContainerStyle={styles.listContent}
      ListHeaderComponent={<View style={styles.listHeader}>
        <View style={styles.brandRow}><PiMark size={36} /><View style={styles.brandCopy}>
          <Text style={[styles.brandTitle, { color: colors.text }]}>Room for a good conversation.</Text>
          <Text style={[styles.brandCaption, { color: colors.muted }]}>Pick up where you left off.</Text>
        </View></View>
        {(localError || error) && <InlineNotice testID="chat-list-error" message={localError || error || ''}
          action="Dismiss" onAction={localError ? () => setLocalError(undefined) : dismissError} />}
        {chats.length > 0 && <View style={styles.sectionRow}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>
            {query ? `${visibleChats.length} results` : 'Your conversations'}
          </Text>
          <Text style={[styles.savedLabel, { color: colors.muted }]}>Saved on this device</Text>
        </View>}
      </View>}
      renderItem={({ item }) => <Link href={{ pathname: '/chats/chat/[id]', params: { id: item.id } }} asChild>
        <Link.Trigger>
          <Pressable testID={`chat-row-${item.id}`}
            accessibilityLabel={`${item.title || 'New chat'}. ${item.preview || 'No messages yet'}`}>
            {({ pressed }) => <View style={[styles.chatRow,
              { borderBottomColor: colors.border, backgroundColor: pressed ? colors.subtle : 'transparent' }]}>
              <View style={[styles.chatGlyph, { backgroundColor: colors.surface }]}>
                <ChatIcon name="message" color={colors.secondary} size={19} />
              </View>
              <View style={styles.chatInfo}>
                <View style={styles.chatHeading}>
                  <Text numberOfLines={1} style={[styles.chatTitle, { color: colors.text }]}>
                    {item.title || 'New chat'}
                  </Text>
                  <Text style={[styles.chatDate, { color: colors.muted }]}>{dateLabel(item.updatedAt)}</Text>
                </View>
                <Text numberOfLines={2} style={[styles.chatPreview, { color: colors.secondary }]}>
                  {item.preview || 'A fresh start. What’s on your mind?'}
                </Text>
              </View>
            </View>}
          </Pressable>
        </Link.Trigger>
        <Link.Menu>
          <Link.MenuAction icon="slider.horizontal.3"
            onPress={() => router.push({ pathname: '/chat-settings/[id]', params: { id: item.id } })}>
            Model settings
          </Link.MenuAction>
          <Link.MenuAction icon="pencil" onPress={() => actions.rename(item)}>Rename</Link.MenuAction>
          <Link.MenuAction icon="trash" destructive onPress={() => actions.remove(item)}>Delete</Link.MenuAction>
        </Link.Menu>
      </Link>}
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
  </>;
}

const styles = StyleSheet.create({
  listContent: { flexGrow: 1, paddingHorizontal: 22, paddingBottom: 24, maxWidth: 760, width: '100%', alignSelf: 'center' },
  listHeader: { gap: 20, paddingTop: 13 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 },
  brandCopy: { flex: 1 },
  brandTitle: { fontSize: 15, fontWeight: '500' },
  brandCaption: { fontSize: 12, marginTop: 5 },
  sectionRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingTop: 9,
    paddingBottom: 4 },
  sectionTitle: { fontSize: 17, fontWeight: '600' },
  savedLabel: { fontSize: 12 },
  chatRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 19, borderBottomWidth: StyleSheet.hairlineWidth },
  chatGlyph: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  chatInfo: { flex: 1, gap: 6 },
  chatHeading: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  chatTitle: { flex: 1, fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  chatDate: { fontSize: 10 },
  chatPreview: { fontSize: 13, lineHeight: 19 },
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
