import type { Machine } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import { useState, type FormEvent } from 'react';

import type { Check } from '../../../contract';
import type { MachinesRef } from '../../hooks/use-machines';
import { errorText, useMember } from '../../hooks/use-ref';

const STAGES: Record<NonNullable<Check['stage']>, string> = {
  connecting: 'Connecting…', checking: 'Checking the machine…', exchanging: 'Exchanging InfiniChat keys…',
};
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * The machines of the conversation, as the phone's Remote machines lists them: each with its endpoint, how this Mac
 * reaches it, what the holder's server found of it, and this Mac's own check; adding and editing in a form below.
 */
export function MachinesPane({ machines: api }: { machines: MachinesRef }) {
  const listed = useMember(api.machines);
  const self = useMember(api.self);
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
        <button type="button" className="button" disabled={listed === undefined || listed === null}
          onClick={() => setEditing({})}>Add Machine…</button>
      </header>
      {listed === undefined && <p className="pane-note">Loading the machines…</p>}
      {listed === null && <p className="pane-note">
        InfiniChat isn’t open on this Mac or reachable, so its machines can’t be read or changed right now.
      </p>}
      {notice !== undefined && <p className="notice notice-error">{notice}</p>}
      {editing !== undefined && (
        <MachineForm api={api} endpoint={editing.endpoint} onDone={() => setEditing(undefined)}
          initial={editing.endpoint === undefined ? undefined : listed?.machines[editing.endpoint]} />
      )}
      {listed !== undefined && listed !== null && rows.length === 0 && editing === undefined && (
        <p className="pane-note">No machines yet. Add one to reach it from InfiniChat wherever it runs.</p>
      )}
      {rows.map(([endpoint, machine]) => (
        <MachineRow key={endpoint} api={api} endpoint={endpoint} machine={machine} isSelf={endpoint === self}
          onEdit={() => setEditing({ endpoint })} act={act} />
      ))}
    </div>
  );
}

function MachineRow({ api, endpoint, machine, isSelf, onEdit, act }: {
  api: MachinesRef; endpoint: string; machine: Machine; isSelf: boolean; onEdit: () => void;
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
    <article className="machine-card">
      <div className="machine-title">
        <span className="machine-name">{machine.name}</span>
        {isSelf && <span className="tag">This Mac</span>}
        <code className="machine-endpoint">{endpoint}</code>
      </div>
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
        {!isSelf && reaches !== undefined && reaches !== null && (
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
                  <button type="button" className="link-button" onClick={() => act(
                    api.acceptHostKey({ endpoint, fingerprints: waiting.keys.map((key) => key.fingerprint) }),
                    'The host key could not be accepted.')}>
                    {waiting.changed ? 'Accept verified replacement key' : 'Accept verified key'}
                  </button>
                </span>
              )}
            </dd>
          </>
        )}
        {check !== undefined && (
          <>
            <dt>Check</dt>
            <dd className={check.error !== undefined ? 'failed' : undefined}>
              {check.stage !== undefined && <><span className="spinner" />{STAGES[check.stage]}</>}
              {check.result !== undefined && `Connected to ${check.result.name}: Pi ${check.result.version} on `
                + `${check.result.os} (${check.result.arch}). InfiniChat keys exchanged.`}
              {check.error !== undefined && check.error}
              {check.pendingKey !== undefined && (
                <button type="button" className="link-button"
                  onClick={() => act(api.trustNewKey({ endpoint }), 'The new key could not be trusted.')}>
                  Trust new key
                </button>
              )}
            </dd>
          </>
        )}
      </dl>
      <div className="row-actions">
        {running
          ? <button type="button" className="button" onClick={() => act(api.cancelCheck({ endpoint }), '')}>
            Cancel
          </button>
          : <button type="button" className="button"
            onClick={() => act(api.check({ endpoint }), 'The check could not start.')}>Check Connection</button>}
        <button type="button" className="button" disabled={running} onClick={onEdit}>Edit…</button>
        <button type="button" className="button button-danger" disabled={running || isSelf}
          onClick={() => act(api.remove({ endpoint }), 'The machine could not be removed.')}>Remove</button>
      </div>
    </article>
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
    <form className="machine-form" onSubmit={submit}>
      <h2 className="form-title">{initial === undefined ? 'Add Machine' : `Edit ${initial.name}`}</h2>
      {error !== undefined && <p className="notice notice-error">{error}</p>}
      <label className="field"><span>Hostname</span>
        <input className="text-input" value={hostname} placeholder="machine.tailnet.ts.net" autoFocus
          onChange={(event) => setHostname(event.target.value)} /></label>
      <label className="field"><span>Port</span>
        <input className="text-input" value={port} inputMode="numeric"
          onChange={(event) => setPort(event.target.value)} />
      </label>
      <label className="field"><span>Username</span>
        <input className="text-input" value={username} placeholder="Remote account"
          onChange={(event) => setUsername(event.target.value)} /></label>
      <p className="pane-note">
        The machine is reached with your SSH setup, or the identity file you choose for it, and names itself when it
        connects. Saving checks it at once and joins it to InfiniChat’s list on every device.
      </p>
      <div className="row-actions">
        <button type="submit" className="button button-primary" disabled={saving}>
          {saving ? 'Saving…' : initial === undefined ? 'Add' : 'Save'}
        </button>
        <button type="button" className="button" disabled={saving} onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
