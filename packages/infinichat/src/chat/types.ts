import { stringLiteral } from '@earendil-works/pi-ai/providers/schema-builders';
import { arr, bool, lit, num, obj, oneOf, opt, str, union, type Static } from '@earendil-works/pi-schema';
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
export const ChatMessageSchema = obj({
  id: str(),
  /** `work` is a background agent's report, UniiChat's work message starting "[Name]". */
  role: oneOf(['user', 'assistant', 'tool', 'notice', 'work']),
  text: str(),
  createdAt: num(),
  streaming: opt(bool()),
  interrupted: opt(bool()),
  thinking: opt(str()),
  /** The image parts of a user message or a tool result, as the model received them. */
  images: opt(arr(ChatImageSchema)),
  webSearch: opt(WebSearchPresentationSchema),
  tool: opt(obj({
    name: str(),
    args: str(),
    status: oneOf(['running', 'completed', 'error']),
    output: str(),
    file: opt(FileToolPresentationSchema),
  }, { open: true })),
  error: opt(str()),
  /**
   * An input queued in the view's `pi.inbox`, waiting for pi-durable to place it, or one InfiniChat accepted and has
   * not submitted yet, which has no submission.
   */
  queued: opt(union([
    obj({ submissionId: num(), mode: oneOf(['followUp', 'steer']) }, { open: true }),
    obj({ mode: stringLiteral('pending') }, { open: true }),
  ])),
  /**
   * A placed input: true opened a logical turn of its own (OptChat's fresh turn), false steered the turn under way.
   * The transcript folds a thread by these.
   */
  fresh: opt(bool()),
  /**
   * A row for transcript the client has not loaded, an item of pi-durable's `ConversationTranscript`: `earlier` above
   * the oldest entry held, `gap` where entries after `after` and before `upTo` (entry IDs as numbers) were missed.
   * The screens load it when it scrolls into view (`ChatViewSource`'s `loadEarlier` and `fillGap`).
   */
  history: opt(union([
    obj({ kind: lit('earlier') }, { open: true }),
    obj({ kind: lit('gap'), after: num(), upTo: num() }, { open: true }),
  ])),
}, { open: true });
export type ChatMessage = Static<typeof ChatMessageSchema>;
/** The entries a `gap` row stands for. */
export type TranscriptGap = { after: number; upTo: number };

/** What the header, composer and settings need; it does not change while text streams. */
export const ChatControlsProperties = {
  id: num(),
  title: str(),
  settings: ChatModelSettingsSchema,
  execution: ChatExecutionSettingsSchema,
  busy: bool(),
  compacting: bool(),
  /** A request failed and is waiting to be tried again. */
  retrying: bool(),
  error: opt(str()),
  /**
   * Why the last run ended without an answer, pi-durable's `pi.live.runFailure`, until a later run starts: its reason
   * and what the screens say. They offer to continue the run (a continue submission) while nothing else runs.
   */
  runFailure: opt(obj({ reason: str(), message: str() }, { open: true })),
};
export const ChatControlsSchema = obj(ChatControlsProperties, { open: true });
export type ChatControls = Static<typeof ChatControlsSchema>;
