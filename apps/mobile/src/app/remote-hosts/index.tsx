import {
  Button, ConfirmationDialog, Form, Host, HStack, LabeledContent, ProgressView, Section, Text,
} from '@expo/ui/swift-ui';
import { disabled as disable, font, foregroundStyle, textSelection } from '@expo/ui/swift-ui/modifiers';
import { machineEndpoint } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import { forgetSecret, removeClient, savedSecret } from '@pi-agent/infinichat/pi/infinichat-remote/install';
import type { MoveStatus } from '@pi-agent/infinichat/pi/infinichat-remote/move';
import { router, Stack } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, AppState, StyleSheet } from 'react-native';

import { useChatApp, useInfiniChatMachines } from '@/chat/chat-provider';
import { SettingsNotice } from '@/components/chat/settings-controls';
import { useChatColors } from '@/hooks/use-chat-colors';
import type { RemoteHost } from '@/pi/execution/remote/hosts';
import { failureCode, setupStageLabels, testRemoteHost } from '@/pi/execution/remote/test-host';
import { phoneClient } from '@/pi/infinichat-remote/phone-client';
import { createCredentialBackend } from '@/pi/secure-storage';

const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });
const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(1);

/** The move back a removal runs first, worded as the InfiniChat header words its steps. */
function movingBack(move: MoveStatus, name: string): string {
  if (move.undoing) return `Cancelling the move to ${name}…`;
  const copied = move.copied ? ` · ${megabytes(move.copied.bytes)} of ${megabytes(move.copied.total)} MB` : '';
  return move.step === 'copying' ? `Copying InfiniChat from ${name}${copied}`
    : move.step === 'opening' ? 'Opening InfiniChat on this iPhone…' : `Closing InfiniChat on ${name}…`;
}

export default function RemoteHostsScreen() {
  const colors = useChatColors();
  const { remoteHosts, remote, moves, infiniChatHome: home, infiniChatMove: move } = useChatApp();
  const snapshot = useSyncExternalStore(remoteHosts.subscribe, remoteHosts.getSnapshot, remoteHosts.getSnapshot);
  // While InfiniChat runs on a machine, its tools reach the others with that machine's own SSH.
  const infiniChat = useInfiniChatMachines();
  const infiniChatHost = infiniChat && snapshot.hosts.find((host) => host.id === infiniChat.machineId);
  const [busy, setBusy] = useState<string>();
  const [testing, setTesting] = useState(false);
  const [progress, setProgress] = useState('Connecting through Tailscale…');
  const [notice, setNotice] = useState<{ message: string; error?: boolean; trust?: RemoteHost }>();
  const [removing, setRemoving] = useState<RemoteHost>();
  const [releasing, setReleasing] = useState<RemoteHost>();
  const active = useRef<AbortController | undefined>(undefined);
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
        onProgress: (stage) => { if (mounted.current) setProgress(setupStageLabels[stage]); } });
      if (mounted.current) {
        setNotice({ message: `Connected to ${host.name} and ready for remote execution. `
          + `Pi ${result.version} on ${result.os} (${result.arch}).` });
      }
    } catch (error) {
      if (mounted.current) {
        setNotice({ message: error instanceof Error ? error.message : 'Connection check failed.',
          error: !controller.signal.aborted,
          ...(failureCode(error) === 'HOST_KEY_REJECTED' ? { trust: host } : {}) });
      }
    } finally {
      active.current = undefined;
      if (mounted.current) {
        setBusy(undefined);
        setTesting(false);
      }
    }
  };
  const remove = async (host: RemoteHost) => {
    setBusy(host.id);
    setNotice(undefined);
    setReleasing(host);
    try {
      if (!moves) throw new Error('InfiniChat is still starting. Try again.');
      // Moving InfiniChat back needs this machine's credentials, which removing it deletes, so the move runs first;
      // its failure removes nothing.
      await moves.bringBack(host.id).catch((error: unknown) => {
        throw new Error(`InfiniChat couldn’t move back to this iPhone, so ${host.name} wasn’t removed. `
          + (error instanceof Error ? error.message : String(error)));
      });
      // This iPhone's secret has a file on the machine only if it installed InfiniChat there. Removing it, while its
      // credentials are still here to reach the machine, makes the server refuse that secret; an unreachable machine
      // keeps the file.
      const credentials = createCredentialBackend();
      if (await savedSecret(credentials, host.id) !== undefined) {
        await remote.environment(host.id, undefined).then((machine) => removeClient(machine, phoneClient().id))
          .catch(() => {});
      }
      await remoteHosts.remove(host.id, host);
      moves.forget(host.id);
      // Left behind, it would only clutter the Keychain.
      await forgetSecret(credentials, host.id).catch(() => {});
      setNotice({ message: 'Machine removed. Chats that selected it keep their selection until you choose another '
        + 'environment.' });
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'Could not remove this machine.', error: true });
    } finally {
      setBusy(undefined);
      setReleasing(undefined);
    }
  };
  /** A changed host key is the one signal left to the user: trusting the new one is confirmed, then checked at once. */
  const trustNewKey = (host: RemoteHost) => {
    Alert.alert(`Trust ${host.name}’s new SSH key?`,
      'Its SSH host key changed since it was trusted. Continue only if you reinstalled or replaced the machine; '
      + 'otherwise something else may be answering at its address.',
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Trust', style: 'destructive', onPress: () => {
        void remoteHosts.forgetHostKey(host).then(() => test(host), (error: unknown) => {
          setNotice({ message: error instanceof Error ? error.message : 'Could not forget the trusted key.',
            error: true });
        });
      } }]);
  };
  const restore = () => { void remoteHosts.restore().catch(() => {}); };
  const acceptOnInfiniChatHost = async (host: RemoteHost, fingerprints: string[]) => {
    if (!infiniChat) return;
    setBusy(host.id);
    setNotice(undefined);
    try {
      await infiniChat.accept(machineEndpoint(host), fingerprints);
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'Could not accept the SSH host key.',
        error: true });
    } finally {
      setBusy(undefined);
    }
  };
  /** What lets the machine InfiniChat runs on into `host`: its InfiniChat key, which Test connection exchanges. */
  const keyHint = (host: RemoteHost) => {
    if (!infiniChatHost) return null;
    const key = infiniChatHost.publicKey;
    const hint = key === undefined
      ? `Check connection on ${infiniChatHost.name} first, so this phone learns its InfiniChat key.`
      : host.authorizedKeys?.includes(key) ? undefined
        : `Check connection here authorizes ${infiniChatHost.name}’s InfiniChat key on ${host.name}.`;
    return hint === undefined ? null
      : <Text modifiers={[secondary, font({ textStyle: 'footnote' })]}>{hint}</Text>;
  };
  /** Whether the machine InfiniChat runs on reaches `host`, and the host key it waits to have accepted there. */
  const reachFromInfiniChat = (host: RemoteHost) => {
    const reaches = infiniChat?.reach;
    if (!infiniChatHost || !reaches || host.id === infiniChatHost.id) return null;
    const from = infiniChatHost.name;
    const endpoint = machineEndpoint(host);
    const reach = reaches[endpoint];
    const waiting = infiniChat.pending?.[endpoint];
    const failed = waiting !== undefined || (reach !== undefined && !reach.reachable);
    const status = waiting !== undefined ? (waiting.changed ? 'SSH host key changed' : 'SSH host key to verify')
      : reach === undefined ? 'Checking…' : reach.reachable ? 'Reachable' : 'Can’t connect';
    return <>
      <LabeledContent label={`From ${from}`}>
        <Text modifiers={[failed ? foregroundStyle(colors.danger) : secondary]}>{status}</Text>
      </LabeledContent>
      {waiting === undefined && reach !== undefined && !reach.reachable && <Text
        modifiers={[secondary, font({ textStyle: 'footnote' }), textSelection(true)]}>{reach.error}</Text>}
      {waiting === undefined && reach !== undefined && !reach.reachable && keyHint(host)}
      {waiting !== undefined && <>
        <Text modifiers={[secondary]}>
          {`${host.name}’s SSH host key changed since ${from} trusted it. Accept it on ${from} only if you `
            + `reinstalled or replaced ${host.name}; otherwise something else may be answering at its address.`}
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
        {testing && <Section title="Connection check">
          <HStack spacing={10}>
            <ProgressView />
            <Text modifiers={[secondary]}>{progress}</Text>
          </HStack>
          <Button label="Cancel connection check" onPress={() => active.current?.abort()} />
        </Section>}
        {releasing && move?.running && <Section title={`Removing ${releasing.name}`}>
          <HStack spacing={10}>
            <ProgressView />
            <Text modifiers={[secondary]}>{movingBack(move, releasing.name)}</Text>
          </HStack>
        </Section>}
        {snapshot.error && <SettingsNotice message={snapshot.error} action="Retry" onAction={restore} />}
        {snapshot.cleanupError && <SettingsNotice message={snapshot.cleanupError} action="Retry cleanup"
          onAction={restore} />}
        {notice && <SettingsNotice testID="remote-host-notice" message={notice.message}
          tone={notice.error ? 'error' : 'neutral'} action={notice.trust && !busy ? 'Trust new key' : undefined}
          onAction={() => { if (notice.trust) trustNewKey(notice.trust); }} />}
        {snapshot.hosts.map((host) => <Section key={host.id} title={host.name}>
          <LabeledContent label="Address">
            <Text modifiers={[secondary, textSelection(true)]}>{`${host.username}@${host.hostname}:${host.port}`}</Text>
          </LabeledContent>
          <LabeledContent label="Credential">
            <Text modifiers={[secondary]}>{host.credentialType === 'password' ? 'Password' : 'Private key'}</Text>
          </LabeledContent>
          {reachFromInfiniChat(host)}
          <Button label="Check connection" systemImage="bolt.horizontal" modifiers={[disable(!!busy)]}
            onPress={() => { void test(host); }} />
          <Button label="Edit machine" systemImage="pencil" modifiers={[disable(!!busy)]}
            onPress={() => router.push({ pathname: '/remote-hosts/edit', params: { id: host.id } })} />
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
              <Text>{(home.home === 'machine' && home.machineId === host.id
                ? 'InfiniChat’s conversation moves back to this iPhone first. ' : '')
                + 'Existing chats keep their selection and need another environment.'}</Text>
            </ConfirmationDialog.Message>
          </ConfirmationDialog>
        </Section>)}
        <Section footer={<Text>
          SSH over Tailscale connects to the machine’s existing SSH server. Keep Tailscale connected on your phone and
          the machine. Adding a machine connects to it, trusts its SSH host key on first use, prepares remote
          execution, gives it an InfiniChat SSH key and authorizes the other machines’ keys there, so InfiniChat
          reaches your machines from whichever one it runs on. Each chat chooses where its tools run; your chat and
          model connection stay on this phone.
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
