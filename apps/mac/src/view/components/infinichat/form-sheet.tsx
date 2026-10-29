import { useCallback, useState, type ReactNode } from 'react';

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';

/** What a sheet saves: its trailing button, enabled while the draft can be saved. */
export interface SheetSave {
  label: string;
  disabled: boolean;
  busy: boolean;
  onSave: () => void;
}

/**
 * A sheet as the phone's form sheets behave (owner, 2026-10-27): Cancel leads and the saving action trails, and
 * closing with unsaved changes, by Escape, a click outside or Cancel, asks before discarding them. Without `save` it
 * is a plain sheet with Done. Enter in a field saves.
 */
export function FormSheet({ open, onClose, dirty = false, title, description, save, leading, className, children }: {
  open: boolean; onClose: () => void; dirty?: boolean; title: string; description?: string; save?: SheetSave;
  leading?: ReactNode; className?: string; children: ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  const requestClose = () => {
    if (dirty) setAsking(true);
    else onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(next, details) => {
      if (next) return;
      if (dirty) details.cancel();
      requestClose();
    }}>
      <DialogContent showCloseButton={false} className={className}>
        <form className="contents" onSubmit={(event) => {
          event.preventDefault();
          if (save && !save.disabled && !save.busy) save.onSave();
        }}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description !== undefined && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
          <DialogFooter>
            {leading !== undefined && <div className="mr-auto">{leading}</div>}
            {save ? (
              <>
                <Button type="button" variant="outline" onClick={requestClose}>Cancel</Button>
                <Button type="submit" disabled={save.disabled || save.busy}>
                  {save.busy ? 'Saving…' : save.label}
                </Button>
              </>
            ) : <Button type="button" onClick={onClose}>Done</Button>}
          </DialogFooter>
        </form>
      </DialogContent>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>Your changes have not been saved.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Editing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => {
              setAsking(false);
              onClose();
            }}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

/**
 * A sheet's state for the screen that opens it: `session` changes at each opening, so a sheet keyed by it mounts
 * fresh with the values of that moment and keeps them until it is saved or discarded.
 */
export function useSheet() {
  const [state, setState] = useState({ open: false, session: 0 });
  const show = useCallback(() => setState((current) => ({ open: true, session: current.session + 1 })), []);
  const hide = useCallback(() => setState((current) => ({ ...current, open: false })), []);
  return { open: state.open, session: state.session, show, hide };
}
