import { commandSuggestions, draftCommand, type ChatCommand } from '@pi-agent/infinichat/chat/commands';
import { ArrowUpIcon, PlusIcon, SquareIcon, XIcon } from 'lucide-react';
import {
  useId, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type RefObject,
} from 'react';

import type { Attachment as Photo } from '../../../contract';
import {
  Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentMedia, AttachmentTitle,
} from '../ui/attachment';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '../ui/input-group';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../ui/item';
import { Spinner } from '../ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { useChatAgentName } from './agent';

/**
 * The message field as the Prompt Input pattern builds it: an Input Group with the attached photos as Attachment
 * chips above the text and the attach, stop and send buttons below it. Photos come from the open dialog behind the
 * attach button, or dropped or pasted onto the field; each is fitted by the main process before it shows.
 *
 * `commands` complete as agent apps' slash commands do: typing `/` lists them above the text as Items, narrowing as
 * the name is typed; ↑ and ↓ move, Tab or Enter completes, Esc hides the list until the text changes, and a click
 * completes too. A draft that names one whole sends to `onCommand` instead. The keys are taken only while the list
 * shows: Base UI's Autocomplete would make the field a combobox whose arrow, Home, End and Esc keys it handles even
 * while closed, which a multi-line message field must keep.
 */
export function Composer({ value, onChange, onSend, onStop, busy, admitting, disabled, inputRef, attachments,
  onAttach, onFiles, onRemoveAttachment, attaching, imagesSupported, commands, onCommand }: {
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
  /** The commands the field completes and runs; none in an ordinary chat. */
  commands?: readonly ChatCommand[];
  onCommand?: (command: ChatCommand) => void;
}) {
  const agentName = useChatAgentName();
  const form = useRef<HTMLFormElement>(null);
  const listId = useId();
  const [dropping, setDropping] = useState(false);
  const [highlight, setHighlight] = useState(0);
  /** The text the list was dismissed at, which keeps it hidden until the text changes. */
  const [dismissed, setDismissed] = useState<string>();
  const named = commands === undefined ? undefined : draftCommand(value, commands);
  // A draft that already names a command whole has nothing left to complete.
  const suggestions = commands === undefined || named !== undefined || value === dismissed ? []
    : commandSuggestions(value, commands);
  const active = Math.min(highlight, suggestions.length - 1);
  const highlighted = suggestions.at(active);
  const canRun = named !== undefined && onCommand !== undefined && !admitting;
  const canSend = canRun || (!disabled && !admitting && !attaching && (!!value.trim() || attachments.length > 0));
  const canAttach = imagesSupported && !disabled && !admitting && !attaching;
  const photos = (list: FileList | null) => [...(list ?? [])].filter((file) => file.type.startsWith('image/'));
  const edit = (text: string) => {
    setHighlight(0);
    onChange(text);
  };
  const complete = (command: ChatCommand) => edit(`/${command.name}`);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (named !== undefined && onCommand !== undefined) {
      if (canRun) onCommand(named);
    } else if (canSend) {
      onSend();
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (highlighted !== undefined) {
      const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (step !== 0) {
        event.preventDefault();
        setHighlight((active + step + suggestions.length) % suggestions.length);
        return;
      }
      if ((event.key === 'Tab' || event.key === 'Enter') && !event.shiftKey) {
        event.preventDefault();
        complete(highlighted);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(value);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
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
        {highlighted !== undefined && (
          <InputGroupAddon align="block-start" className="p-1">
            <ItemGroup id={listId} role="listbox" aria-label="Commands" className="gap-0">
              {suggestions.map((command, index) => (
                <Item key={command.name} id={`${listId}-${command.name}`} size="xs" role="option"
                  aria-selected={index === active} data-highlighted={index === active || undefined}
                  className="cursor-default text-left data-[highlighted]:bg-muted"
                  render={<button type="button" />}
                  // The field keeps the focus, so typing goes on after a click completes the command.
                  onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setHighlight(index)}
                  onClick={() => complete(command)}>
                  <ItemContent>
                    <ItemTitle className="font-mono">/{command.name}</ItemTitle>
                    <ItemDescription>{command.description}</ItemDescription>
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          </InputGroupAddon>
        )}
        <InputGroupTextarea ref={inputRef} value={value} disabled={admitting} aria-label="Message"
          aria-autocomplete={commands === undefined ? undefined : 'list'}
          aria-controls={highlighted === undefined ? undefined : listId}
          aria-activedescendant={highlighted === undefined ? undefined : `${listId}-${highlighted.name}`}
          placeholder={busy ? 'Write a follow-up…' : `Message ${agentName}…`} maxLength={30000} className="p-3"
          onChange={(event) => edit(event.target.value)} onKeyDown={onKeyDown} onPaste={onPaste} />
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
