import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { useWatch } from '@earendil-works/chord/react';
import { ROOT } from '@pi-agent/infinichat/pi/infinichat/agents';
import type {
  PendingQuestionBatch, QuestionItem, UserQuestionAnswer,
} from '@pi-agent/infinichat/pi/infinichat/ask';
import { EyeIcon, EyeOffIcon, ShieldIcon, UserIcon } from 'lucide-react';
import { useState } from 'react';

import { useInfiniChatRef } from '../../hooks/use-infinichat';
import { errorText } from '../../lib/error-text';
import { Notice } from '../chat/notices';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../ui/empty';
import { Field, FieldDescription, FieldLabel } from '../ui/field';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Switch } from '../ui/switch';
import { Textarea } from '../ui/textarea';
import { FormSheet } from './form-sheet';

interface DraftAnswer {
  value: string;
  note: string;
  skipped: boolean;
}

function batchLabel(batch: PendingQuestionBatch): string {
  const count = batch.questions.length;
  const text = batch.title || `${count} question${count === 1 ? '' : 's'}`;
  return batch.agent === ROOT ? text : `${batch.agent} · ${text}`;
}

function QuestionCard({ question, draft, disabled, onChange }: {
  question: QuestionItem;
  draft: DraftAnswer;
  disabled: boolean;
  onChange: (next: DraftAnswer) => void;
}) {
  const [reveal, setReveal] = useState(false);
  const isSecret = question.kind === 'secret';
  const heading = question.label || (isSecret ? 'Credential' : 'Question');
  return (
    <div className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{heading}</span>
            {isSecret && (
              <Badge variant="secondary" className="gap-1">
                <ShieldIcon className="size-3" />
                Secret
              </Badge>
            )}
          </div>
          <p className="m-0 text-sm text-foreground">{question.prompt}</p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          Skip
          <Switch size="sm" checked={draft.skipped} disabled={disabled}
            onCheckedChange={(skipped) => onChange({ ...draft, skipped, value: skipped ? '' : draft.value })} />
        </label>
      </div>
      {isSecret && question.purpose !== undefined && (
        <div className="flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          <ShieldIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <span><strong className="font-medium text-foreground">How it will be used:</strong> {question.purpose}</span>
        </div>
      )}
      {!draft.skipped && (isSecret ? (
        <Field>
          <div className="flex items-center gap-1.5">
            <Input type={reveal ? 'text' : 'password'} autoComplete="off" spellCheck={false}
              value={draft.value} placeholder={question.placeholder || 'Enter secret value'} disabled={disabled}
              onChange={(event) => onChange({ ...draft, value: event.target.value })} />
            <Button type="button" variant="outline" size="icon-sm" disabled={disabled}
              aria-label={reveal ? 'Hide value' : 'Show value'}
              onClick={() => setReveal((current) => !current)}>
              {reveal ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
            </Button>
          </div>
          <FieldDescription>
            Held in memory only on the host (never saved to disk or sent to the model).
          </FieldDescription>
        </Field>
      ) : (
        <Field>
          <Textarea rows={2} value={draft.value} placeholder={question.placeholder || 'Your answer'}
            disabled={disabled} onChange={(event) => onChange({ ...draft, value: event.target.value })} />
        </Field>
      ))}
      <Field>
        <FieldLabel className="text-xs text-muted-foreground">Additional note (optional)</FieldLabel>
        <Input type="text" value={draft.note} placeholder="Add context alongside your answer or skip"
          disabled={disabled} onChange={(event) => onChange({ ...draft, note: event.target.value })} />
      </Field>
    </div>
  );
}

function BatchBody({ batch, batches, onSelectBatch, onSubmitted, open, onClose }: {
  batch: PendingQuestionBatch;
  batches: readonly PendingQuestionBatch[];
  onSelectBatch: (taskId: number) => void;
  onSubmitted: () => void;
  open: boolean;
  onClose: () => void;
}) {
  const ref = useInfiniChatRef();
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>(() =>
    Object.fromEntries(batch.questions.map((question) => [question.id, { value: '', note: '', skipped: false }])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dirty = Object.values(drafts).some((entry) => entry.value.length > 0 || entry.note.length > 0 || entry.skipped);
  const ready = batch.questions.every((question) => {
    const entry = drafts[question.id];
    if (!entry) return false;
    if (entry.skipped) return true;
    return question.kind === 'secret' ? entry.value.length > 0 : entry.value.trim().length > 0;
  });
  const send = (answers: UserQuestionAnswer[]) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void ref.answerQuestions({ taskId: batch.taskId, answers }, BACKGROUND_CONTEXT).then(() => {
      onSubmitted();
    }, (cause: unknown) => {
      setError(errorText(cause, 'Could not send your answers. Try again.'));
    }).finally(() => setBusy(false));
  };
  const submit = () => {
    send(batch.questions.map((question) => {
      const entry = drafts[question.id] ?? { value: '', note: '', skipped: true };
      const note = entry.note.trim();
      return {
        id: question.id,
        skipped: entry.skipped,
        ...(entry.skipped ? {} : { value: entry.value }),
        ...(note ? { note } : {}),
      };
    }));
  };
  const skipAll = () => {
    send(batch.questions.map((question) => {
      const note = drafts[question.id]?.note.trim();
      return { id: question.id, skipped: true, ...(note ? { note } : {}) };
    }));
  };
  return (
    <FormSheet open={open} onClose={onClose} dirty={dirty} className="sm:max-w-xl"
      title={batch.title || 'Questions'}
      description={batch.agent === ROOT ? undefined : `Asked by ${batch.agent}`}
      save={{ label: 'Submit', disabled: !ready, busy, onSave: submit }}
      leading={(
        <Button type="button" variant="outline" disabled={busy} onClick={skipAll}>Skip All</Button>
      )}>
      <div className="-mx-4 flex max-h-[65vh] flex-col gap-4 overflow-y-auto px-4 py-1">
        {error !== undefined && <Notice message={error} />}
        {batches.length > 1 && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground">
              {batches.length} waiting requests
            </span>
            <Select value={String(batch.taskId)} onValueChange={(value) => { if (value) onSelectBatch(Number(value)); }}>
              <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
              <SelectContent>
                {batches.map((item) => (
                  <SelectItem key={item.taskId} value={String(item.taskId)}>{batchLabel(item)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {batch.agent !== ROOT && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <UserIcon className="size-3.5" />
            <span>Agent: <strong className="font-medium text-foreground">{batch.agent}</strong></span>
          </div>
        )}
        {batch.questions.map((question) => (
          <QuestionCard key={question.id} question={question}
            draft={drafts[question.id] ?? { value: '', note: '', skipped: false }} disabled={busy}
            onChange={(next) => setDrafts((current) => ({ ...current, [question.id]: next }))} />
        ))}
      </div>
    </FormSheet>
  );
}

/** Sheet for answering parked `ask_user` batches from root or any child agent. */
export function QuestionsSheet({ open, onClose, focusAgent }: {
  open: boolean;
  onClose: () => void;
  focusAgent?: string;
}) {
  const ref = useInfiniChatRef();
  const batches = useWatch(ref.pendingQuestions) ?? [];
  const [selectedTaskId, setSelectedTaskId] = useState<number>();
  const active = (selectedTaskId !== undefined ? batches.find((batch) => batch.taskId === selectedTaskId) : undefined)
    ?? (focusAgent !== undefined ? batches.find((batch) => batch.agent === focusAgent) : undefined)
    ?? batches[0];
  if (active === undefined) {
    return (
      <FormSheet open={open} onClose={onClose} title="Questions" className="sm:max-w-lg">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><ShieldIcon /></EmptyMedia>
            <EmptyTitle>No pending questions</EmptyTitle>
            <EmptyDescription>
              When an agent needs input or a credential, its questions appear here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </FormSheet>
    );
  }
  return (
    <BatchBody key={active.taskId} batch={active} batches={batches} open={open} onClose={onClose}
      onSelectBatch={setSelectedTaskId}
      onSubmitted={() => {
        if (batches.length <= 1) onClose();
        else setSelectedTaskId(undefined);
      }} />
  );
}
