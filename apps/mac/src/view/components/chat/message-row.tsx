import type { ChatMessage } from '@pi-agent/infinichat/chat/types';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';

import { Bubble, BubbleContent } from '../ui/bubble';
import { Button } from '../ui/button';
import { Marker, MarkerContent } from '../ui/marker';
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from '../ui/message';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Trace, TraceIcon, TraceLine, TraceTitle } from '../ui/trace';
import { AgentMark, useChatAgentName } from './agent';
import { MessageContent as Markdown } from './message-content';
import { MessageImages } from './message-images';
import { ErrorRow, ReasoningRow, ReportRow, SearchRows, SourcesRow, ToolRow } from './trace-rows';
import { StatusIcon } from './status-icon';

/** UniiChat's work message: "[Name]" and the report, without the zoom pointer for the model. */
const REPORT = /^\[([^\]\r\n]+)\]\s*([\s\S]*?)(?:\s*Full chat: zoom\("[^"\r\n]*"\))?\s*$/;

/** The copy action under a reply, as the Message pattern has it: a ghost icon button that shows a check for 2 s. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timeout.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // The row's text can be selected and copied by hand.
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label="Copy" onClick={() => { void copy(); }} />}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </TooltipTrigger>
      <TooltipContent>{copied ? 'Copied' : 'Copy'}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A message the folded thread shows: the person's text in a bubble on the end side, or the agent's reply with its
 * sources and actions in the footer. The steps around a reply are a run of their own (`StepRows`); `memo`: a
 * streamed delta replaces only the rows it touches, so the others keep their rendered Markdown.
 */
export const MessageRow = memo(function MessageRow({ message, stopping = false }: {
  message: ChatMessage; stopping?: boolean;
}) {
  const agentName = useChatAgentName();
  if (message.role === 'user') {
    const queued = message.queued === undefined ? undefined
      : message.queued.mode === 'steer' ? 'Queued as a steer' : message.queued.mode === 'followUp'
        ? 'Queued as a follow-up' : 'Queued';
    return (
      <Message align="end">
        <MessageContent>
          <Bubble align="end" variant="muted">
            <BubbleContent className="whitespace-pre-wrap">
              {message.images?.length ? <MessageImages images={message.images} size={140} /> : null}
              {message.text}
            </BubbleContent>
          </Bubble>
          {queued !== undefined && <MessageFooter>{queued}</MessageFooter>}
        </MessageContent>
      </Message>
    );
  }
  const streaming = !!message.streaming;
  const state = streaming ? stopping ? 'Stopping…' : 'Responding' : message.interrupted ? 'Interrupted' : undefined;
  return (
    <Message>
      <MessageAvatar><AgentMark size={24} /></MessageAvatar>
      <MessageContent className="gap-3">
        <MessageHeader className="gap-2 px-0">
          {agentName}
          {state !== undefined && <span className="font-normal">{state}</span>}
        </MessageHeader>
        {message.text && <Markdown text={message.text} streaming={streaming} />}
        {(message.webSearch || message.error) && (
          <Trace>
            <SourcesRow message={message} />
            {message.error && <ErrorRow text={message.error} />}
          </Trace>
        )}
        {message.text && !streaming && (
          <MessageFooter className="px-0"><CopyButton text={message.text} /></MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
});

/**
 * One row of a steps run, as Trace lines: a tool call, an agent's report, a notice, or a reply's own thinking and
 * searches (its text is a message of its own, after the run).
 */
export function StepRows({ message, stopping }: { message: ChatMessage; stopping: boolean }) {
  if (message.role === 'tool' && message.tool) return <ToolRow message={message} />;
  if (message.role === 'notice') {
    return <Marker variant="separator"><MarkerContent>{message.text}</MarkerContent></Marker>;
  }
  const report = message.role === 'work' ? REPORT.exec(message.text) : null;
  const streaming = !!message.streaming;
  if (report) return <ReportRow author={report[1]} body={report[2]} streaming={streaming} />;
  const thinking = message.thinking !== undefined && message.thinking !== '';
  const searching = message.webSearch?.calls.some((call) => call.status === 'running') ?? false;
  return (
    <>
      {thinking && <ReasoningRow text={message.thinking ?? ''} running={streaming && !message.text} />}
      {message.webSearch && <SearchRows calls={message.webSearch.calls} />}
      {!thinking && !message.webSearch && streaming && !message.text && !searching && (
        <ReasoningRow text="" running={!stopping} />
      )}
    </>
  );
}

/** The agent at work without a row of its own yet, as the chatbot template's "Thinking" item. */
export function WorkingRow({ text }: { text: string }) {
  return (
    <Message>
      <MessageContent>
        <Trace>
          <TraceLine status="running">
            <TraceIcon><StatusIcon status="running" /></TraceIcon>
            <TraceTitle>{text}</TraceTitle>
          </TraceLine>
        </Trace>
      </MessageContent>
    </Message>
  );
}
