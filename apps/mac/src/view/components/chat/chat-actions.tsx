import { useState, type FormEvent } from 'react';

import type { ChatSummaryRecord } from '../../../contract';
import type { ChatsRef } from '../../hooks/use-chats';
import { errorText } from '../../hooks/use-ref';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '../ui/alert-dialog';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import type { ChatAction } from './chats-sidebar';

/** The phone's `Alert.prompt` as a sheet: the chat's name, saved on Enter or Save. */
function RenameDialog({ chats, chat, onClose }: { chats: ChatsRef; chat: ChatSummaryRecord; onClose: () => void }) {
  const [title, setTitle] = useState(chat.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (saving || !title.trim()) return;
    setSaving(true);
    setError(undefined);
    void chats.rename({ id: String(chat.id), title }).then(onClose, (cause: unknown) => {
      setError(errorText(cause, 'Could not rename this chat.'));
    }).finally(() => setSaving(false));
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Rename Chat</DialogTitle>
            <DialogDescription>The name shows in the sidebar; the conversation stays as it is.</DialogDescription>
          </DialogHeader>
          {error !== undefined && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          <Input value={title} aria-label="Name" autoFocus onChange={(event) => setTitle(event.target.value)} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving || !title.trim()}>{saving ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The phone's delete confirmation, as the Machines pane confirms a removal. */
function DeleteDialog({ chats, chat, onClose }: { chats: ChatsRef; chat: ChatSummaryRecord; onClose: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();
  const remove = () => {
    setDeleting(true);
    setError(undefined);
    void chats.delete({ id: String(chat.id) }).then(onClose, (cause: unknown) => {
      setError(errorText(cause, 'Could not delete this chat.'));
    }).finally(() => setDeleting(false));
  };
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{chat.title}”?</AlertDialogTitle>
          <AlertDialogDescription>Stops it and removes it and its folder on this Mac.</AlertDialogDescription>
        </AlertDialogHeader>
        {error !== undefined && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={deleting} onClick={remove}>
            {deleting ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Rename and Delete for the chat menus, one dialog at a time, keyed by the chat so each opens with its own name. */
export function ChatActionDialogs({ chats, action, onClose }: {
  chats: ChatsRef; action: ChatAction | undefined; onClose: () => void;
}) {
  if (action === undefined) return null;
  return action.kind === 'rename'
    ? <RenameDialog key={action.chat.id} chats={chats} chat={action.chat} onClose={onClose} />
    : <DeleteDialog key={action.chat.id} chats={chats} chat={action.chat} onClose={onClose} />;
}
