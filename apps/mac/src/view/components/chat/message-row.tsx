import type { ChatMessage } from '@pi-agent/infinichat/chat/types';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';

import { Bubble, BubbleContent } from '../ui/bubble';
import { Button } from '../ui/button';
import { Marker, MarkerContent } from '../ui/marker';
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from '../ui/message';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Trace } from '../ui/trace';
import { AgentMark, useChatAgentName } from './agent';
import { MessageContent as Markdown } from './message-content';
import { MessageImages } from './message-images';
import { ErrorRow, ReasoningRow, ReportRow, SearchRows, SourcesRow, ToolRow } from './trace-rows';

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
 * One turn of the thread as AI Elements lay it out: the person's text in a bubble on the end side; the agent's reply
 * with its steps (thinking, tool calls, searches, sources) as Trace lines and its actions in the footer; a notice as
 * a marker between turns; an agent's report as a subagent run. `memo`: a streamed delta replaces only the rows it
 * touches, so the others keep their rendered Markdown.
 */
export const MessageRow = memo(function MessageRow({ message, stopping = false }: {
  message: ChatMessage; stopping?: boolean;
}) {
  const agentName = useChatAgentName();
  if (message.role === 'notice') {
    return <Marker variant="separator"><MarkerContent>{message.text}</MarkerContent></Marker>;
  }
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
  if (message.role === 'tool' && message.tool) {
    return (
      <Message>
        <MessageContent>
          <Trace><ToolRow message={message} /></Trace>
        </MessageContent>
      </Message>
    );
  }
  const report = message.role === 'work' ? REPORT.exec(message.text) : null;
  const streaming = !!message.streaming;
  if (report) {
    return (
      <Message>
        <MessageContent>
          <Trace><ReportRow author={report[1]} body={report[2]} streaming={streaming} /></Trace>
        </MessageContent>
      </Message>
    );
  }
  const searching = message.webSearch?.calls.some((call) => call.status === 'running') ?? false;
  const steps = (message.thinking !== undefined && message.thinking !== '') || message.webSearch !== undefined;
  const state = streaming ? stopping ? 'Stopping…' : 'Responding' : message.interrupted ? 'Interrupted' : undefined;
  return (
    <Message>
      <MessageAvatar><AgentMark size={24} /></MessageAvatar>
      <MessageContent className="gap-3">
        <MessageHeader className="gap-2 px-0">
          {agentName}
          {state !== undefined && <span className="font-normal">{state}</span>}
        </MessageHeader>
        {steps && (
          <Trace>
            {message.thinking !== undefined && message.thinking !== '' && (
              <ReasoningRow text={message.thinking} running={streaming && !message.text} />
            )}
            {message.webSearch && <SearchRows calls={message.webSearch.calls} />}
          </Trace>
        )}
        {message.text ? <Markdown text={message.text} streaming={streaming} />
          : streaming && !searching && !message.thinking ? <ReasoningRow text="" running /> : null}
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
