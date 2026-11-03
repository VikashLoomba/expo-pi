import type { Readable } from '@earendil-works/chord';
import type { MachineAccess } from '@pi-agent/infinichat/pi/infinichat-remote/client';
import type { SignInAttempt } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import type { ModelCatalog, ProviderOption } from '@pi-agent/infinichat/pi/model-catalog';
import { OPENAI_PROVIDER_ID } from '@pi-agent/infinichat/pi/openai-auth/core';
import type { ProviderAccess } from '@pi-agent/infinichat/pi/provider-credentials';
import { CircleCheckIcon } from 'lucide-react';
import { useState } from 'react';

import { errorText, useMember } from '../../hooks/use-ref';
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
  readonly catalog: Readable<ModelCatalog>;
  readonly access: Readable<MachineAccess>;
  readonly signInAttempt: Readable<SignInAttempt>;
  signIn(input: { providerId: string }): Promise<number>;
  answer(input: { promptId: number; value: string }): Promise<void>;
  cancelSignIn(): Promise<void>;
  setApiKey(input: { providerId: string; key: string }): Promise<void>;
  signOut(input: { providerId: string }): Promise<void>;
}

const NOT_READY: ProviderAccess = { ready: false, connected: false };
/** The sign-in this Mac can present, as the phone's registry offers it: ChatGPT's; the other providers take keys. */
const oauthOf = (providerId: string) => providerId === OPENAI_PROVIDER_ID
  ? { name: 'ChatGPT', loginLabel: 'Continue with ChatGPT', isSubscription: true } : undefined;

/** One provider's status, sign-in, API key and disconnect, the phone's `ProviderSection`. */
function ProviderSection({ provider, account }: { provider: ProviderOption; account: ProviderAccount }) {
  const accesses = useMember(account.access);
  const shown = useMember(account.signInAttempt) ?? null;
  const access = accesses?.[provider.id] ?? NOT_READY;
  const oauth = oauthOf(provider.id);
  const accountName = oauth?.name ?? provider.name;
  const attempt = shown?.running && shown.providerId === provider.id ? shown : undefined;
  const authStatus = shown?.providerId === provider.id ? shown.status : undefined;
  const [showKey, setShowKey] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'starting' | 'saving' | 'removing'>();
  const [error, setError] = useState<string>();
  const notice = error ?? access.error;
  const run = (doing: NonNullable<typeof busy>, work: () => Promise<unknown>, fallback: string) => {
    setBusy(doing);
    setError(undefined);
    void work().then(() => setKey(''), (cause: unknown) => setError(errorText(cause, fallback)))
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
  ].filter(Boolean).join(' ');
  const disabled = busy !== undefined || attempt !== undefined;
  const save = () => run('saving', () => account.setApiKey({ providerId: provider.id, key }),
    'Could not save this provider key.');
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
              run('starting', () => account.signIn({ providerId: provider.id }), 'Sign-in could not start.');
            }}>
            {access.connected && access.type === 'oauth' ? `Switch ${accountName} account` : oauth.loginLabel}
          </Button>
        )}
        {oauth && attempt?.prompt !== undefined && (
          <AuthPromptRows key={attempt.prompt.id} pending={attempt.prompt} url={attempt.url}
            submit={(promptId, value) => { void account.answer({ promptId, value }).catch(() => {}); }} />
        )}
        {oauth && attempt !== undefined && (
          <Button type="button" variant="outline" size="sm" className="self-start"
            onClick={() => { void account.cancelSignIn().catch(() => {}); }}>
            Cancel sign-in
          </Button>
        )}
        {oauth && attempt === undefined && (
          <Button type="button" variant="link" size="sm" className="self-start px-0" disabled={busy !== undefined}
            onClick={() => {
              setKey('');
              setShowKey((show) => !show);
            }}>
            {showKey ? 'Hide API key entry' : 'Use API key'}
          </Button>
        )}
        {(!oauth || showKey) && (
          <div className="flex gap-2">
            <Input type="password" value={key} autoComplete="off" disabled={disabled}
              placeholder={access.connected ? 'Enter a replacement API key' : 'Enter API key'}
              onChange={(event) => setKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || !key.trim() || !access.ready || disabled) return;
                event.preventDefault();
                save();
              }} />
            <Button type="button" size="sm" disabled={!key.trim() || !access.ready || disabled} onClick={save}>
              {busy === 'saving' ? 'Saving…' : access.type === 'oauth' ? 'Use this API key'
                : access.connected ? 'Replace API key' : 'Save API key'}
            </Button>
          </div>
        )}
        {notice !== undefined && <Notice message={notice} />}
        {(access.connected || access.error !== undefined) && (
          <Button type="button" variant="outline" size="sm" className="self-start text-destructive"
            disabled={disabled} onClick={() => run('removing',
              () => account.signOut({ providerId: provider.id }), 'Could not remove this provider key.')}>
            {busy === 'removing' ? 'Disconnecting…' : `Disconnect ${provider.name}`}
          </Button>
        )}
        <FieldDescription>{footer}</FieldDescription>
      </FieldGroup>
    </FieldSet>
  );
}

/** A section for each provider of the catalog, the one `focus` names first, or OpenAI's. */
export function ProviderSections({ account, focus }: { account: ProviderAccount; focus?: string }) {
  const catalog = useMember(account.catalog) ?? [];
  const focused = catalog.find((provider) => provider.id === (focus ?? OPENAI_PROVIDER_ID));
  const providers = focused ? [focused, ...catalog.filter((provider) => provider.id !== focused.id)] : catalog;
  return providers.map((provider) => <ProviderSection key={provider.id} provider={provider} account={account} />);
}
