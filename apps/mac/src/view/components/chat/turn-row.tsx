import { blocksOf, type Turn } from '@pi-agent/infinichat/chat/turns';
import type { ChatMessage } from '@pi-agent/infinichat/chat/types';
import { memo } from 'react';

import { Message, MessageContent } from '../ui/message';
import {
  Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle,
} from '../ui/trace';
import { MessageRow, StepRows, WorkingRow } from './message-row';
import { StatusIcon } from './status-icon';

const running = (row: ChatMessage): boolean => row.tool?.status === 'running'
  || (!!row.streaming && !row.text) || (row.webSearch?.calls.some((call) => call.status === 'running') ?? false);

/**
 * The steps between a person's message and the agent's reply, as the Chain of Thought pattern folds them: a
 * summary line that opens into the steps. The run opens and closes with its turn; `keepMounted` keeps each step's
 * own open state while the summary is closed, as the pattern says.
 */
function StepsRun({ rows, open, onOpenChange, stopping }: {
  rows: readonly ChatMessage[]; open: boolean; onOpenChange: (open: boolean) => void; stopping: boolean;
}) {
  const status = rows.some(running) ? 'running'
    : rows.some((row) => row.tool?.status === 'error') ? 'error' : undefined;
  const count = rows.length;
  return (
    <Message>
      <MessageContent>
        <Trace>
          <TraceCollapsible open={open} onOpenChange={onOpenChange}>
            <TraceCollapsibleTrigger>
              <TraceLine status={status}>
                <TraceIcon><StatusIcon status={status} /></TraceIcon>
                <TraceTitle>
                  {status === 'running' ? 'Working' : 'Worked'} in {count} {count === 1 ? 'step' : 'steps'}
                </TraceTitle>
              </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent keepMounted>
              <Trace>
                {rows.map((row) => <StepRows key={row.id} message={row} stopping={stopping} />)}
              </Trace>
            </TraceCollapsibleContent>
          </TraceCollapsible>
        </Trace>
      </MessageContent>
    </Message>
  );
}

/**
 * A turn of the thread, folded (owner, 2026-10-29): the person's messages and the agent's replies as they are, the
 * steps between them a run each that opens on a click; the newest turn open, so its work shows as it happens.
 */
export const TurnRow = memo(function TurnRow({ turn, open, onOpenChange, stopping, working }: {
  turn: Turn; open: boolean; onOpenChange: (open: boolean) => void; stopping: boolean;
  /** The working line, in the newest turn while the agent is busy without a row of its own. */
  working?: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      {blocksOf(turn.rows).map((block) => block.kind === 'message'
        ? <MessageRow key={block.row.id} message={block.row} stopping={stopping} />
        : <StepsRun key={block.id} rows={block.rows} open={open} onOpenChange={onOpenChange} stopping={stopping} />)}
      {working !== undefined && <WorkingRow text={working} />}
    </div>
  );
});
