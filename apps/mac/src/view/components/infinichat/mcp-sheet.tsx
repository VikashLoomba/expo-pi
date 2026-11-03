import type { Host } from '@earendil-works/chord';
import type { McpServerStatus, McpSignInAttempt } from '@pi-agent/infinichat/pi/infinichat-remote/mcp-contract';
import { PlugIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { MacPrincipal } from '../../../contract';
import { useInfiniChatRef } from '../../hooks/use-infinichat';
import { useHeldMcp, type McpRef } from '../../hooks/use-mcp';
import { errorText, useMember } from '../../hooks/use-ref';
import { AuthPromptRows } from '../chat/auth-prompt';
import { Notice } from '../chat/notices';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { FieldDescription, FieldLegend, FieldSet } from '../ui/field';
import {
  Item, ItemActions, ItemContent, ItemDescription, ItemFooter, ItemGroup, ItemMedia, ItemTitle,
} from '../ui/item';
import { FormSheet } from './form-sheet';

const STATES: Readonly<Record<McpServerStatus['state'], string>> = {
  disabled: 'Disabled',
  connecting: 'Connecting',
  connected: 'Connected',
  'needs-sign-in': 'Needs sign-in',
  failed: 'Failed',
  disconnected: 'Disconnected',
};

/**
 * The composer's `/mcp`: the MCP servers of the machine InfiniChat runs on, as pi's coding agent's `/mcp` lists its
 * own, with their sign-ins, which run on that machine and keep its credentials there.
 */
export function McpSheet({ host, open, onClose }: { host: Host<MacPrincipal>; open: boolean; onClose: () => void }) {
  const machine = useMember(useInfiniChatRef().machine)?.name ?? 'the machine';
  return (
    <FormSheet open={open} onClose={onClose} title={`MCP servers on ${machine}`} className="sm:max-w-xl">
      <McpServers host={host} machine={machine} />
    </FormSheet>
  );
}

/** The sheet's content, which holds the servers' reference only while the sheet shows. */
function McpServers({ host, machine }: { host: Host<MacPrincipal>; machine: string }) {
  const api = useHeldMcp(host);
  const loaded = useMember(api.loaded) === true;
  const servers = useMember(api.servers) ?? [];
  const problems = useMember(api.problems) ?? [];
  const unavailable = useMember(api.unavailable) ?? undefined;
  const shown = useMember(api.signInAttempt) ?? null;
  const running = useRef(false);
  useEffect(() => {
    running.current = shown?.running === true;
  }, [shown]);
  // As the providers sheet does: leaving ends the sign-in this sheet shows, and only that.
  useEffect(() => () => {
    if (running.current) void api.cancelSignIn().catch(() => {});
  }, [api]);
  return (
    <div className="-mx-4 flex max-h-[65vh] flex-col gap-5 overflow-y-auto px-4">
      {unavailable !== undefined && <Notice tone="neutral" message={unavailable} />}
      {unavailable === undefined && !loaded && <Notice tone="neutral" message={`Connecting to ${machine}…`} />}
      {loaded && servers.length === 0 && problems.length === 0 && (
        <p className="text-muted-foreground">
          No MCP servers yet. Add them to ~/.infinichat/mcp.json on {machine}, then type /reload-plugins.
        </p>
      )}
      {servers.length > 0 && (
        <ItemGroup className="gap-2">
          {servers.map((server) => <ServerRow key={server.name} api={api} server={server} attempt={shown} />)}
        </ItemGroup>
      )}
      {problems.length > 0 && (
        <FieldSet>
          <FieldLegend>Skipped</FieldLegend>
          {problems.map((problem) => <p key={problem} className="text-muted-foreground">{problem}</p>)}
        </FieldSet>
      )}
      <FieldDescription>
        InfiniChat on {machine} reads its servers from ~/.infinichat/mcp.json there; type /reload-plugins after
        changing it. Sign-ins are saved on that machine, readable only by your account there, and renewed there.
      </FieldDescription>
    </div>
  );
}

/** One server's state, what it offers, its error, and its sign-in, sign-out and reconnect. */
function ServerRow({ api, server, attempt }: { api: McpRef; server: McpServerStatus; attempt: McpSignInAttempt }) {
  const [busy, setBusy] = useState<'starting' | 'signing-out' | 'reconnecting'>();
  const [error, setError] = useState<string>();
  const run = (doing: NonNullable<typeof busy>, work: () => Promise<unknown>, fallback: string) => {
    setBusy(doing);
    setError(undefined);
    void work().catch((cause: unknown) => setError(errorText(cause, fallback))).finally(() => setBusy(undefined));
  };
  const own = attempt?.server === server.name ? attempt : undefined;
  const signingIn = own?.running ? own : undefined;
  const signedIn = server.signIn?.signedIn === true;
  const canSignIn = server.signIn !== undefined && (server.state === 'needs-sign-in' || signedIn);
  const offers = [server.transport === 'http' ? 'Streamable HTTP' : 'stdio',
    `${server.tools} tool${server.tools === 1 ? '' : 's'}`, ...(server.resources ? ['resources'] : [])].join(' · ');
  return (
    <Item variant="outline">
      <ItemMedia variant="icon"><PlugIcon /></ItemMedia>
      <ItemContent>
        <ItemTitle>
          {server.name}
          <Badge variant={server.state === 'failed' || server.state === 'needs-sign-in' ? 'destructive' : 'secondary'}>
            {STATES[server.state]}
          </Badge>
        </ItemTitle>
        <ItemDescription>{offers}</ItemDescription>
        {server.description !== undefined && <ItemDescription>{server.description}</ItemDescription>}
      </ItemContent>
      <ItemActions>
        {canSignIn && signingIn === undefined && (
          <Button type="button" variant="outline" size="sm" disabled={busy !== undefined}
            onClick={() => run('starting', () => api.signIn({ server: server.name }), 'Sign-in could not start.')}>
            {signedIn ? 'Sign In Again' : 'Sign In'}
          </Button>
        )}
        {signedIn && signingIn === undefined && (
          <Button type="button" variant="outline" size="sm" disabled={busy !== undefined}
            onClick={() => run('signing-out', () => api.signOut({ server: server.name }), 'Could not sign out.')}>
            {busy === 'signing-out' ? 'Signing Out…' : 'Sign Out'}
          </Button>
        )}
        {(server.state === 'failed' || server.state === 'disconnected') && (
          <Button type="button" variant="outline" size="sm" disabled={busy !== undefined}
            onClick={() => run('reconnecting', () => api.reconnect({ server: server.name }),
              'The server could not connect.')}>
            {busy === 'reconnecting' ? 'Reconnecting…' : 'Reconnect'}
          </Button>
        )}
      </ItemActions>
      {(server.error !== undefined || own?.status !== undefined || signingIn !== undefined || error !== undefined) && (
        <ItemFooter className="flex-col items-stretch gap-2">
          {server.error !== undefined && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
              {server.error}
            </pre>
          )}
          {own?.status !== undefined && <p className="text-muted-foreground">{own.status}</p>}
          {signingIn?.prompt !== undefined && (
            <AuthPromptRows key={signingIn.prompt.id} pending={signingIn.prompt} url={signingIn.url}
              submit={(promptId, value) => { void api.answer({ promptId, value }).catch(() => {}); }} />
          )}
          {signingIn !== undefined && (
            <Button type="button" variant="outline" size="sm" className="self-start"
              onClick={() => { void api.cancelSignIn().catch(() => {}); }}>
              Cancel Sign-In
            </Button>
          )}
          {error !== undefined && <Notice message={error} />}
        </ItemFooter>
      )}
    </Item>
  );
}
