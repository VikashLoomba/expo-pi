import type { Machine } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import { ServerIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import type { Check } from '../../../contract';
import type { MachinesRef } from '../../hooks/use-machines';
import { errorText, useMember } from '../../hooks/use-ref';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '../ui/alert-dialog';
import { Alert, AlertDescription } from '../ui/alert';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '../ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field';
import { Input } from '../ui/input';
import {
  Item, ItemActions, ItemContent, ItemDescription, ItemFooter, ItemGroup, ItemMedia, ItemTitle,
} from '../ui/item';
import { Spinner } from '../ui/spinner';

const STAGES: Record<NonNullable<Check['stage']>, string> = {
  connecting: 'Connecting…', approving: 'Approve the SSH sign-in in your browser…',
  checking: 'Checking the machine…', exchanging: 'Exchanging InfiniChat keys…',
};
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * The machines of the conversation, as the phone's Remote machines lists them: each with its endpoint, how this Mac
 * reaches it, what the holder's server found of it, and this Mac's own check; adding and editing in a form below.
 */
export function MachinesPane({ machines: api }: { machines: MachinesRef }) {
  const listed = useMember(api.machines);
  const self = useMember(api.self);
  const holder = useMember(api.holder) ?? null;
  const [editing, setEditing] = useState<{ endpoint?: string }>();
  const [notice, setNotice] = useState<string>();
  const rows = Object.entries(listed?.machines ?? {}).sort(([, a], [, b]) => a.name.localeCompare(b.name));
  const act = (work: Promise<unknown>, fallback: string) => {
    setNotice(undefined);
    void work.catch((error: unknown) => setNotice(errorText(error, fallback)));
  };
  return (
    <div className="pane-scroll">
      <header className="pane-header">
        <h1 className="pane-title">Machines</h1>
        <Button type="button" variant="outline" size="sm" disabled={listed === undefined || listed === null}
          onClick={() => setEditing({})}>Add Machine…</Button>
      </header>
      {listed === undefined && <p className="pane-note">Loading the machines…</p>}
      {listed === null && <p className="pane-note">
        InfiniChat isn’t open on this Mac or reachable, so its machines can’t be read or changed right now.
      </p>}
      {notice !== undefined && <Alert variant="destructive"><AlertDescription>{notice}</AlertDescription></Alert>}
      {editing !== undefined && (
        <MachineForm api={api} endpoint={editing.endpoint} onDone={() => setEditing(undefined)}
          initial={editing.endpoint === undefined ? undefined : listed?.machines[editing.endpoint]} />
      )}
      {listed !== undefined && listed !== null && rows.length === 0 && editing === undefined && (
        <p className="pane-note">No machines yet. Add one to reach it from InfiniChat wherever it runs.</p>
      )}
      <ItemGroup>
        {rows.map(([endpoint, machine]) => (
          <MachineRow key={endpoint} api={api} endpoint={endpoint} machine={machine} isSelf={endpoint === self}
            isHolder={endpoint === holder}
            onEdit={() => setEditing({ endpoint })} act={act} />
        ))}
      </ItemGroup>
    </div>
  );
}

function MachineRow({ api, endpoint, machine, isSelf, isHolder, onEdit, act }: {
  api: MachinesRef; endpoint: string; machine: Machine; isSelf: boolean;
  /** The machine InfiniChat runs on: the reach from InfiniChat is its own, so the row shows none. */
  isHolder: boolean;
  onEdit: () => void;
  act: (work: Promise<unknown>, fallback: string) => void;
}) {
  const checks = useMember(api.checks);
  const identities = useMember(api.identities);
  const reaches = useMember(api.reach);
  const pending = useMember(api.pendingHostKeys);
  const check = checks?.[endpoint];
  const identity = identities?.[endpoint];
  const reach = reaches?.[endpoint];
  const waiting = pending?.[endpoint];
  const running = check?.stage !== undefined;
  const chooseIdentity = () => act(api.pickIdentityFile().then((path) => {
    if (path !== null) return api.setIdentity({ endpoint, path });
  }), 'The identity file could not be chosen.');
  return (
    <Item variant="outline" className="machine-item">
      <ItemMedia variant="icon"><ServerIcon /></ItemMedia>
      <ItemContent>
        <ItemTitle className="machine-title">
          <span className="machine-name">{machine.name}</span>
          {isSelf && <Badge variant="secondary">This Mac</Badge>}
          {isHolder && <Badge variant="secondary">Runs InfiniChat</Badge>}
        </ItemTitle>
        <ItemDescription><code className="machine-endpoint">{endpoint}</code></ItemDescription>
      </ItemContent>
      <ItemActions className="row-actions">
        {running
          ? <Button type="button" variant="outline" size="sm" onClick={() => act(api.cancelCheck({ endpoint }), '')}>
            Cancel
          </Button>
          : <Button type="button" variant="outline" size="sm"
            onClick={() => act(api.check({ endpoint }), 'The check could not start.')}>Check Connection</Button>}
        <Button type="button" variant="outline" size="sm" disabled={running} onClick={onEdit}>Edit…</Button>
        <AlertDialog>
          <AlertDialogTrigger render={<Button type="button" variant="outline" size="sm" className="button-danger"
            disabled={running || isSelf} />}>
            Remove…
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {machine.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                The machine leaves InfiniChat’s list on every device, and this Mac’s access to it is removed there.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive"
                onClick={() => act(api.remove({ endpoint }), 'The machine could not be removed.')}>
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </ItemActions>
      <ItemFooter className="machine-footer">
      <dl className="machine-meta">
        <dt>Reached with</dt>
        <dd>
          {identity === undefined ? 'Your SSH setup' : basename(identity)}
          <button type="button" className="link-button" onClick={chooseIdentity}>Choose identity file…</button>
          {identity !== undefined && <button type="button" className="link-button"
            onClick={() => act(api.setIdentity({ endpoint, path: null }), 'The identity file could not be forgotten.')}>
            Use your SSH setup
          </button>}
        </dd>
        {!isSelf && !isHolder && reaches !== undefined && reaches !== null && (
          <>
            <dt>From InfiniChat</dt>
            <dd className={waiting !== undefined || (reach !== undefined && !reach.reachable) ? 'failed' : undefined}>
              {waiting !== undefined ? (waiting.changed ? 'SSH host key changed' : 'SSH host key to verify')
                : reach === undefined ? 'Checking…' : reach.reachable ? 'Reachable' : 'Can’t connect'}
              {reach !== undefined && !reach.reachable && waiting === undefined && (
                <span className="machine-detail">{reach.error}</span>
              )}
              {waiting !== undefined && (
                <span className="machine-detail">
                  {waiting.keys.map((key) => (
                    <code key={key.fingerprint}>{`${key.algorithm} ${key.fingerprint}`}</code>
                  ))}
                  <Button type="button" variant="link" size="xs" onClick={() => act(
                    api.acceptHostKey({ endpoint, fingerprints: waiting.keys.map((key) => key.fingerprint) }),
                    'The host key could not be accepted.')}>
                    {waiting.changed ? 'Accept verified replacement key' : 'Accept verified key'}
                  </Button>
                </span>
              )}
            </dd>
          </>
        )}
        {check !== undefined && (
          <>
            <dt>Check</dt>
            <dd className={check.error !== undefined ? 'failed' : undefined}>
              {check.stage !== undefined && <><Spinner />{STAGES[check.stage]}</>}
              {check.result !== undefined && `Connected to ${check.result.name}: Pi ${check.result.version} on `
                + `${check.result.os} (${check.result.arch}). InfiniChat keys exchanged.`}
              {check.error !== undefined && check.error}
              {check.pendingKey !== undefined && (
                <Button type="button" variant="link" size="xs"
                  onClick={() => act(api.trustNewKey({ endpoint }), 'The new key could not be trusted.')}>
                  Trust new key
                </Button>
              )}
            </dd>
          </>
        )}
      </dl>
      </ItemFooter>
    </Item>
  );
}

/** Hostname, port and username; Save lists the machine and checks it at once, as the phone's form does. */
function MachineForm({ api, initial, endpoint, onDone }: {
  api: MachinesRef; initial?: Machine; endpoint?: string; onDone: () => void;
}) {
  const [hostname, setHostname] = useState(initial?.hostname ?? '');
  const [port, setPort] = useState(String(initial?.port ?? 22));
  const [username, setUsername] = useState(initial?.username ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    if (!/^\d+$/.test(port.trim())) {
      setError('SSH port must be a number from 1 to 65535.');
      return;
    }
    setSaving(true);
    setError(undefined);
    const form = { hostname, port: Number(port), username, ...(endpoint === undefined ? {} : { previous: endpoint }) };
    void api.save(form).then(() => {
      const saved = `${username.trim()}@${hostname.trim().toLowerCase()}:${Number(port)}`;
      void api.check({ endpoint: saved }).catch(() => {});
      onDone();
    }, (cause: unknown) => {
      setError(errorText(cause, 'The machine could not be saved.'));
    }).finally(() => setSaving(false));
  };
  return (
    <form onSubmit={submit}>
    <Card className="machine-form">
      <CardHeader>
        <CardTitle>{initial === undefined ? 'Add Machine' : `Edit ${initial.name}`}</CardTitle>
      </CardHeader>
      <CardContent>
        {error !== undefined && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="machine-hostname">Hostname</FieldLabel>
            <Input id="machine-hostname" value={hostname} placeholder="machine.tailnet.ts.net" autoFocus
              onChange={(event) => setHostname(event.target.value)} />
          </Field>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="machine-port">Port</FieldLabel>
            <Input id="machine-port" value={port} inputMode="numeric"
              onChange={(event) => setPort(event.target.value)} />
          </Field>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="machine-username">Username</FieldLabel>
            <Input id="machine-username" value={username} placeholder="Remote account"
              onChange={(event) => setUsername(event.target.value)} />
          </Field>
          <FieldDescription>
            The machine is reached with your SSH setup, or the identity file you choose for it, and names itself
            when it connects. Saving checks it at once and joins it to InfiniChat’s list on every device.
          </FieldDescription>
        </FieldGroup>
      </CardContent>
      <CardFooter className="row-actions">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? 'Saving…' : initial === undefined ? 'Add' : 'Save'}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={saving} onClick={onDone}>Cancel</Button>
      </CardFooter>
    </Card>
    </form>
  );
}
