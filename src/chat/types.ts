import { Type, type Static } from '@earendil-works/pi-ai';
import type { ConversationId } from '@earendil-works/pi-durable';

import { ChatExecutionSettingsSchema } from '../pi/execution/document';
import { FileToolPresentationSchema } from './file-tool-presentation';
import { ChatModelSettingsSchema } from '../pi/model-catalog';
import { ChatImageSchema } from '../pi/user-input';
import { WebSearchPresentationSchema } from './web-search-types';

export interface ChatSummary {
  id: ConversationId;
  title: string;
  preview: string;
  updatedAt: number;
}

/**
 * One transcript row. It also crosses a link to another host, so it is a schema. pi-durable's IDs in it are plain
 * numbers there: the Harness that issued one looks its record up again before using it.
 */
export const ChatMessageSchema = Type.Object({
  id: Type.String(),
  /** `work` is a background agent's report, UniiChat's work message starting "[Name]". */
  role: Type.Enum(['user', 'assistant', 'tool', 'notice', 'work']),
  text: Type.String(),
  createdAt: Type.Number(),
  streaming: Type.Optional(Type.Boolean()),
  interrupted: Type.Optional(Type.Boolean()),
  thinking: Type.Optional(Type.String()),
  /** The image parts of a user message or a tool result, as the model received them. */
  images: Type.Optional(Type.ReadonlyObject(Type.Array(ChatImageSchema))),
  webSearch: Type.Optional(WebSearchPresentationSchema),
  tool: Type.Optional(Type.Object({
    name: Type.String(),
    args: Type.String(),
    status: Type.Enum(['running', 'completed', 'error']),
    output: Type.String(),
    file: Type.Optional(FileToolPresentationSchema),
  })),
  error: Type.Optional(Type.String()),
  /**
   * An input queued in the view's `pi.inbox`, waiting for pi-durable to place it, or one InfiniChat accepted and has
   * not submitted yet, which has no submission.
   */
  queued: Type.Optional(Type.Union([
    Type.Object({ submissionId: Type.Number(), mode: Type.Enum(['followUp', 'steer']) }),
    Type.Object({ mode: Type.Literal('pending') }),
  ])),
});
export type ChatMessage = Static<typeof ChatMessageSchema>;

/** What the header, composer and settings need; it does not change while text streams. */
export const ChatControlsSchema = Type.Object({
  id: Type.Number(),
  title: Type.String(),
  settings: ChatModelSettingsSchema,
  execution: ChatExecutionSettingsSchema,
  busy: Type.Boolean(),
  compacting: Type.Boolean(),
  /** A request failed and is waiting to be tried again. */
  retrying: Type.Boolean(),
  error: Type.Optional(Type.String()),
  /** This chat's tasks that pi-durable parked after the app quit during them too many times in a row. */
  parked: Type.Optional(Type.ReadonlyObject(Type.Array(Type.Number()))),
});
export type ChatControls = Static<typeof ChatControlsSchema>;
