import type { ConversationId } from '@earendil-works/pi-durable';
import { Alert } from 'react-native';

import { useChatApp } from '@/chat/chat-provider';
import { WorkspaceRemovalError } from '@/pi/chat-service';

type Chat = { id: ConversationId; title: string };

const errorText = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;

/**
 * Rename and delete for the chat menus. Failures go to `onError`, so each screen shows them in its own error banner.
 * A delete whose workspace removal fails after the chat is deleted shows an alert instead, because the screen that
 * asked may be gone.
 */
export function useChatActions(onError: (message: string) => void) {
  const { service } = useChatApp();
  const rename = (chat: Chat) => Alert.prompt('Rename chat', undefined, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Save',
      isPreferred: true,
      onPress: (value?: string) => {
        const title = value?.trim();
        if (!service || !title) return;
        void service.renameChat(chat.id, title)
          .catch((cause: unknown) => onError(errorText(cause, 'Could not rename this chat.')));
      },
    },
  ], 'plain-text', chat.title);
  const remove = (chat: Chat) => Alert.alert('Delete chat?', 'Stops it and removes it and its workspace files.', [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Delete',
      style: 'destructive',
      onPress: () => {
        if (!service) return;
        void service.deleteChat(chat.id).catch((cause: unknown) => {
          if (cause instanceof WorkspaceRemovalError) {
            Alert.alert("Couldn't remove workspace files", cause.message);
            return;
          }
          onError(errorText(cause, 'Could not delete this chat.'));
        });
      },
    },
  ]);
  return { rename, remove };
}
