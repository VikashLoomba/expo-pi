import type { Message, UserMessage } from '@earendil-works/pi-ai';
import { stringLiteral } from '@earendil-works/pi-ai/providers/schema-builders';
import { arr, obj, str, union, type Static } from '@earendil-works/pi-schema';

/** pi-ai's image part without its tag: what a saved message carries and what the composer sends. */
export const ChatImageProperties = { data: str(), mimeType: str() };
export const ChatImageSchema = obj(ChatImageProperties, { open: true });
export type ChatImage = Static<typeof ChatImageSchema>;

/**
 * pi-ai's `UserMessage` content, as a caller on another host sends it: text, or text and image parts. Its objects are
 * closed, as Chord requires of every object in a method's arguments (chord `docs/design.md` §5, "Arguments").
 */
export const UserInputSchema = union([
  str(),
  arr(union([
    obj({ type: stringLiteral('text'), text: str() }),
    obj({ type: stringLiteral('image'), ...ChatImageProperties }),
  ])),
]);

/** The text parts of a message's content, joined. */
export const textOf = (content: Message['content']) => typeof content === 'string' ? content
  : content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');

/** The image parts of a message's content, in order. */
export const imagesOf = (content: Message['content']): ChatImage[] => typeof content === 'string' ? []
  : content.flatMap((part) => part.type === 'image' ? [{ data: part.data, mimeType: part.mimeType }] : []);

/** pi-durable's input content: plain text, or text and image parts as pi-ai's `UserMessage` carries them. */
export function userInput(text: string, images: readonly ChatImage[]): UserMessage['content'] {
  if (!images.length) return text;
  return [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...images.map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })),
  ];
}
