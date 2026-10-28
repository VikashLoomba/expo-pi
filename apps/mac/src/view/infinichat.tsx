import { uuidv7 } from '@earendil-works/pi-ai';
import type { Host } from '@earendil-works/chord';
import type { ChatMessage } from '@pi-agent/infinichat/chat/types';
import type { InstallStage } from '@pi-agent/infinichat/pi/infinichat-remote/dialer';
import { userInput } from '@pi-agent/infinichat/pi/user-input';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { MacInfiniChat, type MacPrincipal } from '../contract';
import { useMember } from './use-ref';

const TITLE = 'InfiniChat';
const NO_MESSAGES: readonly ChatMessage[] = [];
const MODELS_REQUIRED = 'Choose InfiniChat’s main and summary models in its settings to send a message.';

const connecting = (machine: string, stage: InstallStage | undefined) => stage === 'uploading'
  ? `Installing InfiniChat on ${machine}…`
  : stage === 'starting' ? `Starting InfiniChat on ${machine}…` : `Connecting to ${machine}…`;

/** A draft keeps one request ID for every attempt to send it, so a resend after a failure is admitted once. */
type Draft = { text: string; requestId: string };
const emptyDraft = (): Draft => ({ text: '', requestId: uuidv7() });

function Row({ message }: { message: ChatMessage }) {
  const text = message.role === 'tool' && message.tool
    ? `${message.tool.name} · ${message.tool.status}` : message.text;
  return (
    <div className={`row row-${message.role}`}>
      <div className="bubble">
        {text}
        {message.error !== undefined && <div className="row-error">{message.error}</div>}
      </div>
    </div>
  );
}

/** InfiniChat's one conversation, as the phone's screen shows it (`(infinichat)/index.tsx`), without Markdown yet. */
export function InfiniChat({ host }: { host: Host<MacPrincipal> }) {
  const [ref] = useState(() => host.hold(MacInfiniChat, {}));
  useEffect(() => () => ref.release(), [ref]);
  const snapshot = useMember(ref.snapshot);
  const controls = useMember(ref.controls);
  const messages = useMember(ref.messages) ?? NO_MESSAGES;
  const connection = useMember(ref.connection);
  const held = useMember(ref.held);
  const machine = useMember(ref.machine);
  const [draft, setDraft] = useState(emptyDraft);
  const [admitting, setAdmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const transcript = useRef<HTMLDivElement>(null);
  const name = controls?.name || TITLE;
  const busy = !!controls?.busy;
  const configured = !!controls?.configured;
  const machineName = machine?.name ?? 'this Mac';
  // The transcript follows new messages while it is scrolled to the end.
  useEffect(() => {
    const element = transcript.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 80) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages]);

  const send = async () => {
    const text = draft.text.trim();
    if (!text || admitting || !configured) return;
    setAdmitting(true);
    setLocalError(undefined);
    try {
      await ref.accept({ content: userInput(text, []), requestId: draft.requestId });
      setDraft(emptyDraft());
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'Your message could not be sent. Try again.');
    } finally {
      setAdmitting(false);
    }
  };
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    setLocalError(undefined);
    try {
      await ref.stop();
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'Something went wrong. Please try again.');
    } finally {
      setStopping(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const connectionError = connection?.status === 'failed' ? connection.error : undefined;
  const messageError = localError || connectionError || controls?.error || snapshot?.report || snapshot?.view.error;
  const retry = connectionError && (!localError || localError === connectionError) ? () => {
    setLocalError(undefined);
    void ref.reconnect();
  } : undefined;
  const dismiss = localError ? () => setLocalError(undefined)
    : connectionError || controls?.error ? undefined
      : snapshot?.report ? () => { void ref.dismissError(); } : undefined;
  const working = stopping ? 'Stopping…' : controls?.compacting ? 'Summarizing earlier messages…'
    : controls?.retrying ? 'Retrying…' : `${name} is thinking…`;
  const subtitle = connection?.status === 'failed' ? `Can’t connect to ${machineName}`
    : connection?.status === 'connecting' ? connecting(machineName, connection.stage)
      : `${machineName}${busy ? ' · Working…' : ''}`;
  // The server holds the conversation open only while it is here; its cell says where it went otherwise.
  const away = held !== null && held !== undefined && !held.active
    ? held.heldBy ? `InfiniChat is on ${held.heldBy.name}. Move it here from there.`
      : `InfiniChat isn’t on ${machineName} yet. Move it here from your iPhone.` : undefined;
  return (
    <div className="conversation">
      <header className="toolbar conversation-header">
        <div className="title">{name}</div>
        <div className="subtitle">{subtitle}</div>
      </header>
      <div className="transcript" ref={transcript}>
        {snapshot?.view.status === 'ready' && messages.length === 0 && !away
          && <p className="placeholder">Say hello to {name}.</p>}
        {messages.map((message) => <Row key={message.id} message={message} />)}
        {busy && <p className="working">{working}</p>}
      </div>
      <form className="composer" onSubmit={submit}>
        {controls && !configured && <p className="notice">{MODELS_REQUIRED}</p>}
        {away && <p className="notice">{away}</p>}
        {messageError && <p className="notice notice-error">
          {messageError}
          {retry && <button type="button" onClick={retry}>Try Again</button>}
          {!retry && dismiss && <button type="button" onClick={dismiss}>Dismiss</button>}
        </p>}
        {connection?.notice && !messageError && <p className="notice">
          {connection.notice}
          <button type="button" onClick={() => { void ref.dismissNotice(); }}>Dismiss</button>
        </p>}
        <div className="composer-row">
          <textarea value={draft.text} placeholder={`Message ${name}`} rows={1} onKeyDown={onKeyDown}
            disabled={!controls || stopping || (!busy && !configured)}
            onChange={(event) => setDraft((current) => current.text === event.target.value ? current
              : { text: event.target.value, requestId: uuidv7() })} />
          {busy
            ? <button type="button" className="stop" disabled={stopping} onClick={() => { void stop(); }}>Stop</button>
            : <button type="submit" className="send" disabled={admitting || !configured || !draft.text.trim()}>
              Send
            </button>}
        </div>
      </form>
    </div>
  );
}
