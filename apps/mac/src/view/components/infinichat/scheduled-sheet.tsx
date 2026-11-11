import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { useWatch } from '@earendil-works/chord/react';
import type { ScheduledTask } from '@pi-agent/infinichat/pi/infinichat-scheduled';
import {
  ONCE, REPEAT_CHOICES, repeatKey, repeatLabel, type ScheduledInput,
} from '@pi-agent/infinichat/pi/infinichat/schedule';
import { ClockIcon } from 'lucide-react';
import { useState } from 'react';

import { useInfiniChatRef } from '../../hooks/use-infinichat';
import { errorText } from '../../lib/error-text';
import { Notice } from '../chat/notices';
import { Button } from '../ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../ui/empty';
import { Field, FieldGroup, FieldLabel } from '../ui/field';
import { Input } from '../ui/input';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../ui/item';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Textarea } from '../ui/textarea';
import { FormSheet } from './form-sheet';

/**
 * The task as the list showed it, its unsaved text, time and repeat, and when editing began, the earliest time the
 * input offers: saving replaces the task with one of another ID.
 */
type Editing = { task: ScheduledTask; draft: ScheduledInput; since: number };

const pad = (value: number) => String(value).padStart(2, '0');
/** A time as the `datetime-local` input takes it: local, to the minute. */
function localInput(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:`
    + pad(date.getMinutes());
}
const runTime = (until: number) =>
  new Date(until).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
/** The task as a draft starts from it. */
const draftOf = ({ task, until, repeat }: ScheduledTask): ScheduledInput =>
  repeat === undefined ? { task, until } : { task, until, repeat };
/** The repeats offered for `task`, with its own when InfiniChat set another. */
const repeatsOf = ({ repeat }: ScheduledTask) =>
  repeat === undefined || REPEAT_CHOICES.some((each) => repeatKey(each) === repeatKey(repeat))
    ? REPEAT_CHOICES : [...REPEAT_CHOICES, repeat];

/**
 * The tasks InfiniChat scheduled for later, soonest first, as the phone's `infinichat-schedule` sheet: Edit opens a
 * task's text and time in place of the list, Delete removes it on the machine.
 */
export function ScheduledSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useInfiniChatRef();
  const tasks = useWatch(ref.scheduled);
  const [editing, setEditing] = useState<Editing>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** Deletes `task`, or replaces it with `replacement`; either fails once the task has reached InfiniChat. */
  const finish = (task: ScheduledTask, replacement?: ScheduledInput) => {
    if (busy) return;
    if (replacement && replacement.until <= Date.now()) {
      setError('Choose a time in the future.');
      return;
    }
    setBusy(true);
    setError(undefined);
    const change = replacement === undefined ? { id: task.id } : { id: task.id, replacement };
    void ref.cancelScheduled(change, BACKGROUND_CONTEXT).then((done) => {
      if (done) setEditing(undefined);
      else setError(replacement === undefined ? 'That task reached InfiniChat before it was deleted.'
        : 'This task already reached InfiniChat.');
    }, (cause: unknown) => {
      setError(errorText(cause, 'Could not change this task. Try again.'));
    }).finally(() => setBusy(false));
  };
  const dirty = editing !== undefined
    && (editing.draft.task.trim() !== editing.task.task || editing.draft.until !== editing.task.until
      || repeatKey(editing.draft.repeat) !== repeatKey(editing.task.repeat));
  const canSave = editing !== undefined && dirty && !!editing.draft.task.trim();
  return (
    <FormSheet open={open} onClose={editing ? () => setEditing(undefined) : onClose} dirty={dirty}
      className="sm:max-w-lg" title={editing ? 'Edit task' : 'Scheduled tasks'}
      description={editing ? 'InfiniChat receives this as a message at the time below.'
        : 'Each task reaches InfiniChat as a message at its time. A notification shows then while InfiniChat is '
          + 'open on this Mac.'}
      save={editing ? { label: 'Save', disabled: !canSave, busy, onSave: () => {
        finish(editing.task, { ...editing.draft, task: editing.draft.task.trim() });
      } } : undefined}
      leading={editing ? (
        <Button type="button" variant="outline" className="text-destructive" disabled={busy}
          onClick={() => finish(editing.task)}>
          Delete Task
        </Button>
      ) : undefined}>
      {error !== undefined && <Notice message={error} />}
      {editing ? (
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="scheduled-task">Task</FieldLabel>
            <Textarea id="scheduled-task" rows={4} value={editing.draft.task} placeholder="What InfiniChat should do"
              disabled={busy}
              onChange={(event) => setEditing({ ...editing, draft: { ...editing.draft, task: event.target.value } })} />
          </Field>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="scheduled-time">Runs at</FieldLabel>
            <Input id="scheduled-time" type="datetime-local" className="w-auto" value={localInput(editing.draft.until)}
              min={localInput(editing.since)} disabled={busy} onChange={(event) => {
                const until = new Date(event.target.value).getTime();
                if (!Number.isNaN(until)) setEditing({ ...editing, draft: { ...editing.draft, until } });
              }} />
          </Field>
          <Field orientation="horizontal">
            <FieldLabel>Repeat</FieldLabel>
            <Select value={repeatKey(editing.draft.repeat)} disabled={busy}
              items={[{ value: ONCE, label: 'Never' },
                ...repeatsOf(editing.task).map((each) => ({ value: repeatKey(each), label: repeatLabel(each) }))]}
              onValueChange={(chosen) => {
                const { repeat: _before, ...draft } = editing.draft;
                const repeat = repeatsOf(editing.task).find((each) => repeatKey(each) === chosen);
                setEditing({ ...editing, draft: repeat === undefined ? draft : { ...draft, repeat } });
              }}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ONCE}>Never</SelectItem>
                {repeatsOf(editing.task).map((each) => (
                  <SelectItem key={repeatKey(each)} value={repeatKey(each)}>{repeatLabel(each)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
      ) : tasks === undefined || tasks === null ? (
        <p className="text-muted-foreground">
          {tasks === undefined ? 'Loading the scheduled tasks…' : 'The scheduled tasks can’t be read right now.'}
        </p>
      ) : tasks.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><ClockIcon /></EmptyMedia>
            <EmptyTitle>No scheduled tasks</EmptyTitle>
            <EmptyDescription>Tasks InfiniChat schedules for later appear here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="-mx-4 max-h-[60vh] overflow-y-auto px-4">
          {tasks.map((task) => (
            <Item key={task.id} variant="outline" size="sm">
              <ItemContent>
                <ItemTitle>
                  {task.repeat ? `${runTime(task.until)} · ${repeatLabel(task.repeat)}` : runTime(task.until)}
                </ItemTitle>
                <ItemDescription className="line-clamp-2">{task.task}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button type="button" variant="outline" size="sm" disabled={busy}
                  onClick={() => setEditing({ task, draft: draftOf(task), since: Date.now() })}>
                  Edit…
                </Button>
                <Button type="button" variant="outline" size="sm" className="text-destructive" disabled={busy}
                  onClick={() => finish(task)}>
                  Delete
                </Button>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
    </FormSheet>
  );
}
