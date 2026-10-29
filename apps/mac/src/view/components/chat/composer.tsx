import { ArrowUpIcon, PlusIcon, SquareIcon, XIcon } from 'lucide-react';
import {
  useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type RefObject,
} from 'react';

import type { Attachment as Photo } from '../../../contract';
import {
  Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentMedia, AttachmentTitle,
} from '../ui/attachment';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '../ui/input-group';
import { Spinner } from '../ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { useChatAgentName } from './agent';

/**
 * The message field as the Prompt Input pattern builds it: an Input Group with the attached photos as Attachment
 * chips above the text and the attach, stop and send buttons below it. Photos come from the open dialog behind the
 * attach button, or dropped or pasted onto the field; each is fitted by the main process before it shows.
 */
export function Composer({ value, onChange, onSend, onStop, busy, admitting, disabled, inputRef, attachments,
  onAttach, onFiles, onRemoveAttachment, attaching, imagesSupported }: {
  value: string; onChange: (text: string) => void; onSend: () => void; onStop: () => void;
  busy: boolean; admitting: boolean; disabled: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  attachments: readonly Photo[];
  /** Opens the photo dialog. */
  onAttach: () => void;
  /** Photos dropped or pasted. */
  onFiles: (files: readonly File[]) => void;
  onRemoveAttachment: (id: string) => void;
  attaching: boolean;
  imagesSupported: boolean;
}) {
  const agentName = useChatAgentName();
  const form = useRef<HTMLFormElement>(null);
  const [dropping, setDropping] = useState(false);
  const canSend = !disabled && !admitting && !attaching && (!!value.trim() || attachments.length > 0);
  const canAttach = imagesSupported && !disabled && !admitting && !attaching;
  const photos = (list: FileList | null) => [...(list ?? [])].filter((file) => file.type.startsWith('image/'));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSend) onSend();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      form.current?.requestSubmit();
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
    <form ref={form} onSubmit={submit}
      onDragOver={(event) => { event.preventDefault(); setDropping(canAttach); }}
      onDragLeave={() => setDropping(false)} onDrop={onDrop}>
      <InputGroup data-dropping={dropping || undefined}
        className="h-auto min-h-14 flex-col items-stretch select-text data-[dropping]:bg-primary/10">
        {attachments.length > 0 && (
          <InputGroupAddon align="block-start" className="flex-wrap">
            {attachments.map((photo, index) => (
              <Attachment key={photo.id} size="sm">
                <AttachmentMedia variant="image">
                  <img src={`data:${photo.mimeType};base64,${photo.data}`} alt="" />
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>Photo {index + 1}</AttachmentTitle>
                </AttachmentContent>
                <AttachmentActions>
                  <AttachmentAction aria-label={`Remove photo ${index + 1}`} disabled={admitting}
                    onClick={() => onRemoveAttachment(photo.id)}>
                    <XIcon />
                  </AttachmentAction>
                </AttachmentActions>
              </Attachment>
            ))}
          </InputGroupAddon>
        )}
        <InputGroupTextarea ref={inputRef} value={value} disabled={admitting} aria-label="Message"
          placeholder={busy ? 'Write a follow-up…' : `Message ${agentName}…`} maxLength={30000} className="p-3"
          onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} onPaste={onPaste} />
        <InputGroupAddon align="block-end">
          <Tooltip>
            <TooltipTrigger render={<InputGroupButton type="button" size="icon-sm" variant="outline"
              className="rounded-full" aria-label="Attach a photo" disabled={!canAttach} onClick={onAttach} />}>
              {attaching ? <Spinner /> : <PlusIcon />}
            </TooltipTrigger>
            <TooltipContent>Attach a photo</TooltipContent>
          </Tooltip>
          {busy
            ? <Tooltip>
              <TooltipTrigger render={<InputGroupButton type="button" size="icon-sm" variant="destructive"
                className="ml-auto rounded-full" aria-label="Stop response" disabled={disabled} onClick={onStop} />}>
                <SquareIcon />
              </TooltipTrigger>
              <TooltipContent>Stop response</TooltipContent>
            </Tooltip>
            : <Tooltip>
              <TooltipTrigger render={<InputGroupButton type="submit" size="icon-sm" variant="default"
                className="ml-auto rounded-full" aria-label="Send message" disabled={!canSend} />}>
                {admitting ? <Spinner /> : <ArrowUpIcon />}
              </TooltipTrigger>
              <TooltipContent>Send message</TooltipContent>
            </Tooltip>}
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}
