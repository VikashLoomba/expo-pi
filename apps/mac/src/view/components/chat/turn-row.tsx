import type { Turn } from '@pi-agent/infinichat/chat/turns';
import { BotIcon, BrainIcon, UserIcon } from 'lucide-react';
import { memo } from 'react';

import {
  Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine,
  TraceTitle,
} from '../ui/trace';
import { TranscriptRow } from './message-row';
import { rowsOf } from './rows';

/** One line of a message, as the summary line shows the input that opened a turn. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * A turn of the thread as the Chain of Thought pattern folds an agent's steps: a summary line that expands into what
 * happened. The line is the input that opened the turn; under it, the lines the model holds for the turn right now,
 * its memory of it; inside, the turn in full: the message, the steps and the reply.
 */
export const TurnRow = memo(function TurnRow({ turn, open, onOpenChange, stopping, working }: {
  turn: Turn; open: boolean; onOpenChange: (open: boolean) => void; stopping: boolean;
  /** The working line, in the newest turn while the agent is busy without a row of its own. */
  working?: string;
}) {
  const opener = turn.opener;
  const title = opener === undefined ? 'Earlier'
    : oneLine(opener.text) || (opener.images?.length ? 'Photo' : 'Message');
  const steps = turn.rows.filter((row) => row.role === 'tool').length;
  const rows = rowsOf(turn.rows, working);
  return (
    <Trace>
      <TraceCollapsible open={open} onOpenChange={onOpenChange}>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>{opener?.role === 'work' ? <BotIcon /> : <UserIcon />}</TraceIcon>
            <TraceTitle>{title}</TraceTitle>
            {steps > 0 && <TraceDescription>{steps} {steps === 1 ? 'step' : 'steps'}</TraceDescription>}
          </TraceLine>
        </TraceCollapsibleTrigger>
        {turn.lines.map((line, index) => (
          <TraceLine key={index} className="text-muted-foreground">
            <TraceIcon><BrainIcon /></TraceIcon>
            <TraceTitle className="whitespace-normal">{line.text}</TraceTitle>
            {line.shared > 1 && <TraceDescription>covers {line.shared} turns</TraceDescription>}
          </TraceLine>
        ))}
        {/* The turn itself, not a step's detail: no indent, no rule, the thread's own text colour. */}
        <TraceCollapsibleContent className="mr-0 ml-0 border-l-0 pr-0 pl-0 text-foreground">
          <div className="flex flex-col gap-6 pt-3">
            {rows.map((row) => <TranscriptRow key={row.id} row={row} stopping={stopping} />)}
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
});
