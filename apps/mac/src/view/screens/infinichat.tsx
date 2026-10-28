import { uuidv7 } from '@earendil-works/pi-ai';
import type { Host } from '@earendil-works/chord';
import type { InstallStage } from '@pi-agent/infinichat/pi/infinichat-remote/dialer';
import { userInput } from '@pi-agent/infinichat/pi/user-input';
import { useCallback, useMemo, useRef, useState } from 'react';

import type { Attachment, MacPrincipal } from '../../contract';
import { ChatAgentContext } from '../components/chat/agent';
import { Composer } from '../components/chat/composer';
import { Notice } from '../components/chat/notices';
import { Transcript } from '../components/chat/transcript';
import { InfiniChatContext, useHeldInfiniChat, useInfiniChatRef } from '../hooks/use-infinichat';
import { errorText, useMember } from '../hooks/use-ref';

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

/** InfiniChat's one conversation: holds the window's reference and shows it. */
export function InfiniChatScreen({ host }: { host: Host<MacPrincipal> }) {
  const ref = useHeldInfiniChat(host);
  return (
    <InfiniChatContext value={ref}>
      <InfiniChat />
    </InfiniChatContext>
  );
}

/**
 * The screen as the phone's `(infinichat)/index.tsx`: the header, the transcript, what stands in the way, and the
 * composer whose draft it owns. The transcript subscribes to the messages itself and is memoized, so a keystroke
 * renders only this component and the composer.
 */
function InfiniChat() {
  const ref = useInfiniChatRef();
  const snapshot = useMember(ref.snapshot);
  const controls = useMember(ref.controls);
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

  const changeDraft = useCallback((text: string) => {
    setDraft((current) => current.text === text ? current : { ...current, text, requestId: uuidv7() });
  }, []);
  const removeImage = useCallback((id: string) => {
    setDraft((current) => ({ ...current, images: current.images.filter((image) => image.id !== id),
      requestId: uuidv7() }));
  }, []);
  const choosePrompt = useCallback((text: string) => {
    changeDraft(text);
    input.current?.focus();
  }, [changeDraft]);
  const attachWith = useCallback(async (work: () => Promise<readonly Attachment[]>) => {
    setAttaching(true);
    setLocalError(undefined);
    try {
      const images = await work();
      if (images.length) {
        setDraft((current) => ({ ...current, images: [...current.images, ...images], requestId: uuidv7() }));
      }
    } catch (cause) {
      setLocalError(errorText(cause, 'The photo could not be attached. Try again.'));
    } finally {
      setAttaching(false);
    }
  }, []);
  const attach = useCallback(() => { void attachWith(() => ref.pickPhotos()); }, [attachWith, ref]);
  const attachFiles = useCallback((files: readonly File[]) => {
    void attachWith(async () => {
      const photos: Attachment[] = [];
      for (const file of files) {
        photos.push(await ref.attach({ name: file.name, mimeType: file.type, data: await base64Of(file) }));
      }
      return photos;
    });
  }, [attachWith, ref]);
  const send = useCallback(() => {
    const text = draft.text.trim();
    if ((!text && !draft.images.length) || admitting || !configured) return;
    setAdmitting(true);
    setLocalError(undefined);
    void ref.accept({ content: userInput(text, draft.images), requestId: draft.requestId }).then(() => {
      setDraft(emptyDraft());
    }, (cause: unknown) => {
      setLocalError(errorText(cause, 'Your message could not be sent. Try again.'));
    }).finally(() => setAdmitting(false));
  }, [admitting, configured, draft, ref]);
  const stop = useCallback(() => {
    if (stopping) return;
    setStopping(true);
    setLocalError(undefined);
    void ref.stop().catch((cause: unknown) => {
      setLocalError(errorText(cause, 'Something went wrong. Please try again.'));
    }).finally(() => setStopping(false));
  }, [ref, stopping]);

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
        {away ? <p className="placeholder">{away}</p> : <Transcript stopping={stopping} onChoose={choosePrompt} />}
        {controls && !configured && <Notice tone="neutral" message={MODELS_REQUIRED} />}
        {messageError && (
          <Notice message={messageError} action={retry ? 'Try Again' : dismiss ? 'Dismiss' : undefined}
            onAction={retry ?? dismiss} />
        )}
        {connection?.notice && !messageError && (
          <Notice tone="neutral" message={connection.notice} action="Dismiss"
            onAction={() => { void ref.dismissNotice(); }} />
        )}
        <Composer value={draft.text} onChange={changeDraft} onSend={send} onStop={stop} busy={busy}
          admitting={admitting} disabled={!controls || stopping || !!away || (!busy && !configured)} inputRef={input}
          attachments={draft.images} onAttach={attach} onFiles={attachFiles} onRemoveAttachment={removeImage}
          attaching={attaching} imagesSupported={configured} />
      </div>
    </ChatAgentContext>
  );
}
