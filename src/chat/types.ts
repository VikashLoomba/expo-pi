import type { ConversationId, SubmissionId } from '@earendil-works/pi-durable';

import type { ChatExecutionSettings } from '../pi/execution/document';
import type { FileToolPresentation } from './file-tool-presentation';
import type { ChatModelSettings } from '../pi/model-catalog';
import type { WebSearchPresentation } from './web-search-types';

export interface ChatSummary {
  id: ConversationId;
  title: string;
  preview: string;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'notice';
  text: string;
  createdAt: number;
  streaming?: boolean;
  interrupted?: boolean;
  thinking?: string;
  webSearch?: WebSearchPresentation;
  tool?: { name: string; args: string; status: 'running' | 'completed' | 'error'; output: string; file?: FileToolPresentation };
  error?: string;
  /** An input queued in the view's `pi.inbox`, waiting for pi-durable to place it. */
  queued?: { submissionId: SubmissionId; mode: 'followUp' | 'steer' };
}

/** What the header, composer and settings need; it does not change while text streams. */
export interface ChatControls {
  id: ConversationId;
  title: string;
  settings: ChatModelSettings;
  execution: ChatExecutionSettings;
  busy: boolean;
  compacting: boolean;
  /** A request failed and is waiting to be tried again. */
  retrying: boolean;
  error?: string;
}
