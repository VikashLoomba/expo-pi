import type { ChatMessage } from '@pi-agent/infinichat/chat/types';
import { collectSearchSources, type SearchSource } from '@pi-agent/infinichat/chat/web-search-presentation';
import {
  ArrowUpRightIcon, BotIcon, CircleCheckIcon, FileTextIcon, GlobeIcon, LoaderCircleIcon, SearchIcon, TerminalIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useState } from 'react';

import { useOpenExternal } from '../../lib/app-context';
import { CodeBlock, CodeBlockContent, CodeBlockHeader, CodeBlockTitle } from '../ui/code-block';
import {
  Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine,
  TraceTitle,
} from '../ui/trace';
import { MessageContent } from './message-content';
import { MessageImages } from './message-images';

type WebSearchCall = NonNullable<ChatMessage['webSearch']>['calls'][number];

/** A small code block for a tool's input, output or diff, as the Tool pattern shows output. */
function Output({ title, text }: { title?: string; text: string }) {
  return (
    <CodeBlock size="sm">
      {title !== undefined && <CodeBlockHeader><CodeBlockTitle>{title}</CodeBlockTitle></CodeBlockHeader>}
      <CodeBlockContent wrap className="max-h-64">{text}</CodeBlockContent>
    </CodeBlock>
  );
}

/**
 * The model's thinking as the Reasoning pattern shows it: open while it streams, closed once done, unless the reader
 * chose; a plain line until any text arrives.
 */
export function ReasoningRow({ text, running }: { text: string; running: boolean }) {
  const [open, setOpen] = useState<boolean>();
  const line = (
    <TraceLine status={running ? 'running' : undefined}>
      <TraceIcon>{running ? <LoaderCircleIcon className="animate-spin" /> : <CircleCheckIcon />}</TraceIcon>
      <TraceTitle>{running ? 'Thinking' : 'Thought'}</TraceTitle>
    </TraceLine>
  );
  if (!text) return line;
  return (
    <TraceCollapsible open={open ?? running} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="whitespace-pre-wrap">{text}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** A tool call as the Tool pattern shows it: a running or failed line, a collapsible once it has a result. */
export function ToolRow({ message }: { message: ChatMessage }) {
  const tool = message.tool;
  if (!tool) return null;
  const file = tool.file;
  const name = tool.name.replace(/_/g, ' ');
  const what = file ? `${name} ${file.path}` : name;
  const icon = file ? <FileTextIcon /> : <TerminalIcon />;
  if (tool.status === 'running') {
    return (
      <TraceLine status="running">
        <TraceIcon>{icon}</TraceIcon>
        <TraceTitle>Running {what}</TraceTitle>
      </TraceLine>
    );
  }
  const failed = tool.status === 'error';
  return (
    <TraceCollapsible defaultOpen={failed}>
      <TraceCollapsibleTrigger>
        <TraceLine status={failed ? 'error' : undefined}>
          <TraceIcon>{icon}</TraceIcon>
          <TraceTitle>{failed ? 'Failed to run' : 'Ran'} {what}</TraceTitle>
          {file?.summary && <TraceDescription>{file.summary}</TraceDescription>}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-2 pt-1">
        {!file && tool.args && <Output title="Input" text={tool.args} />}
        {message.images?.length ? <MessageImages images={message.images} /> : null}
        {(tool.output || !message.images?.length) && (
          <Output title="Result" text={tool.output || 'No text output.'} />
        )}
        {file?.diff !== undefined && (
          <Output text={file.diff}
            title={`Changes${file.firstChangedLine ? ` · line ${file.firstChangedLine}` : ''}`} />
        )}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** One web search call: a line per search, running until the provider answers, as the phone's activity card. */
function SearchRow({ call }: { call: WebSearchCall }) {
  const running = call.status === 'running';
  const failed = call.status === 'failed';
  const what = call.queries?.length ? call.queries.map((query) => `“${query}”`).join(', ')
    : call.pattern ? `“${call.pattern}”` : 'the web';
  const verb = running ? 'Searching for' : failed ? 'Failed to search for'
    : call.status === 'interrupted' ? 'Stopped searching for' : 'Searched for';
  return (
    <TraceLine status={running ? 'running' : failed ? 'error' : undefined}>
      <TraceIcon>{running ? <LoaderCircleIcon className="animate-spin" /> : <SearchIcon />}</TraceIcon>
      <TraceTitle>{verb} {what}</TraceTitle>
    </TraceLine>
  );
}

export function SearchRows({ calls }: { calls: readonly WebSearchCall[] }) {
  return <>{calls.map((call) => <SearchRow key={call.id} call={call} />)}</>;
}

/** The links a reply used, as the Sources pattern lists them, opened through the main process. */
export function SourcesRow({ message }: { message: ChatMessage }) {
  const openExternal = useOpenExternal();
  const sources: readonly SearchSource[] = message.webSearch ? collectSearchSources(message.webSearch) : [];
  if (sources.length === 0) return null;
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon><GlobeIcon /></TraceIcon>
          <TraceTitle>Used {sources.length} {sources.length === 1 ? 'source' : 'sources'}</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Trace>
          {sources.map((source) => (
            <button key={source.url} type="button" className="text-left" onClick={() => openExternal(source.url)}>
              <TraceLine>
                <TraceIcon><GlobeIcon /></TraceIcon>
                <TraceTitle>{source.title || source.host}</TraceTitle>
                <TraceDescription>{source.host}{source.cited ? ' · cited' : ''}</TraceDescription>
                <TraceIcon><ArrowUpRightIcon /></TraceIcon>
              </TraceLine>
            </button>
          ))}
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** An agent's report, as the Subagent pattern shows a run: the agent's name on the line, its report inside. */
export function ReportRow({ author, body, streaming }: { author: string; body: string; streaming: boolean }) {
  return (
    <TraceCollapsible defaultOpen>
      <TraceCollapsibleTrigger>
        <TraceLine status={streaming ? 'running' : undefined}>
          <TraceIcon>{streaming ? <LoaderCircleIcon className="animate-spin" /> : <BotIcon />}</TraceIcon>
          <TraceTitle>{streaming ? `${author} is working` : `${author} reported`}</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent keepMounted className="pt-1">
        <MessageContent text={body} streaming={streaming} />
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** A failure the message carries, as a line. */
export function ErrorRow({ text }: { text: string }) {
  return (
    <TraceLine status="error">
      <TraceIcon><TriangleAlertIcon /></TraceIcon>
      <TraceTitle>{text}</TraceTitle>
    </TraceLine>
  );
}
