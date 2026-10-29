import type { Readable } from '@earendil-works/chord';
import type { UserMessage } from '@earendil-works/pi-ai';
import type { ChatControls, ChatMessage } from '@pi-agent/infinichat/chat/types';
import type { ChatViewSnapshot } from '@pi-agent/infinichat/pi/chat-view';
import { createContext, use } from 'react';

/**
 * What the thread reads of a conversation, whichever object serves it: the view's cells as `MacInfiniChat` and
 * `MacChat` both carry them (the phone's `ChatViewSource`), and the one action a row offers. A reference to either
 * object is a source as it is.
 */
export interface ThreadSource {
  readonly snapshot: Readable<{ view: ChatViewSnapshot }>;
  readonly controls: Readable<ChatControls | null>;
  readonly messages: Readable<readonly ChatMessage[]>;
  /** Sends a queued follow-up again as a steer; InfiniChat's queue offers no such action. */
  readonly steerQueued?: (submissionId: number, content: UserMessage['content']) => Promise<void>;
}

export const ThreadSourceContext = createContext<ThreadSource | undefined>(undefined);

export function useThreadSource(): ThreadSource {
  const source = use(ThreadSourceContext);
  if (source === undefined) throw new Error('The thread renders inside a conversation screen.');
  return source;
}
