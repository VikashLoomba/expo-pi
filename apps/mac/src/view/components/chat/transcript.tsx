import type { ChatMessage } from '@pi-agent/infinichat/chat/types';
import { HashIcon, LightbulbIcon, LoaderCircleIcon, MessageCircleDashedIcon, PencilIcon } from 'lucide-react';
import { memo, type ReactNode } from 'react';

import { useInfiniChatRef } from '../../hooks/use-infinichat';
import { useMember } from '../../hooks/use-ref';
import { Button } from '../ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../ui/empty';
import {
  MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider,
  MessageScrollerViewport,
} from '../ui/message-scroller';
import { Trace, TraceIcon, TraceLine, TraceTitle } from '../ui/trace';
import { AgentMark, useChatAgentName } from './agent';
import { MessageRow } from './message-row';

const NO_MESSAGES: readonly ChatMessage[] = [];
const suggestions: { icon: ReactNode; title: string; prompt: string }[] = [
  { icon: <LightbulbIcon />, title: 'Make something of an idea',
    prompt: 'Help me think through an idea. Ask me a few questions to get started.' },
  { icon: <PencilIcon />, title: 'Find the right words',
    prompt: 'Help me write something clearly. First, ask what I am writing and who it is for.' },
  { icon: <HashIcon />, title: 'Work it out',
    prompt: 'Help me work through a calculation step by step. First, ask what I need to figure out.' },
];

/** The empty thread as the Chat pattern opens: an Empty state, with the phone's suggestions as Suggestion buttons. */
function EmptyConversation({ onChoose }: { onChoose: (text: string) => void }) {
  const agentName = useChatAgentName();
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon"><AgentMark size={32} /></EmptyMedia>
        <EmptyTitle>Where shall we start?</EmptyTitle>
        <EmptyDescription>Bring your questions. We’ll take it from here.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex flex-wrap justify-center gap-2">
          {suggestions.map((item) => (
            <Button key={item.title} variant="outline" size="sm" onClick={() => onChoose(item.prompt)}>
              {item.icon}
              {item.title}
            </Button>
          ))}
        </div>
        <EmptyDescription><MessageCircleDashedIcon className="mr-1 inline size-3" />
          {agentName} can make mistakes. Check important details.</EmptyDescription>
      </EmptyContent>
    </Empty>
  );
}

/**
 * The thread as the Chat pattern lays it out: one Message Scroller, the person's turns as its anchors, following the
 * reply while the reader stays at the live edge, opening a saved thread at its last turn, with its own jump button.
 * Only this subtree subscribes to the messages, so typing in the composer never renders it; `memo` keeps it that way
 * while its two props stay the same.
 */
export const Transcript = memo(function Transcript({ stopping, onChoose }: {
  stopping: boolean; onChoose: (text: string) => void;
}) {
  const ref = useInfiniChatRef();
  const agentName = useChatAgentName();
  const snapshot = useMember(ref.snapshot)?.view;
  const messages = useMember(ref.messages) ?? NO_MESSAGES;
  const controls = useMember(ref.controls);
  const status = snapshot?.status ?? 'loading';
  if (status === 'missing' || status === 'failed') {
    return <p className="placeholder">{snapshot?.error ?? 'This conversation is unavailable.'}</p>;
  }
  if (status === 'loading') return <p className="placeholder">Opening this conversation…</p>;
  if (messages.length === 0) return <EmptyConversation onChoose={onChoose} />;
  const busy = !!controls?.busy;
  const working = stopping ? 'Stopping…' : controls?.compacting ? 'Summarizing earlier messages…'
    : controls?.retrying ? 'Retrying…' : `${agentName} is thinking…`;
  const showWorking = !!controls?.compacting
    || (busy && !messages.some((message) => message.streaming || message.tool?.status === 'running'));
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
      <MessageScroller className="transcript">
        <MessageScrollerViewport>
          <MessageScrollerContent aria-busy={busy} className="messages gap-6">
            {messages.map((message) => (
              <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor={message.role === 'user'}>
                <MessageRow message={message} stopping={stopping} />
              </MessageScrollerItem>
            ))}
            {showWorking && (
              <MessageScrollerItem messageId="working">
                <Trace>
                  <TraceLine status="running">
                    <TraceIcon><LoaderCircleIcon className="animate-spin" /></TraceIcon>
                    <TraceTitle>{working}</TraceTitle>
                  </TraceLine>
                </Trace>
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
});
