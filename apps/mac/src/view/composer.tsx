import {
  useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type RefObject,
} from 'react';

import type { Attachment } from '../contract';
import { useChatAgentName } from './agent';
import { Icon } from './icon';

/**
 * The message field and its controls, as the phone's `composer.tsx`: photos come from the open dialog behind the
 * attach button, or dropped or pasted onto the field; each is fitted by the main process before it shows.
 */
export function Composer({ value, onChange, onSend, onStop, busy, admitting, disabled, inputRef, attachments,
  onAttach, onFiles, onRemoveAttachment, attaching, imagesSupported }: {
  value: string; onChange: (text: string) => void; onSend: () => void; onStop: () => void;
  busy: boolean; admitting: boolean; disabled: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  attachments: readonly Attachment[];
  /** Opens the photo dialog. */
  onAttach: () => void;
  /** Photos dropped or pasted. */
  onFiles: (files: readonly File[]) => void;
  onRemoveAttachment: (id: string) => void;
  attaching: boolean;
  imagesSupported: boolean;
}) {
  const agentName = useChatAgentName();
  const [dropping, setDropping] = useState(false);
  const canSend = !disabled && !admitting && !attaching && (!!value.trim() || attachments.length > 0);
  const canAttach = imagesSupported && !disabled && !admitting && !attaching;
  const photos = (list: FileList | null) => [...(list ?? [])].filter((file) => file.type.startsWith('image/'));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSend) onSend();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSend) onSend();
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = photos(event.clipboardData.files);
    if (files.length && canAttach) {
      event.preventDefault();
      onFiles(files);
    }
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDropping(false);
    const files = photos(event.dataTransfer.files);
    if (files.length && canAttach) onFiles(files);
  };
  return (
    <form className={`composer${dropping ? ' dropping' : ''}`} onSubmit={submit}
      onDragOver={(event) => { event.preventDefault(); setDropping(canAttach); }}
      onDragLeave={() => setDropping(false)} onDrop={onDrop}>
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((attachment, index) => (
            <div key={attachment.id} className="attachment">
              <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={`Attached photo ${index + 1}`} />
              <button type="button" aria-label={`Remove photo ${index + 1}`} disabled={admitting}
                onClick={() => onRemoveAttachment(attachment.id)}>
                <Icon name="close" size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-row">
        <button type="button" className="round-button secondary" aria-label="Attach a photo" disabled={!canAttach}
          onClick={onAttach}>
          {attaching ? <span className="spinner" /> : <Icon name="plus" size={18} />}
        </button>
        <textarea ref={inputRef} value={value} rows={1} disabled={admitting}
          placeholder={busy ? 'Write a follow-up…' : `Message ${agentName}…`} maxLength={30000}
          onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} onPaste={onPaste} />
        {busy
          ? <button type="button" className="round-button stop" aria-label="Stop response" disabled={disabled}
            onClick={onStop}><Icon name="stop" size={16} /></button>
          : <button type="submit" className="round-button" aria-label="Send message" disabled={!canSend}>
            {admitting ? <span className="spinner" /> : <Icon name="send" size={18} />}
          </button>}
      </div>
    </form>
  );
}
