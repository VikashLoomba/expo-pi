import type { ChatMessage } from '@pi-agent/infinichat/chat/types';
import { collectSearchSources } from '@pi-agent/infinichat/chat/web-search-presentation';
import { memo, useEffect, useRef, useState } from 'react';

import { AgentMark, useChatAgentName } from './agent';
import { Icon } from './icon';
import { MessageContent } from './message-content';
import { MessageImages } from './message-images';
import { ToolCard } from './tool-card';
import { WebSearchActivity, WebSearchSources } from './web-search';

/**
 * One transcript row, as the phone's `message-row.tsx` draws it; ordinary chats' "Send as steer" comes with them.
 * `memo`: a streamed delta replaces only the rows it touches, so the others keep their rendered Markdown.
 */
export const MessageRow = memo(function MessageRow({ message, stopping = false }: {
  message: ChatMessage; stopping?: boolean;
}) {
  const agentName = useChatAgentName();
  const [copied, setCopied] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timeout.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopied(true);
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // The row's text can be selected and copied by hand.
    }
  };
  if (message.role === 'tool' && message.tool) return <ToolCard message={message} />;
  if (message.role === 'notice') return <p className="notice-row">{message.text}</p>;
  if (message.role === 'user') {
    return (
      <div className="user-row">
        <div className="user-bubble">
          {message.images?.length ? <MessageImages images={message.images} size={140} /> : null}
          {message.text}
        </div>
        {message.queued && (
          <span className="queued-meta">
            {message.queued.mode === 'steer' ? 'Queued · steer'
              : message.queued.mode === 'followUp' ? 'Queued · follow-up' : 'Queued'}
          </span>
        )}
      </div>
    );
  }
  // An agent's report is UniiChat's work message, "[Name]" and its text: the name heads the row and the text is its
  // body, without the zoom pointer for the model.
  const report = message.role === 'work'
    ? /^\[([^\]\r\n]+)\]\s*([\s\S]*?)(?:\s*Full chat: zoom\("[^"\r\n]*"\))?\s*$/.exec(message.text) : null;
  const author = report?.[1] ?? agentName;
  const body = report?.[2] ?? message.text;
  const sources = message.webSearch ? collectSearchSources(message.webSearch) : [];
  const waiting = message.streaming && !body
    && !message.webSearch?.calls.some((call) => call.status === 'running');
  return (
    <div className="assistant">
      <div className="assistant-identity">
        <AgentMark size={24} />
        <span className="assistant-name">{author}</span>
        <span>
          {message.streaming ? stopping ? 'Stopping…' : 'Responding' : message.interrupted ? 'Interrupted' : ''}
        </span>
      </div>
      {message.webSearch && <WebSearchActivity calls={message.webSearch.calls} />}
      {message.thinking && (
        <details className="thinking">
          <summary><Icon name="spark" size={14} /> Thinking</summary>
          <div className="thinking-text">{message.thinking}</div>
        </details>
      )}
      {body ? <MessageContent text={body} streaming={message.streaming} />
        : waiting ? <span className="spinner" /> : null}
      <WebSearchSources sources={sources} />
      {message.error && <div className="message-error">{message.error}</div>}
      {message.text && (
        <button type="button" className="copy-button" onClick={() => { void copy(); }}>
          <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? 'Copied' : 'Copy'}
        </button>
      )}
    </div>
  );
});
