import { Type, type Message, type Static, type UserMessage } from '@earendil-works/pi-ai';

/** pi-ai's image part without its tag: what a saved message carries and what the composer sends. */
export const ChatImageSchema = Type.Object({ data: Type.String(), mimeType: Type.String() });
export type ChatImage = Static<typeof ChatImageSchema>;

/** pi-ai's `UserMessage` content, as a caller on another host sends it: text, or text and image parts. */
export const UserInputSchema = Type.Union([
  Type.String(),
  Type.Array(Type.Union([
    Type.Object({ type: Type.Literal('text'), text: Type.String() }),
    Type.Object({ type: Type.Literal('image'), ...ChatImageSchema.properties }),
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
