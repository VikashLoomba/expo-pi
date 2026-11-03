import { Button, Form, Host, Label, LabeledContent, Section, Text } from '@expo/ui/swift-ui';
import { disabled as disable, foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import type { McpServerStatus } from '@pi-agent/infinichat/pi/infinichat-remote/mcp-contract';
import { router, Stack } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';

import { useInfiniChatConnection } from '@/chat/chat-provider';
import { MCP_ON_PHONE, useInfiniChatMcp } from '@/chat/use-infinichat-mcp';
import { AuthPromptRows } from '@/components/chat/auth-prompt';
import { SettingsNotice } from '@/components/chat/settings-controls';
import { useChatColors } from '@/hooks/use-chat-colors';

const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });
const STATES: Readonly<Record<McpServerStatus['state'], string>> = {
  disabled: 'Turned off', connecting: 'Connecting…', connected: 'Connected', 'needs-sign-in': 'Needs sign-in',
  failed: 'Failed to connect', disconnected: 'Disconnected',
};

/** A server's state, then what it offers once connected. */
function summary(server: McpServerStatus): string {
  if (server.state !== 'connected') return STATES[server.state];
  const tools = `${server.tools} tool${server.tools === 1 ? '' : 's'}`;
  return [STATES.connected, tools, ...(server.resources ? ['resources'] : [])].join(' · ');
}

/** One server's state, its error, and its sign-in, sign-out and reconnect. */
function ServerSection({ server, mcp }: { server: McpServerStatus; mcp: ReturnType<typeof useInfiniChatMcp> }) {
  const colors = useChatColors();
  const attempt = mcp.view?.signInAttempt;
  const signingIn = attempt?.running === true && attempt.server === server.name;
  const anySignIn = attempt?.running === true;
  const signedIn = server.signIn?.signedIn === true;
  const notice = mcp.notice?.server === server.name ? mcp.notice.message : undefined;
  const ended = attempt?.server === server.name && !attempt.running ? attempt.status : undefined;
  const footer = server.state === 'disabled' ? 'Turned off in ~/.infinichat/mcp.json.'
    : server.signIn ? `${signedIn ? 'Signed in.' : 'Not signed in.'} The machine keeps the sign-in and renews it.`
      : undefined;
  return <Section title={server.name} footer={footer === undefined ? undefined : <Text>{footer}</Text>}>
    <LabeledContent label={server.transport === 'http' ? 'Streamable HTTP' : 'Command'}>
      <Text modifiers={[secondary]}>{summary(server)}</Text>
    </LabeledContent>
    {server.description && <Text modifiers={[secondary]}>{server.description}</Text>}
    {server.error && <Label title={server.error} systemImage="exclamationmark.triangle"
      modifiers={[foregroundStyle(colors.danger)]} />}
    {signingIn && attempt.status && <Text modifiers={[secondary]}>{attempt.status}</Text>}
    {signingIn && attempt.prompt && <AuthPromptRows key={attempt.prompt.id} pending={attempt.prompt}
      submit={mcp.answer} openBrowser={() => { void mcp.openSignInPage(); }} browserOpen={mcp.browserOpen} />}
    {signingIn && <Button label="Cancel sign-in" onPress={mcp.cancelSignIn} />}
    {!signingIn && ended && <Text modifiers={[secondary]}>{ended}</Text>}
    {server.signIn && !signingIn && <Button label={signedIn ? 'Sign in again' : 'Sign in'}
      modifiers={[disable(anySignIn || mcp.busy !== undefined)]} onPress={() => { void mcp.signIn(server.name); }} />}
    {server.state !== 'disabled' && !signingIn && <Button label="Reconnect"
      modifiers={[disable(mcp.busy !== undefined)]} onPress={() => { void mcp.reconnect(server.name); }} />}
    {signedIn && !signingIn && <Button role="destructive" label="Sign out"
      modifiers={[disable(mcp.busy !== undefined)]} onPress={() => { void mcp.signOut(server.name); }} />}
    {notice && <Label title={notice} systemImage="exclamationmark.circle"
      modifiers={[foregroundStyle(colors.danger)]} />}
  </Section>;
}

/**
 * `/mcp`: the MCP servers of the machine InfiniChat runs on, as pi's coding agent's `/mcp` lists its servers, with
 * their state, sign-in for those that sign in with OAuth, and reconnect. The sign-ins run on that machine and stay
 * there; this iPhone's browser returns to them.
 */
export default function InfiniChatMcpScreen() {
  const colors = useChatColors();
  const mcp = useInfiniChatMcp();
  const { view, machine, cancelSignIn } = mcp;
  const connection = useInfiniChatConnection();
  // As the providers screen does: leaving ends the sign-in this screen shows.
  useEffect(() => () => cancelSignIn(), [cancelSignIn]);
  const servers = view?.servers ?? [];
  return <>
    <Stack.Screen options={{ title: machine === undefined ? 'MCP servers' : `MCP on ${machine}` }} />
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Button icon="xmark" accessibilityLabel="Close MCP servers"
        onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/'); }} />
    </Stack.Toolbar>
    <Host style={styles.fill} seedColor={colors.accent} testID="infinichat-mcp-screen">
      <Form>
        {machine === undefined && <SettingsNotice tone="neutral" message={MCP_ON_PHONE} />}
        {connection?.status === 'connecting' && <SettingsNotice tone="neutral" testID="infinichat-mcp-connecting"
          message={`Connecting to ${machine ?? 'the machine'}…`} />}
        {connection?.status === 'failed' && <SettingsNotice testID="infinichat-mcp-failed"
          message={connection.error} action="Try Again" onAction={connection.retry} />}
        {view?.unavailable && <SettingsNotice tone="neutral" message={view.unavailable} />}
        {machine !== undefined && view !== undefined && !view.unavailable && servers.length === 0
          && <SettingsNotice tone="neutral" message="No MCP servers are configured." />}
        {servers.map((server) => <ServerSection key={server.name} server={server} mcp={mcp} />)}
        {view !== undefined && view.problems.length > 0 && <Section title="Skipped">
          {view.problems.map((problem) => <Label key={problem} title={problem} systemImage="exclamationmark.circle"
            modifiers={[secondary]} />)}
        </Section>}
        {machine !== undefined && <Section footer={<Text>
          {`The servers come from ~/.infinichat/mcp.json on ${machine}. After changing it, type /reload-plugins. `
            + 'Their log messages go to ~/.infinichat/mcp.log there.'}
        </Text>}>
          <Label title={`Configured on ${machine}`} systemImage="server.rack" />
        </Section>}
      </Form>
    </Host>
  </>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
