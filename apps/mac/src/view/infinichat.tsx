import { uuidv7 } from '@earendil-works/pi-ai';
import type { Host } from '@earendil-works/chord';
import type { InstallStage } from '@pi-agent/infinichat/pi/infinichat-remote/dialer';
import { userInput } from '@pi-agent/infinichat/pi/user-input';
import { useEffect, useMemo, useRef, useState } from 'react';

import { MacInfiniChat, type Attachment, type MacPrincipal } from '../contract';
import { ChatAgentContext } from './agent';
import { Composer } from './composer';
import { Transcript } from './transcript';
import { errorText, useMember } from './use-ref';

const TITLE = 'InfiniChat';
const MODELS_REQUIRED = 'Choose InfiniChat’s main and summary models in its settings to send a message.';

const connecting = (machine: string, stage: InstallStage | undefined) => stage === 'uploading'
  ? `Installing InfiniChat on ${machine}…`
  : stage === 'starting' ? `Starting InfiniChat on ${machine}…` : `Connecting to ${machine}…`;

/** A draft keeps one request ID for every attempt to send it, so a resend after a failure is admitted once. */
type Draft = { text: string; images: readonly Attachment[]; requestId: string };
const emptyDraft = (): Draft => ({ text: '', images: [], requestId: uuidv7() });

/** A file's bytes as base64, for the main process to fit. */
function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('The photo could not be read.'));
    reader.readAsDataURL(file);
  });
}

/** InfiniChat's one conversation, as the phone's screen shows it (`(infinichat)/index.tsx`). */
export function InfiniChat({ host }: { host: Host<MacPrincipal> }) {
  const [ref] = useState(() => host.hold(MacInfiniChat, {}));
  useEffect(() => () => ref.release(), [ref]);
  const snapshot = useMember(ref.snapshot);
  const controls = useMember(ref.controls);
  const messages = useMember(ref.messages);
  const connection = useMember(ref.connection);
  const held = useMember(ref.held);
  const machine = useMember(ref.machine);
  const [draft, setDraft] = useState(emptyDraft);
  const [attaching, setAttaching] = useState(false);
  const [admitting, setAdmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  const name = controls?.name || TITLE;
  const agent = useMemo(() => ({ name, avatar: undefined }), [name]);
  const busy = !!controls?.busy;
  const configured = !!controls?.configured;
  const machineName = machine?.name ?? 'this Mac';

  const changeDraft = (text: string) =>
    setDraft((current) => current.text === text ? current : { ...current, text, requestId: uuidv7() });
  const addImages = (images: readonly Attachment[]) => {
    if (!images.length) return;
    setDraft((current) => ({ ...current, images: [...current.images, ...images], requestId: uuidv7() }));
  };
  const removeImage = (id: string) => setDraft((current) =>
    ({ ...current, images: current.images.filter((image) => image.id !== id), requestId: uuidv7() }));
  const choosePrompt = (text: string) => {
    changeDraft(text);
    input.current?.focus();
  };
  const attaching_ = async (work: () => Promise<readonly Attachment[]>) => {
    if (attaching) return;
    setAttaching(true);
    setLocalError(undefined);
    try {
      addImages(await work());
    } catch (cause) {
      setLocalError(errorText(cause, 'The photo could not be attached. Try again.'));
    } finally {
      setAttaching(false);
    }
  };
  const attach = () => attaching_(() => ref.pickPhotos());
  const attachFiles = (files: readonly File[]) => attaching_(async () => {
    const photos: Attachment[] = [];
    for (const file of files) {
      photos.push(await ref.attach({ name: file.name, mimeType: file.type, data: await base64Of(file) }));
    }
    return photos;
  });
  const send = async () => {
    const text = draft.text.trim();
    if ((!text && !draft.images.length) || admitting || !configured) return;
    setAdmitting(true);
    setLocalError(undefined);
    try {
      await ref.accept({ content: userInput(text, draft.images), requestId: draft.requestId });
      setDraft(emptyDraft());
    } catch (cause) {
      setLocalError(errorText(cause, 'Your message could not be sent. Try again.'));
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
      setLocalError(errorText(cause, 'Something went wrong. Please try again.'));
    } finally {
      setStopping(false);
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
  const subtitle = connection?.status === 'failed' ? `Can’t connect to ${machineName}`
    : connection?.status === 'connecting' ? connecting(machineName, connection.stage)
      : `${machineName}${busy ? ' · Working…' : ''}`;
  // The server holds the conversation open only while it is here; its cell says where it went otherwise.
  const away = held !== null && held !== undefined && !held.active
    ? held.heldBy ? `InfiniChat is on ${held.heldBy.name}. Move it here from there.`
      : `InfiniChat isn’t on ${machineName} yet. Move it here from your iPhone.` : undefined;
  return (
    <ChatAgentContext value={agent}>
      <div className="conversation">
        <header className="toolbar conversation-header">
          <div className="title">{name}</div>
          <div className="subtitle">{subtitle}</div>
        </header>
        {away ? <p className="placeholder">{away}</p>
          : <Transcript messages={messages ?? []} controls={controls ?? undefined} snapshot={snapshot?.view}
            stopping={stopping} onChoose={choosePrompt} />}
        {controls && !configured && <p className="notice">{MODELS_REQUIRED}</p>}
        {messageError && (
          <p className="notice notice-error">
            {messageError}
            {retry && <button type="button" onClick={retry}>Try Again</button>}
            {!retry && dismiss && <button type="button" onClick={dismiss}>Dismiss</button>}
          </p>
        )}
        {connection?.notice && !messageError && (
          <p className="notice">
            {connection.notice}
            <button type="button" onClick={() => { void ref.dismissNotice(); }}>Dismiss</button>
          </p>
        )}
        <Composer value={draft.text} onChange={changeDraft} onSend={() => { void send(); }}
          onStop={() => { void stop(); }} busy={busy} admitting={admitting}
          disabled={!controls || stopping || !!away || (!busy && !configured)} inputRef={input}
          attachments={draft.images} onAttach={() => { void attach(); }}
          onFiles={(files) => { void attachFiles(files); }}
          onRemoveAttachment={removeImage} attaching={attaching} imagesSupported={configured} />
      </div>
    </ChatAgentContext>
  );
}
