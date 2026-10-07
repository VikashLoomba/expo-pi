import { defineDoc } from '@earendil-works/pi-durable';

export type ChatMetadata = {
  title: string;
  createdAt: number;
  archived: boolean;
  /** The latest message the user sent. The chat list shows it without reading the transcript. */
  preview?: string;
  updatedAt?: number;
};

export const ChatMetadataDoc = defineDoc<ChatMetadata>({
  kind: 'app.chat', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ title: '', createdAt: 0, archived: false }),
});
