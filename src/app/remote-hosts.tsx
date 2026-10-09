import { router, Stack } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore, type ComponentRef } from 'react';
import { AppState, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useChatApp } from '@/chat/chat-provider';
import { ActionButton, IconButton, InlineNotice } from '@/components/chat/primitives';
import { RemoteHostForm } from '@/components/chat/remote-host-form';
import { useChatColors } from '@/hooks/use-chat-colors';
import type { RemoteHost } from '@/pi/execution/remote/hosts';
import { testRemoteHost, type HostKeyChallenge } from '@/pi/execution/remote/test-host';

export default function RemoteHostsScreen() {
  const colors = useChatColors();
  const insets = useSafeAreaInsets();
  const { remoteHosts } = useChatApp();
  const snapshot = useSyncExternalStore(remoteHosts.subscribe, remoteHosts.getSnapshot, remoteHosts.getSnapshot);
  const [editing, setEditing] = useState<RemoteHost | 'new'>();
  const [busy, setBusy] = useState<string>();
  const [testing, setTesting] = useState(false);
  const [progress, setProgress] = useState('Connecting through Tailscale…');
  const [notice, setNotice] = useState<{ message: string; error?: boolean }>();
  const [challenge, setChallenge] = useState<HostKeyChallenge>();
  const [removing, setRemoving] = useState<RemoteHost>();
  const active = useRef<AbortController | undefined>(undefined);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const trustReply = useRef<((accepted: boolean) => void) | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'background') active.current?.abort(); });
    return () => { mounted.current = false; subscription.remove(); active.current?.abort(); trustReply.current?.(false); };
  }, []);
  const test = async (host: RemoteHost) => {
    const controller = new AbortController();
    active.current = controller; setBusy(host.id); setTesting(true); setProgress('Connecting through Tailscale…'); setNotice(undefined); setRemoving(undefined);
    try {
      const result = await testRemoteHost(remoteHosts, host.id, { signal: controller.signal,
        onProgress: (stage) => {
          if (mounted.current) setProgress({ detecting: 'Checking remote machine…', checking: 'Verifying remote setup…', uploading: 'Preparing remote execution…' }[stage]);
        },
        onHostKey: (observed) => new Promise<boolean>((resolve) => {
          const finish = (accepted: boolean) => {
            controller.signal.removeEventListener('abort', cancel);
            trustReply.current = undefined;
            if (mounted.current) setChallenge(undefined);
            resolve(accepted);
          };
          const cancel = () => finish(false);
          trustReply.current = finish;
          controller.signal.addEventListener('abort', cancel, { once: true });
          setChallenge(observed);
          if (controller.signal.aborted) cancel();
        }),
      });
      if (mounted.current) setNotice({ message: `Connected to ${host.name} and ready for remote execution. Pi ${result.version} on ${result.os} (${result.arch}).` });
    } catch (error) {
      if (mounted.current) setNotice({ message: error instanceof Error ? error.message : 'Connection test failed.', error: !controller.signal.aborted });
    } finally {
      trustReply.current?.(false);
      active.current = undefined;
      if (mounted.current) { setBusy(undefined); setTesting(false); setChallenge(undefined); scroll.current?.scrollTo({ y: 0, animated: true }); }
    }
  };
  const remove = async (host: RemoteHost) => {
    setBusy(host.id); setNotice(undefined);
    try {
      await remoteHosts.remove(host.id, host);
      setRemoving(undefined);
      setNotice({ message: 'Machine removed. Chats that selected it keep their selection until you choose another environment.' });
    } catch (error) { setNotice({ message: error instanceof Error ? error.message : 'Could not remove this machine.', error: true }); }
    finally { setBusy(undefined); }
  };
  const forget = async (host: RemoteHost) => {
    setBusy(host.id); setNotice(undefined);
    try { await remoteHosts.forgetHostKey(host); setNotice({ message: 'Accepted SSH key removed. Test this machine and verify its fingerprint before using it again.' }); }
    catch (error) { setNotice({ message: error instanceof Error ? error.message : 'Could not reset SSH host trust.', error: true }); }
    finally { setBusy(undefined); }
  };
  return <View testID="remote-hosts-screen" style={[styles.screen, { backgroundColor: colors.background }]}>
    <Stack.Screen options={{ title: 'Remote machines', headerRight: () => <IconButton icon="close" label="Close remote machines" testID="close-remote-hosts"
      onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/'); }} /> }} />
    <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive"
      onContentSizeChange={() => { if (challenge) scroll.current?.scrollToEnd({ animated: true }); }}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}>
      <Text style={[styles.intro, { color: colors.secondary }]}>SSH over Tailscale connects to the machine’s existing SSH server. Keep Tailscale connected on your phone and the machine. Each chat chooses where its tools run.</Text>
      <Text style={[styles.detail, { color: colors.secondary }]}>Pi prepares remote execution automatically when you test or connect. Your chat and model connection stay on this phone.</Text>
      {snapshot.error && <InlineNotice message={snapshot.error} action="Retry" onAction={() => { void remoteHosts.restore().catch(() => {}); }} />}
      {snapshot.cleanupError && <InlineNotice message={snapshot.cleanupError} action="Retry cleanup" onAction={() => { void remoteHosts.restore().catch(() => {}); }} />}
      {notice && <InlineNotice testID="remote-host-notice" message={notice.message} tone={notice.error ? 'error' : 'neutral'} />}
      {editing ? <RemoteHostForm key={editing === 'new' ? 'new' : editing.id} host={editing === 'new' ? undefined : editing}
        onCancel={() => { setEditing(undefined); setNotice(undefined); }} onSave={async (input, auth) => {
          const host = await remoteHosts.save(input, auth, editing === 'new' ? undefined : editing);
          setEditing(undefined); setNotice({ message: `${host.name} saved. Test the connection to verify the server and prepare remote execution.` });
        }} />
        : <>
          {!snapshot.ready && <Text style={[styles.detail, { color: colors.secondary }]}>Loading saved machines…</Text>}
          {snapshot.ready && !snapshot.hosts.length && !snapshot.error && <Text style={[styles.detail, { color: colors.secondary }]}>No remote machines yet. Local execution remains available in every chat.</Text>}
          {snapshot.hosts.map((host) => <View key={host.id} testID={`remote-machine-${host.id}`} style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <Text style={[styles.name, { color: colors.text }]}>{host.name}</Text>
            <Text selectable style={[styles.detail, { color: colors.secondary }]}>{host.username}@{host.hostname}:{host.port}</Text>
            <Text style={[styles.detail, { color: colors.muted }]}>{host.credentialType === 'password' ? 'SSH password saved' : 'SSH private key saved'}</Text>
            <ActionButton testID={`test-remote-host-${host.id}`} title="Test connection" disabled={!!busy} onPress={() => { void test(host); }} />
            <ActionButton testID={`edit-remote-host-${host.id}`} title="Edit machine" secondary disabled={!!busy} onPress={() => { setEditing(host); setNotice(undefined); setRemoving(undefined); }} />
            <ActionButton testID={`forget-remote-host-key-${host.id}`} title="Reset accepted SSH key" secondary disabled={!!busy} onPress={() => { void forget(host); }} />
            <ActionButton testID={`remove-remote-host-${host.id}`} title="Remove machine" secondary disabled={!!busy} onPress={() => { setRemoving(host); setNotice(undefined); }} />
            {removing?.id === host.id && <View style={styles.confirmation}>
              <Text style={[styles.detail, { color: colors.secondary }]}>Remove {host.name} and its saved SSH credentials? Existing chats keep their selection and need another environment.</Text>
              <ActionButton testID="confirm-remove-remote-host" title="Remove machine and credentials" disabled={!!busy} onPress={() => { void remove(host); }} />
              <ActionButton title="Keep machine" secondary disabled={!!busy} onPress={() => setRemoving(undefined)} />
            </View>}
          </View>)}
          <ActionButton testID="add-remote-host" title="Add remote machine" disabled={!!busy || !snapshot.ready || !!snapshot.error} onPress={() => { setEditing('new'); setNotice(undefined); setRemoving(undefined); }} />
        </>}
      {testing && <>
        <Text testID="remote-host-test-progress" accessibilityLiveRegion="polite" style={[styles.detail, { color: colors.secondary }]}>{challenge ? 'Waiting for your SSH host-key decision…' : progress}</Text>
        <ActionButton testID="cancel-remote-host-test" title="Cancel connection test" secondary onPress={() => active.current?.abort()} />
      </>}
      {challenge && <View testID="remote-host-trust-challenge" style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.name, { color: colors.text }]}>{challenge.trusted ? 'SSH host key changed' : 'Verify this SSH server'}</Text>
        <Text style={[styles.detail, { color: colors.secondary }]}>Compare this fingerprint with the SSH server’s host key using a trusted source before accepting it.</Text>
        <Text selectable style={[styles.detail, { color: colors.text }]}>{challenge.host.hostname}:{challenge.host.port} · {challenge.observed.algorithm}</Text>
        <Text testID="remote-host-fingerprint" selectable style={[styles.fingerprint, { color: colors.text }]}>{challenge.observed.fingerprint}</Text>
        {challenge.trusted && <Text selectable style={[styles.detail, { color: colors.danger }]}>Previously accepted: {challenge.trusted.fingerprint}. Continue only if you have verified why this machine’s key changed.</Text>}
        <ActionButton testID="accept-remote-host-key" title={challenge.trusted ? 'Accept verified replacement key' : 'Accept verified key'} onPress={() => trustReply.current?.(true)} />
        <ActionButton testID="reject-remote-host-key" title="Reject key" secondary onPress={() => trustReply.current?.(false)} />
      </View>}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 }, content: { padding: 22, gap: 20, width: '100%', maxWidth: 620, alignSelf: 'center' },
  intro: { fontSize: 15, lineHeight: 23 }, detail: { fontSize: 13, lineHeight: 20 },
  card: { padding: 18, gap: 14, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18 },
  name: { fontSize: 19, fontWeight: '600' }, fingerprint: { fontSize: 14, lineHeight: 22, fontFamily: 'Menlo' },
  confirmation: { gap: 12, paddingTop: 6 },
});
