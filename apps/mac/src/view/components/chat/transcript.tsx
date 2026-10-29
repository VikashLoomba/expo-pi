import { turnsOf, type Turn } from '@pi-agent/infinichat/chat/turns';
import type { ChatMessage } from '@pi-agent/infinichat/chat/types';
import { useVirtualizer } from '@tanstack/react-virtual';
import { HashIcon, LightbulbIcon, MessageCircleDashedIcon, PencilIcon } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useInfiniChatRef } from '../../hooks/use-infinichat';
import { useMember } from '../../hooks/use-ref';
import { Button } from '../ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../ui/empty';
import {
  MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerProvider, MessageScrollerViewport,
} from '../ui/message-scroller';
import { AgentMark, useChatAgentName } from './agent';
import { Placeholder } from './placeholder';
import { TurnRow } from './turn-row';

const NO_MESSAGES: readonly ChatMessage[] = [];
/** The Message Scroller docs' estimate for a row not yet rendered; rows measure themselves once they are. */
const ESTIMATED_ROW = 86;
const NO_TURNS: readonly string[] = [];
const suggestions: { icon: ReactNode; title: string; prompt: string }[] = [
  { icon: <LightbulbIcon />, title: 'Make something of an idea',
    prompt: 'Help me think through an idea. Ask me a few questions to get started.' },
  { icon: <PencilIcon />, title: 'Find the right words',
    prompt: 'Help me write something clearly. First, ask what I am writing and who it is for.' },
  { icon: <HashIcon />, title: 'Work it out',
    prompt: 'Help me work through a calculation step by step. First, ask what I need to figure out.' },
];

/** The empty thread as the chatbot template opens: an Empty state with the phone's suggestions as buttons. */
function EmptyConversation({ onChoose }: { onChoose: (text: string) => void }) {
  const agentName = useChatAgentName();
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Empty>
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
    </div>
  );
}

/**
 * The thread as the Chat pattern lays it out, folded by turn (owner, 2026-10-29): the newest turn open in full, the
 * earlier ones each a summary line that opens on a click, and a new turn the only open one again. The rows are
 * virtualized the way the Message Scroller docs show for a transcript past "hundreds to low thousands of turns":
 * the viewport is the scroll element and a virtualizer owns the rows, measured as they render. The thread opens on
 * the newest turn's start, and a new turn settles there too, as `scrollAnchor` does for a MessageScrollerItem; the
 * scroller follows the reply while the reader stays at the live edge, and offers its jump button.
 */
function Thread({ turns, stopping, busy, working }: {
  turns: readonly Turn[]; stopping: boolean; busy: boolean; working: string | undefined;
}) {
  // TanStack Virtual's instance is not memoizable by the React Compiler; its docs opt the component out. This
  // build runs no compiler, so the lint rule's warning does not apply.
  'use no memo';
  const viewport = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- opted out above
  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => ESTIMATED_ROW,
    getItemKey: (index) => turns[index]?.id ?? index,
    overscan: 8,
  });
  // The turns open: the newest alone whenever a new one begins, plus the ones the reader opened since.
  const newest = turns.at(-1)?.id;
  const [opened, setOpened] = useState<{ newest: string | undefined; open: readonly string[] }>(
    () => ({ newest, open: newest === undefined ? NO_TURNS : [newest] }));
  if (opened.newest !== newest) setOpened({ newest, open: newest === undefined ? NO_TURNS : [newest] });
  const setOpen = (id: string, open: boolean) => setOpened((current) => ({
    ...current, open: open ? [...current.open, id] : current.open.filter((other) => other !== id),
  }));
  // The thread opens on the newest turn's start, and settles a later one there as it begins.
  const settled = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (newest === undefined || newest === settled.current) return;
    settled.current = newest;
    virtualizer.scrollToIndex(turns.length - 1, { align: 'start' });
  }, [newest, turns.length, virtualizer]);
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="flex-1 select-text">
        <MessageScrollerViewport ref={viewport}>
          <MessageScrollerContent aria-busy={busy} className="mx-auto block min-h-full w-full max-w-2xl px-6 py-4">
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const turn = turns[item.index];
                if (turn === undefined) return null;
                return (
                  <div key={item.key} ref={virtualizer.measureElement} data-index={item.index}
                    className="absolute start-0 top-0 w-full pb-6"
                    style={{ transform: `translateY(${item.start}px)` }}>
                    <TurnRow turn={turn} open={opened.open.includes(turn.id)} stopping={stopping}
                      onOpenChange={(open) => setOpen(turn.id, open)}
                      working={item.index === turns.length - 1 ? working : undefined} />
                  </div>
                );
              })}
            </div>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

/**
 * Only this subtree subscribes to the messages, so typing in the composer never renders it; `memo` keeps it that
 * way while its two props stay the same.
 */
export const Transcript = memo(function Transcript({ stopping, onChoose }: {
  stopping: boolean; onChoose: (text: string) => void;
}) {
  const ref = useInfiniChatRef();
  const agentName = useChatAgentName();
  const snapshot = useMember(ref.snapshot)?.view;
  const messages = useMember(ref.messages) ?? NO_MESSAGES;
  const memory = useMember(ref.memory) ?? undefined;
  const controls = useMember(ref.controls);
  const status = snapshot?.status ?? 'loading';
  const busy = !!controls?.busy;
  const working = stopping ? 'Stopping…' : controls?.compacting ? 'Summarizing earlier messages…'
    : controls?.retrying ? 'Retrying…' : `${agentName} is thinking…`;
  const showWorking = !!controls?.compacting
    || (busy && !messages.some((message) => message.streaming || message.tool?.status === 'running'));
  const turns = useMemo(() => turnsOf(messages, memory), [messages, memory]);
  if (status === 'missing' || status === 'failed') {
    return <Placeholder>{snapshot?.error ?? 'This conversation is unavailable.'}</Placeholder>;
  }
  if (status === 'loading') return <Placeholder>Opening this conversation…</Placeholder>;
  if (messages.length === 0) return <EmptyConversation onChoose={onChoose} />;
  return <Thread turns={turns} stopping={stopping} busy={busy} working={showWorking ? working : undefined} />;
});
