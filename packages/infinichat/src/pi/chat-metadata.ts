import { defineDoc } from '@earendil-works/pi-durable';

export type ChatMetadata = {
  title: string;
  createdAt: number;
  /** The latest message the user sent. The chat list shows it without reading the transcript. */
  preview?: string;
  updatedAt?: number;
  deleted: boolean;
};

export const ChatMetadataDoc = defineDoc<ChatMetadata>({
  kind: 'app.chat', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  checkpointWhen: () => true,
  initial: () => ({ title: '', createdAt: 0, deleted: false }),
});
