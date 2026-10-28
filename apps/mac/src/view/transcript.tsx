import type { ChatControls, ChatMessage } from '@pi-agent/infinichat/chat/types';
import type { ChatViewSnapshot } from '@pi-agent/infinichat/pi/chat-view';
import { useEffect, useRef, useState } from 'react';

import { AgentMark, useChatAgentName } from './agent';
import { Icon, type IconName } from './icon';
import { MessageRow } from './message-row';

const suggestions: { icon: IconName; title: string; detail: string; prompt: string }[] = [
  { icon: 'idea', title: 'Make something of an idea', detail: 'Find a starting point, together.',
    prompt: 'Help me think through an idea. Ask me a few questions to get started.' },
  { icon: 'pencil', title: 'Find the right words', detail: 'A first draft, a fresh perspective.',
    prompt: 'Help me write something clearly. First, ask what I am writing and who it is for.' },
  { icon: 'number', title: 'Work it out', detail: 'A little help with the numbers.',
    prompt: 'Help me work through a calculation step by step. First, ask what I need to figure out.' },
];

function EmptyConversation({ onChoose }: { onChoose: (text: string) => void }) {
  const agentName = useChatAgentName();
  return (
    <div className="empty">
      <AgentMark size={56} />
      <h2 className="empty-title">Where shall we start?</h2>
      <p className="empty-caption">Bring your questions. We’ll take it from here.</p>
      <div className="suggestions">
        {suggestions.map((item) => (
          <button key={item.title} type="button" className="suggestion" onClick={() => onChoose(item.prompt)}>
            <span className="suggestion-icon"><Icon name={item.icon} size={18} /></span>
            <span className="card-identity">
              <span className="suggestion-title">{item.title}</span>
              <span className="suggestion-detail">{item.detail}</span>
            </span>
            <Icon name="chevron" size={11} />
          </button>
        ))}
      </div>
      <p className="disclaimer">{agentName} can make mistakes. Check important details.</p>
    </div>
  );
}

/** How far from the end the transcript still counts as at the end, and follows new messages. */
const NEAR_END = 80;

/**
 * The transcript as the phone's `transcript.tsx` lays it out: the rows, the working footer, the empty state, and a
 * jump to the latest message while the reader is further up. Near the end it follows new and streaming output.
 */
export function Transcript({ messages, controls, snapshot, stopping, onChoose }: {
  messages: readonly ChatMessage[]; controls: ChatControls | undefined; snapshot: ChatViewSnapshot | undefined;
  stopping: boolean; onChoose: (text: string) => void;
}) {
  const agentName = useChatAgentName();
  const scroll = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  const busy = !!controls?.busy;
  const status = snapshot?.status ?? 'loading';
  const working = stopping ? 'Stopping…' : controls?.compacting ? 'Summarizing earlier messages…'
    : controls?.retrying ? 'Retrying…' : `${agentName} is thinking…`;
  const showWorking = controls?.compacting
    || (busy && !messages.some((message) => message.streaming || message.tool?.status === 'running'));
  const scrollToLatest = () => {
    const element = scroll.current;
    if (element) element.scrollTop = element.scrollHeight;
  };
  useEffect(() => {
    if (atEnd) scrollToLatest();
  }, [messages, atEnd]);
  const onScroll = () => {
    const element = scroll.current;
    if (element) setAtEnd(element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_END);
  };
  if (status === 'missing' || status === 'failed') {
    return <p className="placeholder">{snapshot?.error ?? 'This conversation is unavailable.'}</p>;
  }
  if (status === 'loading') return <p className="placeholder">Opening this conversation…</p>;
  return (
    <div className="transcript">
      <div className="transcript-scroll" ref={scroll} onScroll={onScroll}>
        <div className="messages">
          {messages.length === 0 && <EmptyConversation onChoose={onChoose} />}
          {messages.map((message) => <MessageRow key={message.id} message={message} stopping={stopping} />)}
          {messages.length > 0 && (
            <div className="working">
              {showWorking && <><span className="spinner" />{working}</>}
            </div>
          )}
        </div>
      </div>
      {!atEnd && (
        <button type="button" className="scroll-down" aria-label="Scroll to latest message" onClick={scrollToLatest}>
          <Icon name="arrowDown" size={18} />
        </button>
      )}
    </div>
  );
}
