import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import { useWatch } from '@earendil-works/chord/react';
import type { Watchable } from '@earendil-works/chord/watch';
import { ANTHROPIC_PROVIDER_ID } from '@pi-agent/infinichat/pi/anthropic-workspace';
import { CLAUDE_CODE_PROVIDER_ID } from '@pi-agent/infinichat/pi/claude-code';
import type { MachineAccess } from '@pi-agent/infinichat/pi/infinichat-remote/client';
import type { SignInAttempt } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import type { ModelCatalog, ProviderOption } from '@pi-agent/infinichat/pi/model-catalog';
import { OPENAI_PROVIDER_ID } from '@pi-agent/infinichat/pi/openai-auth/core';
import type { ProviderAccess } from '@pi-agent/infinichat/pi/provider-credentials';
import { CircleCheckIcon } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';

import { errorText } from '../../lib/error-text';
import { AuthPromptRows } from '../chat/auth-prompt';
import { Notice } from '../chat/notices';
import { Button } from '../ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../ui/field';
import { Input } from '../ui/input';

/**
 * A credential store's sign-ins as the providers list reads and acts on them: the holder machine's object now, this
 * Mac's own with piece 8. The members are the contract's account cells and methods, which both objects share.
 */
export interface ProviderAccount {
  readonly catalog: Watchable<ModelCatalog>;
  readonly access: Watchable<MachineAccess>;
  readonly signInAttempt: Watchable<SignInAttempt>;
  signIn(input: { providerId: string }, context: Context): Promise<number>;
  answer(input: { promptId: number; value: string }, context: Context): Promise<null>;
  cancelSignIn(context: Context): Promise<null>;
  setApiKey(input: { providerId: string; key: string; workspaceId?: string }, context: Context): Promise<null>;
  signOut(input: { providerId: string }, context: Context): Promise<null>;
}

const NOT_READY: ProviderAccess = { ready: false, connected: false };
/** The sign-in this Mac can present, as the phone's registry offers it: ChatGPT's; the other providers take keys. */
const oauthOf = (providerId: string) => providerId === OPENAI_PROVIDER_ID
  ? { name: 'ChatGPT', loginLabel: 'Continue with ChatGPT', isSubscription: true } : undefined;

/** One provider's status, sign-in, API key and disconnect, the phone's `ProviderSection`. */
function ProviderSection({ provider, account }: { provider: ProviderOption; account: ProviderAccount }) {
  const accesses = useWatch(account.access);
  const shown = useWatch(account.signInAttempt) ?? null;
  const access = accesses?.[provider.id] ?? NOT_READY;
  const oauth = oauthOf(provider.id);
  const accountName = oauth?.name ?? provider.name;
  const attempt = shown?.running && shown.providerId === provider.id ? shown : undefined;
  const authStatus = shown?.providerId === provider.id ? shown.status : undefined;
  const [showKey, setShowKey] = useState(false);
  const [key, setKey] = useState('');
  // An Anthropic key that isn't scoped to one workspace is refused unless its requests name one, so its entry takes
  // the workspace's ID too, as the phone's does. It is saved with the key and, like the key, not shown again.
  const takesWorkspace = provider.id === ANTHROPIC_PROVIDER_ID;
  const [workspace, setWorkspace] = useState('');
  const clearEntry = () => {
    setKey('');
    setWorkspace('');
  };
  const [busy, setBusy] = useState<'starting' | 'saving' | 'removing'>();
  const [error, setError] = useState<string>();
  const notice = error ?? access.error;
  const run = (doing: NonNullable<typeof busy>, work: () => Promise<unknown>, fallback: string) => {
    setBusy(doing);
    setError(undefined);
    void work().then(clearEntry, (cause: unknown) => setError(errorText(cause, fallback)))
      .finally(() => setBusy(undefined));
  };
  const status = !access.ready ? 'Restoring connection…'
    : access.connected ? access.type === 'oauth'
      ? provider.id === OPENAI_PROVIDER_ID ? 'Using ChatGPT plan' : `Connected to ${accountName}`
      : 'API key saved'
      : 'Not connected';
  const footer = [
    oauth && attempt === undefined && access.type === 'api_key'
      ? `Signing in replaces the saved API key for ${provider.name}.` : undefined,
    showKey && access.type === 'oauth'
      ? `Saving an API key replaces ${accountName} sign-in for ${provider.name} and uses API billing.` : undefined,
    access.type === 'oauth'
      ? `Requests use your ${accountName} ${oauth?.isSubscription ? 'plan' : 'account'}. `
        + 'Each chat keeps its selected provider and model.'
      : `API key requests use your ${provider.name} API account and its billing. `
        + 'The provider checks your key when you send a message.',
    takesWorkspace && (!oauth || showKey)
      ? 'A key that isn’t scoped to a workspace also needs a workspace ID, from Workspaces in the Claude Console. '
        + 'It is saved with the key, so enter both to change it.' : undefined,
  ].filter(Boolean).join(' ');
  const disabled = busy !== undefined || attempt !== undefined;
  const workspaceId = workspace.trim();
  const save = () => run('saving', () => account.setApiKey({ providerId: provider.id, key,
    ...(workspaceId ? { workspaceId } : {}) }, BACKGROUND_CONTEXT), 'Could not save this provider key.');
  const saveOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || !key.trim() || !access.ready || disabled) return;
    event.preventDefault();
    save();
  };
  const keyInput = (
    <Input type="password" value={key} autoComplete="off" disabled={disabled}
      placeholder={access.connected ? 'Enter a replacement API key' : 'Enter API key'}
      onChange={(event) => setKey(event.target.value)} onKeyDown={saveOnEnter} />
  );
  const saveButton = (
    <Button type="button" size="sm" disabled={!key.trim() || !access.ready || disabled} onClick={save}>
      {busy === 'saving' ? 'Saving…' : access.type === 'oauth' ? 'Use this API key'
        : access.connected ? 'Replace API key' : 'Save API key'}
    </Button>
  );
  return (
    <FieldSet>
      <FieldLegend>{provider.name}</FieldLegend>
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldLabel>Status</FieldLabel>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            {status}
            {access.connected && <CircleCheckIcon className="size-4 text-primary" />}
          </span>
        </Field>
        {oauth && authStatus !== undefined && <p className="text-muted-foreground">{authStatus}</p>}
        {oauth && attempt === undefined && (
          <Button type="button" variant="outline" size="sm" className="self-start"
            disabled={!access.ready || busy !== undefined} onClick={() => {
              setShowKey(false);
              run('starting', () => account.signIn({ providerId: provider.id }, BACKGROUND_CONTEXT),
                'Sign-in could not start.');
            }}>
            {access.connected && access.type === 'oauth' ? `Switch ${accountName} account` : oauth.loginLabel}
          </Button>
        )}
        {oauth && attempt?.prompt !== undefined && (
          <AuthPromptRows key={attempt.prompt.id} pending={attempt.prompt} url={attempt.url}
            submit={(promptId, value) => {
              void account.answer({ promptId, value }, BACKGROUND_CONTEXT).catch(() => {});
            }} />
        )}
        {oauth && attempt !== undefined && (
          <Button type="button" variant="outline" size="sm" className="self-start"
            onClick={() => { void account.cancelSignIn(BACKGROUND_CONTEXT).catch(() => {}); }}>
            Cancel sign-in
          </Button>
        )}
        {oauth && attempt === undefined && (
          <Button type="button" variant="link" size="sm" className="self-start px-0" disabled={busy !== undefined}
            onClick={() => {
              clearEntry();
              setShowKey((show) => !show);
            }}>
            {showKey ? 'Hide API key entry' : 'Use API key'}
          </Button>
        )}
        {(!oauth || showKey) && !takesWorkspace && <div className="flex gap-2">{keyInput}{saveButton}</div>}
        {(!oauth || showKey) && takesWorkspace && (
          <>
            {keyInput}
            <div className="flex gap-2">
              <Input value={workspace} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                disabled={disabled} placeholder="Workspace ID (optional)"
                onChange={(event) => setWorkspace(event.target.value)} onKeyDown={saveOnEnter} />
              {saveButton}
            </div>
          </>
        )}
        {notice !== undefined && <Notice message={notice} />}
        {(access.connected || access.error !== undefined) && (
          <Button type="button" variant="outline" size="sm" className="self-start text-destructive"
            disabled={disabled} onClick={() => run('removing',
              () => account.signOut({ providerId: provider.id }, BACKGROUND_CONTEXT),
              'Could not remove this provider key.')}>
            {busy === 'removing' ? 'Disconnecting…' : `Disconnect ${provider.name}`}
          </Button>
        )}
        <FieldDescription>{footer}</FieldDescription>
      </FieldGroup>
    </FieldSet>
  );
}

/**
 * Claude through a machine's Claude Code login (`claude-code.ts`), the phone's `ClaudeCodeSection`: the machine's
 * `claude` program keeps the sign-in, so there is nothing to enter or remove here, only whether it is signed in. The
 * machine reads it again whenever its models are refreshed.
 */
function ClaudeCodeSection({ provider, account }: { provider: ProviderOption; account: ProviderAccount }) {
  const access = useWatch(account.access)?.[provider.id] ?? NOT_READY;
  const status = !access.ready ? 'Checking Claude Code…'
    : access.connected ? access.type === 'oauth' ? 'Using Claude plan' : 'Signed in with Claude Code'
      : 'Not signed in';
  return (
    <FieldSet>
      <FieldLegend>{provider.name}</FieldLegend>
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldLabel>Status</FieldLabel>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            {status}
            {access.connected && <CircleCheckIcon className="size-4 text-primary" />}
          </span>
        </Field>
        <FieldDescription>
          {access.connected
            ? 'Requests use the machine’s Claude Code sign-in and count against its limits.'
            : 'Claude Code keeps this sign-in on the machine. Install Claude Code there and run “claude auth login” '
              + 'in its terminal, then refresh models to see it here.'}
        </FieldDescription>
      </FieldGroup>
    </FieldSet>
  );
}

/** A section for each provider of the catalog, the one `focus` names first, or OpenAI's. */
export function ProviderSections({ account, focus }: { account: ProviderAccount; focus?: string }) {
  const catalog = useWatch(account.catalog) ?? [];
  const focused = catalog.find((provider) => provider.id === (focus ?? OPENAI_PROVIDER_ID));
  const providers = focused ? [focused, ...catalog.filter((provider) => provider.id !== focused.id)] : catalog;
  return providers.map((provider) => provider.id === CLAUDE_CODE_PROVIDER_ID
    ? <ClaudeCodeSection key={provider.id} provider={provider} account={account} />
    : <ProviderSection key={provider.id} provider={provider} account={account} />);
}
