import type { ChatMessage } from '@pi-agent/infinichat/chat/types';
import { memo } from 'react';

import { useInfiniChatRef } from '../../hooks/use-infinichat';
import { useMember } from '../../hooks/use-ref';
import { useTranscriptScroll } from '../../hooks/use-transcript-scroll';
import { AgentMark, useChatAgentName } from './agent';
import { Icon, type IconName } from './icon';
import { MessageRow } from './message-row';

const NO_MESSAGES: readonly ChatMessage[] = [];
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

/** The rows, the working footer and the empty state in a scroller that lives as long as this list does. */
function MessageList({ stopping, onChoose }: { stopping: boolean; onChoose: (text: string) => void }) {
  const ref = useInfiniChatRef();
  const agentName = useChatAgentName();
  const messages = useMember(ref.messages) ?? NO_MESSAGES;
  const controls = useMember(ref.controls);
  const { scroller, atEnd, scrollToLatest, onScroll } = useTranscriptScroll();
  const busy = !!controls?.busy;
  const working = stopping ? 'Stopping…' : controls?.compacting ? 'Summarizing earlier messages…'
    : controls?.retrying ? 'Retrying…' : `${agentName} is thinking…`;
  const showWorking = controls?.compacting
    || (busy && !messages.some((message) => message.streaming || message.tool?.status === 'running'));
  return (
    <div className="transcript">
      <div className="transcript-scroll" ref={scroller} onScroll={onScroll}>
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

/**
 * The transcript as the phone's `transcript.tsx` lays it out: the conversation's state, then its message list. Only
 * this subtree subscribes to the messages, so typing in the composer never renders it; `memo` keeps it that way while
 * its two props stay the same.
 */
export const Transcript = memo(function Transcript({ stopping, onChoose }: {
  stopping: boolean; onChoose: (text: string) => void;
}) {
  const ref = useInfiniChatRef();
  const snapshot = useMember(ref.snapshot)?.view;
  const status = snapshot?.status ?? 'loading';
  if (status === 'missing' || status === 'failed') {
    return <p className="placeholder">{snapshot?.error ?? 'This conversation is unavailable.'}</p>;
  }
  if (status === 'loading') return <p className="placeholder">Opening this conversation…</p>;
  return <MessageList stopping={stopping} onChoose={onChoose} />;
});
