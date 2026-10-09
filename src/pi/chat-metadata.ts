import { defineDoc, type SubmissionId } from '@earendil-works/pi-durable';

export type ChatMetadata = {
  title: string;
  createdAt: number;
  /** The latest message the user sent. The chat list shows it without reading the transcript. */
  preview?: string;
  updatedAt?: number;
  /** The latest input the user sent; a chat reads its outcome from pi-durable when it opens. */
  lastInput?: SubmissionId;
  deleted: boolean;
};

export const ChatMetadataDoc = defineDoc<ChatMetadata>({
  kind: 'app.chat', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ title: '', createdAt: 0, deleted: false }),
});
