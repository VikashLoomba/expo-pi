import * as Clipboard from 'expo-clipboard';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useChatApp } from '@/chat/chat-provider';
import { AuthPromptForm } from '@/components/chat/auth-prompt';
import { ChatIcon } from '@/components/chat/icon';
import { ActionButton, IconButton, InlineNotice, PiMark } from '@/components/chat/primitives';
import { useChatColors } from '@/hooks/use-chat-colors';
import { CODEX_PROVIDER_ID } from '@/pi/codex-auth/identity';
import type { ProviderOption } from '@/pi/model-catalog';
import { OPENAI_PROVIDER_ID } from '@/pi/openai-auth/core';

function ProviderAccountCard({ provider }: { provider: ProviderOption }) {
  const colors = useChatColors();
  const { providerAccess, providerOAuth, saveProviderKey, disconnectProvider, signOutPending, disconnectingProvider,
    signingIn, signingInProvider, signIn, cancelSignIn, authNotice, authPrompt, submitAuthPrompt, openSignInPage, browserOpen } = useChatApp();
  const access = providerAccess(provider.id);
  const oauth = providerOAuth(provider.id);
  const accountName = provider.id === OPENAI_PROVIDER_ID ? 'ChatGPT' : oauth?.name ?? provider.name;
  const authenticating = signingInProvider === provider.id;
  const notice = authNotice?.providerId === provider.id ? authNotice.message : undefined;
  const [showKey, setShowKey] = useState(false);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string>();
  const save = async () => {
    setSaving(true); setError(undefined);
    try { await saveProviderKey(provider.id, key); setKey(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this provider key.'); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    setRemoving(true); setError(undefined);
    try { await disconnectProvider(provider.id); setKey(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not remove this provider key.'); }
    finally { setRemoving(false); }
  };
  return <View testID={`provider-account-${provider.id}`} style={[styles.connection, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <View style={styles.connectionHeader}>
      <View style={styles.connectionCopy}>
        <Text style={[styles.providerName, { color: colors.text }]}>{provider.name}</Text>
        <Text accessibilityLiveRegion="polite" style={[styles.providerDescription, { color: colors.secondary }]}>{!access.ready ? 'Restoring connection…'
          : access.connected ? access.type === 'oauth' ? provider.id === OPENAI_PROVIDER_ID ? 'Using ChatGPT plan' : `Connected to ${accountName}` : 'API key saved'
            : oauth ? `Use ${accountName} or an API key` : 'Connect with your API key'}</Text>
      </View>
      {access.connected && <ChatIcon name="check" size={18} color={colors.accent} />}
    </View>
    {oauth && <>
      {notice && <Text testID={`auth-status-${provider.id}`} accessibilityLiveRegion="polite" style={[styles.authStatus, { color: colors.secondary }]}>{notice}</Text>}
      {!authenticating && <ActionButton testID={`sign-in-${provider.id}`} title={access.connected && access.type === 'oauth' ? `Switch ${accountName} account` : oauth.loginLabel ?? `Continue with ${accountName}`}
        disabled={!access.ready || signingIn || saving || removing || signOutPending} onPress={() => { setKey(''); setShowKey(false); setError(undefined); void signIn(provider.id); }} />}
      {!authenticating && access.type === 'api_key' && <Text style={[styles.privacyText, { color: colors.secondary }]}>Signing in replaces the saved API key for {provider.name}.</Text>}
      {authenticating && authPrompt && <AuthPromptForm key={authPrompt.id} pending={authPrompt} submit={submitAuthPrompt}
        openBrowser={() => { void openSignInPage(); }} browserOpen={browserOpen} />}
      {authenticating && <ActionButton testID={`cancel-sign-in-${provider.id}`} title="Cancel sign-in" secondary onPress={cancelSignIn} />}
      {!authenticating && <ActionButton testID={`choose-api-key-${provider.id}`} title={showKey ? 'Hide API key entry' : 'Use API key'} secondary
        disabled={signingIn || saving || removing || signOutPending} onPress={() => { setKey(''); setShowKey((show) => !show); }} />}
    </>}
    {(!oauth || showKey) && <>
    {access.type === 'oauth' && <Text style={[styles.privacyText, { color: colors.secondary }]}>Saving an API key replaces {accountName} sign-in for {provider.name} and uses API billing.</Text>}
    <TextInput testID={`provider-key-${provider.id}`} accessibilityLabel={`${provider.name} API key`} value={key} onChangeText={setKey}
      secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" textContentType="none" editable={!saving && !removing && !signingIn}
      placeholder={access.connected ? 'Enter a replacement API key' : 'Enter API key'} placeholderTextColor={colors.muted}
      style={[styles.keyInput, { color: colors.text, backgroundColor: colors.background, borderColor: colors.border }]} />
    <ActionButton testID={`save-provider-${provider.id}`} title={access.type === 'oauth' ? 'Use this API key' : access.connected ? 'Replace API key' : 'Save API key'} loading={saving}
      disabled={!key.trim() || !access.ready || removing || signingIn || signOutPending} onPress={() => { void save(); }} />
    </>}
    {(error || access.error) && <InlineNotice message={error || access.error!} />}
    {(access.connected || access.error || disconnectingProvider === provider.id) && <ActionButton testID={`remove-provider-${provider.id}`} title={disconnectingProvider === provider.id ? 'Retry disconnecting' : `Disconnect ${provider.name}`} secondary loading={removing}
      disabled={signingIn || saving || (signOutPending && disconnectingProvider !== provider.id)} onPress={() => { void remove(); }} />}
    <Text style={[styles.privacyText, { color: colors.muted }]}>{access.type === 'oauth'
      ? `Requests use your ${accountName} ${oauth?.isSubscription ? 'plan' : 'account'}. Each chat keeps its selected provider and model.`
      : `API key requests use your ${provider.name} API account and its billing. The provider checks your key when you send a message.`}</Text>
  </View>;
}

export default function AccountScreen() {
  const colors = useChatColors();
  const insets = useSafeAreaInsets();
  const { provider: requestedProvider } = useLocalSearchParams<{ provider?: string }>();
  const { catalog, hasConnectedProvider, signedIn, hasSavedSignIn, authReady, authChecking, authError, signOutPending, disconnectingProvider, signingIn, signingInProvider, authStatus,
    deviceLogin, browserOpen, signIn, cancelSignIn, openSignInPage, signOut, retryAuth, authPrompt, submitAuthPrompt } = useChatApp();
  const [signingOut, setSigningOut] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  const [retrying, setRetrying] = useState(false);
  const keyProviders = catalog.filter((provider) => provider.id !== CODEX_PROVIDER_ID);
  const focusedProvider = keyProviders.find((provider) => provider.id === (requestedProvider ?? OPENAI_PROVIDER_ID));
  const codexSigningIn = signingInProvider === CODEX_PROVIDER_ID;
  const codexSignOutPending = signOutPending && disconnectingProvider === CODEX_PROVIDER_ID;
  useEffect(() => () => cancelSignIn(), [cancelSignIn]);
  const disconnect = async () => {
    setSigningOut(true); setError(undefined);
    try { await signOut(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not sign out. Try again.'); }
    finally { setSigningOut(false); }
  };
  const reconnect = async () => {
    setRetrying(true); setError(undefined);
    try { await retryAuth(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not restore your sign-in. Try again.'); }
    finally { setRetrying(false); }
  };
  const copy = async () => {
    if (!deviceLogin) return;
    try {
      if (!await Clipboard.setStringAsync(deviceLogin.userCode, { android: { isSensitive: true } })) throw new Error('Clipboard unavailable');
      setCopied(true);
    } catch { Alert.alert('Could not copy', 'You can select the sign-in code and copy it manually.'); }
  };
  return <View testID="account-screen" style={[styles.screen, { backgroundColor: colors.background }]}>
    <Stack.Screen options={{ title: 'Providers', headerRight: () => <IconButton testID="close-account" icon="close" label="Close providers" onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/'); }} /> }} />
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}>
      <View style={styles.hero}>
        <PiMark size={64} />
        <Text style={[styles.title, { color: colors.text }]}>Your providers.</Text>
        <Text style={[styles.subtitle, { color: colors.secondary }]}>Connect accounts here, then choose a provider, model, and reasoning effort in each chat.</Text>
      </View>
      <View style={[styles.connection, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.providerName, { color: colors.text }]}>Execution environments</Text>
        <Text style={[styles.privacyText, { color: colors.secondary }]}>Configure remote machines using SSH over Tailscale, then choose an environment in each chat’s settings.</Text>
        <ActionButton testID="manage-remote-hosts" title="Remote machines" secondary onPress={() => router.push('/remote-hosts')} />
      </View>
      {focusedProvider && <ProviderAccountCard key={focusedProvider.id} provider={focusedProvider} />}
      <View style={[styles.connection, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.connectionHeader}>
          <View style={[styles.providerIcon, { backgroundColor: colors.accentSoft }]}><ChatIcon name="spark" color={colors.accent} size={23} /></View>
          <View style={styles.connectionCopy}><Text style={[styles.providerName, { color: colors.text }]}>OpenAI Codex (legacy)</Text><Text style={[styles.providerDescription, { color: colors.secondary }]}>{hasSavedSignIn ? 'Saved ChatGPT account' : 'ChatGPT with device-code sign-in'}</Text></View>
          {signedIn && !authError && <View style={[styles.connectedBadge, { backgroundColor: colors.accentSoft }]}><ChatIcon name="check" color={colors.accent} size={12} /></View>}
        </View>
        <Text testID="auth-status" accessibilityLiveRegion="polite" selectable style={[styles.authStatus, { color: colors.secondary }]}>{authStatus}</Text>
        {error && <InlineNotice message={error} />}
        {codexSigningIn && deviceLogin && <View style={[styles.deviceCodeCard, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <Text style={[styles.stepLabel, { color: colors.secondary }]}>YOUR ONE-TIME CODE</Text>
          <Pressable testID="copy-device-code" accessibilityRole="button" accessibilityLabel="Copy sign-in code" onPress={() => { void copy(); }} style={styles.codeRow}>
            <Text testID="device-code" selectable style={[styles.deviceCode, { color: colors.text }]}>{deviceLogin.userCode}</Text><ChatIcon name={copied ? 'check' : 'copy'} color={colors.accent} size={18} />
          </Pressable>
          <Text style={[styles.codeInstructions, { color: colors.secondary }]}>Copy this code, open the sign-in page, and paste it to connect your account.</Text>
          <ActionButton testID="open-sign-in-page" title={browserOpen ? 'Sign-in page is open' : 'Open sign-in page'} disabled={browserOpen} onPress={() => { void openSignInPage(); }} />
          <Text selectable style={[styles.verificationUri, { color: colors.muted }]}>{deviceLogin.verificationUri}</Text>
        </View>}
        {!signedIn && !signingIn && !signOutPending && <ActionButton testID="sign-in" title={!authReady ? 'Restoring sign-in…' : 'Sign in with ChatGPT'} loading={!authReady}
          disabled={Platform.OS !== 'ios' || !authReady || authChecking || retrying} onPress={() => { setCopied(false); setError(undefined); void signIn(); }} />}
        {authError && !signingIn && !signOutPending && <ActionButton testID="retry-auth" title="Retry connection" secondary loading={retrying || authChecking}
          onPress={() => { void reconnect(); }} />}
        {Platform.OS !== 'ios' && !signedIn && <Text style={[styles.platformNote, { color: colors.secondary }]}>ChatGPT sign-in is currently available on iOS. Your saved chats remain available here.</Text>}
        {codexSigningIn && authPrompt && <AuthPromptForm key={authPrompt.id} pending={authPrompt} submit={submitAuthPrompt} browserOpen={browserOpen} />}
        {codexSigningIn && <ActionButton testID="cancel-sign-in" title="Cancel sign-in" secondary onPress={cancelSignIn} />}
        {(hasSavedSignIn || codexSignOutPending) && <ActionButton testID="sign-out" title={codexSignOutPending ? 'Retry sign-out' : 'Sign out'} secondary loading={signingOut}
          disabled={signingIn || (signOutPending && !codexSignOutPending)} onPress={() => { void disconnect(); }} />}
      </View>
      {keyProviders.filter((provider) => provider.id !== focusedProvider?.id).map((provider) => <ProviderAccountCard key={provider.id} provider={provider} />)}
      <View style={styles.privacy}>
        <ChatIcon name="phone" color={colors.muted} size={19} />
        <View style={styles.privacyCopy}>
          <Text style={[styles.privacyTitle, { color: colors.secondary }]}>At home on your device</Text>
          <Text style={[styles.privacyText, { color: colors.muted }]}>Your chat history is saved on this device, including when you sign out. {Platform.OS === 'web'
            ? 'This browser keeps your sign-in for the current tab session, including reloads. Closing the tab clears that session.'
            : 'Your sign-in is saved in the device’s secure credential storage and restored after restarting the app. Signing out removes the saved credentials.'}</Text>
          <Text style={[styles.privacyText, { color: colors.muted }]}>Your messages are processed by the provider selected for that chat. API keys use the same secure storage as your saved sign-in.</Text>
        </View>
      </View>
      {hasConnectedProvider && <ActionButton testID="back-to-chats" title="Back to your chats" onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/'); }} />}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingHorizontal: 24, paddingTop: 24, maxWidth: 620, width: '100%', alignSelf: 'center', gap: 27 },
  hero: { alignItems: 'center', gap: 19, paddingVertical: 18 },
  title: { fontSize: 29, lineHeight: 36, textAlign: 'center', letterSpacing: -0.8, fontWeight: '500' },
  subtitle: { fontSize: 14, lineHeight: 22, textAlign: 'center' },
  connection: { borderRadius: 23, borderWidth: StyleSheet.hairlineWidth, padding: 19, gap: 19 },
  connectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 13 },
  providerIcon: { width: 45, height: 45, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  connectionCopy: { flex: 1, gap: 4 },
  providerName: { fontSize: 17, fontWeight: '600' },
  providerDescription: { fontSize: 12 },
  connectedBadge: { width: 23, height: 23, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  authStatus: { fontSize: 13, lineHeight: 20 },
  keyInput: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 14, minHeight: 48, fontSize: 14 },
  deviceCodeCard: { borderWidth: 1, borderRadius: 17, padding: 16, gap: 16 },
  stepLabel: { fontSize: 10, letterSpacing: 1.2, fontWeight: '600', textAlign: 'center' },
  codeRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 13, minHeight: 48 },
  deviceCode: { fontSize: 25, fontWeight: '600', letterSpacing: 2, fontVariant: ['tabular-nums'] },
  codeInstructions: { fontSize: 13, lineHeight: 20, textAlign: 'center' },
  verificationUri: { fontSize: 10, lineHeight: 16, textAlign: 'center' },
  platformNote: { fontSize: 13, lineHeight: 20 },
  privacy: { flexDirection: 'row', gap: 12, paddingHorizontal: 5 },
  privacyCopy: { flex: 1, gap: 7 },
  privacyTitle: { fontSize: 13, fontWeight: '500' },
  privacyText: { fontSize: 12, lineHeight: 19 },
});
