import type { Context } from '@earendil-works/chord/context';
import type { Watchable } from '@earendil-works/chord/watch';
import type { UserMessage } from '@earendil-works/pi-ai';
import type { ChatControls, ChatMessage, TranscriptGap } from '@pi-agent/infinichat/chat/types';
import type { ChatViewSnapshot } from '@pi-agent/infinichat/pi/chat-view';
import { createContext, use } from 'react';

/**
 * What the thread reads of a conversation, whichever object serves it: the view's cells as `MacInfiniChat` and
 * `MacChat` both carry them (the phone's `ChatViewSource`), and the one action a row offers. A reference to either
 * object is a source as it is.
 */
export interface ThreadSource {
  readonly snapshot: Watchable<{ view: ChatViewSnapshot }>;
  readonly controls: Watchable<ChatControls | null>;
  readonly messages: Watchable<readonly ChatMessage[]>;
  /** Sends a queued follow-up again as a steer; InfiniChat's queue offers no such action. */
  readonly steerQueued?: (submissionId: number, content: UserMessage['content']) => Promise<unknown>;
  /** Load the entries a history row stands for (`ChatViewSource`'s `loadEarlier` and `fillGap`). */
  readonly loadEarlier: (context: Context) => Promise<unknown>;
  readonly fillGap: (gap: TranscriptGap, context: Context) => Promise<unknown>;
}

export const ThreadSourceContext = createContext<ThreadSource | undefined>(undefined);

export function useThreadSource(): ThreadSource {
  const source = use(ThreadSourceContext);
  if (source === undefined) throw new Error('The thread renders inside a conversation screen.');
  return source;
}
