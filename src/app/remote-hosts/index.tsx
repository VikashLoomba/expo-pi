import {
  Button, ConfirmationDialog, Form, Host, HStack, LabeledContent, ProgressView, Section, Text,
} from '@expo/ui/swift-ui';
import { disabled as disable, font, foregroundStyle, textSelection } from '@expo/ui/swift-ui/modifiers';
import { router, Stack } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, StyleSheet } from 'react-native';

import { useChatApp, useInfiniChatMachines } from '@/chat/chat-provider';
import { SettingsNotice } from '@/components/chat/settings-controls';
import { useChatColors } from '@/hooks/use-chat-colors';
import type { RemoteHost } from '@/pi/execution/remote/hosts';
import { testRemoteHost, type HostKeyChallenge } from '@/pi/execution/remote/test-host';

const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });
const progressLabels = {
  detecting: 'Checking remote machine…',
  checking: 'Verifying remote setup…',
  uploading: 'Preparing remote execution…',
};

export default function RemoteHostsScreen() {
  const colors = useChatColors();
  const { remoteHosts } = useChatApp();
  const snapshot = useSyncExternalStore(remoteHosts.subscribe, remoteHosts.getSnapshot, remoteHosts.getSnapshot);
  // While InfiniChat runs on a machine, its tools reach the others with that machine's own SSH.
  const infiniChat = useInfiniChatMachines();
  const infiniChatHost = infiniChat && snapshot.hosts.find((host) => host.id === infiniChat.machineId);
  const [busy, setBusy] = useState<string>();
  const [testing, setTesting] = useState(false);
  const [progress, setProgress] = useState('Connecting through Tailscale…');
  const [notice, setNotice] = useState<{ message: string; error?: boolean }>();
  const [challenge, setChallenge] = useState<HostKeyChallenge>();
  const [removing, setRemoving] = useState<RemoteHost>();
  const active = useRef<AbortController | undefined>(undefined);
  const trustReply = useRef<((accepted: boolean) => void) | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') active.current?.abort();
    });
    return () => {
      mounted.current = false;
      subscription.remove();
      active.current?.abort();
      trustReply.current?.(false);
    };
  }, []);
  const test = async (host: RemoteHost) => {
    const controller = new AbortController();
    active.current = controller;
    setBusy(host.id);
    setTesting(true);
    setProgress('Connecting through Tailscale…');
    setNotice(undefined);
    try {
      const result = await testRemoteHost(remoteHosts, host.id, { signal: controller.signal,
        onProgress: (stage) => { if (mounted.current) setProgress(progressLabels[stage]); },
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
      if (mounted.current) {
        setNotice({ message: `Connected to ${host.name} and ready for remote execution. `
          + `Pi ${result.version} on ${result.os} (${result.arch}).` });
      }
    } catch (error) {
      if (mounted.current) {
        setNotice({ message: error instanceof Error ? error.message : 'Connection test failed.',
          error: !controller.signal.aborted });
      }
    } finally {
      trustReply.current?.(false);
      active.current = undefined;
      if (mounted.current) {
        setBusy(undefined);
        setTesting(false);
        setChallenge(undefined);
      }
    }
  };
  const remove = async (host: RemoteHost) => {
    setBusy(host.id);
    setNotice(undefined);
    try {
      await remoteHosts.remove(host.id, host);
      setNotice({ message: 'Machine removed. Chats that selected it keep their selection until you choose another '
        + 'environment.' });
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'Could not remove this machine.', error: true });
    } finally {
      setBusy(undefined);
    }
  };
  const forget = async (host: RemoteHost) => {
    setBusy(host.id);
    setNotice(undefined);
    try {
      await remoteHosts.forgetHostKey(host);
      setNotice({ message: 'Accepted SSH key removed. Test this machine and verify its fingerprint before using it '
        + 'again.' });
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'Could not reset SSH host trust.', error: true });
    } finally {
      setBusy(undefined);
    }
  };
  const restore = () => { void remoteHosts.restore().catch(() => {}); };
  const acceptOnInfiniChatHost = async (host: RemoteHost, fingerprints: string[]) => {
    if (!infiniChat) return;
    setBusy(host.id);
    setNotice(undefined);
    try {
      await infiniChat.accept(host.id, fingerprints);
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'Could not accept the SSH host key.',
        error: true });
    } finally {
      setBusy(undefined);
    }
  };
  /** Whether the machine InfiniChat runs on reaches `host`, and the host key it waits to have accepted there. */
  const reachFromInfiniChat = (host: RemoteHost) => {
    const reaches = infiniChat?.reach;
    if (!infiniChatHost || !reaches || host.id === infiniChatHost.id) return null;
    const from = infiniChatHost.name;
    const reach = reaches[host.id];
    const waiting = infiniChat.pending?.[host.id];
    const failed = waiting !== undefined || (reach !== undefined && !reach.reachable);
    const status = waiting !== undefined ? (waiting.changed ? 'SSH host key changed' : 'SSH host key to verify')
      : reach === undefined ? 'Checking…' : reach.reachable ? 'Reachable' : 'Can’t connect';
    return <>
      <LabeledContent label={`From ${from}`}>
        <Text modifiers={[failed ? foregroundStyle(colors.danger) : secondary]}>{status}</Text>
      </LabeledContent>
      {waiting === undefined && reach !== undefined && !reach.reachable && <Text
        modifiers={[secondary, font({ textStyle: 'footnote' }), textSelection(true)]}>{reach.error}</Text>}
      {waiting !== undefined && <>
        <Text modifiers={[secondary]}>
          {`Compare this fingerprint with the SSH server’s host key using a trusted source before ${from} `
            + 'accepts it.'}
        </Text>
        {waiting.keys.map((key) => <Text key={key.fingerprint}
          modifiers={[font({ design: 'monospaced', textStyle: 'callout' }), textSelection(true)]}>
          {`${key.algorithm} ${key.fingerprint}`}
        </Text>)}
        <Button
          label={waiting.changed ? `Accept verified replacement key on ${from}` : `Accept verified key on ${from}`}
          modifiers={[disable(!!busy)]}
          onPress={() => { void acceptOnInfiniChatHost(host, waiting.keys.map((key) => key.fingerprint)); }} />
      </>}
    </>;
  };

  return <>
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Button icon="xmark" accessibilityLabel="Close remote machines"
        onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/'); }} />
    </Stack.Toolbar>
    <Host style={styles.fill} seedColor={colors.accent} testID="remote-hosts-screen">
      <Form>
        {testing && <Section title="Connection test">
          <HStack spacing={10}>
            <ProgressView />
            <Text modifiers={[secondary]}>{challenge ? 'Waiting for your SSH host-key decision…' : progress}</Text>
          </HStack>
          <Button label="Cancel connection test" onPress={() => active.current?.abort()} />
        </Section>}
        {challenge && <Section title={challenge.trusted ? 'SSH host key changed' : 'Verify this SSH server'}
          footer={<Text>
            Compare this fingerprint with the SSH server’s host key using a trusted source before accepting it.
          </Text>}>
          <Text modifiers={[textSelection(true)]}>
            {`${challenge.host.hostname}:${challenge.host.port} · ${challenge.observed.algorithm}`}
          </Text>
          <Text modifiers={[font({ design: 'monospaced', textStyle: 'callout' }), textSelection(true)]}>
            {challenge.observed.fingerprint}
          </Text>
          {challenge.trusted && <Text modifiers={[foregroundStyle(colors.danger), textSelection(true)]}>
            {`Previously accepted: ${challenge.trusted.fingerprint}. Continue only if you have verified why this `
              + 'machine’s key changed.'}
          </Text>}
          <Button label={challenge.trusted ? 'Accept verified replacement key' : 'Accept verified key'}
            onPress={() => trustReply.current?.(true)} />
          <Button label="Reject key" role="destructive" onPress={() => trustReply.current?.(false)} />
        </Section>}
        {snapshot.error && <SettingsNotice message={snapshot.error} action="Retry" onAction={restore} />}
        {snapshot.cleanupError && <SettingsNotice message={snapshot.cleanupError} action="Retry cleanup"
          onAction={restore} />}
        {notice && <SettingsNotice testID="remote-host-notice" message={notice.message}
          tone={notice.error ? 'error' : 'neutral'} />}
        {snapshot.hosts.map((host) => <Section key={host.id} title={host.name}>
          <LabeledContent label="Address">
            <Text modifiers={[secondary, textSelection(true)]}>{`${host.username}@${host.hostname}:${host.port}`}</Text>
          </LabeledContent>
          <LabeledContent label="Credential">
            <Text modifiers={[secondary]}>{host.credentialType === 'password' ? 'Password' : 'Private key'}</Text>
          </LabeledContent>
          {reachFromInfiniChat(host)}
          <Button label="Test connection" systemImage="bolt.horizontal" modifiers={[disable(!!busy)]}
            onPress={() => { void test(host); }} />
          <Button label="Edit machine" systemImage="pencil" modifiers={[disable(!!busy)]}
            onPress={() => router.push({ pathname: '/remote-hosts/edit', params: { id: host.id } })} />
          <Button label="Reset accepted SSH key" systemImage="key" modifiers={[disable(!!busy)]}
            onPress={() => { void forget(host); }} />
          <ConfirmationDialog title={`Remove ${host.name}?`} titleVisibility="visible"
            isPresented={removing?.id === host.id}
            onIsPresentedChange={(shown) => setRemoving(shown ? host : undefined)}>
            <ConfirmationDialog.Trigger>
              <Button label="Remove machine" systemImage="trash" role="destructive" modifiers={[disable(!!busy)]}
                onPress={() => setRemoving(host)} />
            </ConfirmationDialog.Trigger>
            <ConfirmationDialog.Actions>
              <Button label="Remove machine and credentials" role="destructive"
                onPress={() => { void remove(host); }} />
            </ConfirmationDialog.Actions>
            <ConfirmationDialog.Message>
              <Text>Existing chats keep their selection and need another environment.</Text>
            </ConfirmationDialog.Message>
          </ConfirmationDialog>
        </Section>)}
        <Section footer={<Text>
          SSH over Tailscale connects to the machine’s existing SSH server. Keep Tailscale connected on your phone and
          the machine. Pi prepares remote execution when you test or connect, and each chat chooses where its tools
          run. Your chat and model connection stay on this phone.
        </Text>}>
          {!snapshot.ready && <Text modifiers={[secondary]}>Loading saved machines…</Text>}
          {snapshot.ready && !snapshot.hosts.length && !snapshot.error && <Text modifiers={[secondary]}>
            No remote machines yet. Local execution remains available in every chat.
          </Text>}
          <Button label="Add remote machine" systemImage="plus"
            modifiers={[disable(!!busy || !snapshot.ready || !!snapshot.error)]}
            onPress={() => router.push('/remote-hosts/edit')} />
        </Section>
      </Form>
    </Host>
  </>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
