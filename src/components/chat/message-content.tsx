import { useMemo } from 'react';
import { EnrichedMarkdownText, type MarkdownStyle } from 'react-native-enriched-markdown';

import { useChatColors } from '@/hooks/use-chat-colors';
import { openExternalLink } from './source-link';

type ChatColors = ReturnType<typeof useChatColors>;

/** The library ships light-mode colors only, so every element with a color of its own follows the chat's palette. */
function markdownStyleFor(colors: ChatColors): MarkdownStyle {
  const heading = { color: colors.text };
  return {
    paragraph: { fontSize: 16, lineHeight: 25, color: colors.text },
    h1: heading, h2: heading, h3: heading, h4: heading, h5: heading, h6: heading,
    list: { color: colors.text, bulletColor: colors.secondary, markerColor: colors.secondary },
    blockquote: { color: colors.text, borderColor: colors.border, backgroundColor: colors.subtle },
    codeBlock: { color: colors.text, backgroundColor: colors.subtle, borderColor: colors.border },
    code: { color: colors.text, backgroundColor: colors.subtle, borderColor: colors.border },
    link: { color: colors.accent },
    table: {
      color: colors.text, headerTextColor: colors.text, borderColor: colors.border,
      headerBackgroundColor: colors.subtle, rowEvenBackgroundColor: colors.surface,
      rowOddBackgroundColor: colors.surface,
    },
    taskList: { checkedColor: colors.accent, borderColor: colors.border, checkedTextColor: colors.secondary },
    thematicBreak: { color: colors.border },
  };
}

/** A reply still streaming uses the library's streaming animation and its handling of unfinished tables and code. */
export function MessageContent({ text, streaming = false }: {
  text: string;
  streaming?: boolean;
}) {
  const colors = useChatColors();
  const markdownStyle = useMemo(() => markdownStyleFor(colors), [colors]);
  // Model replies are read-only: a task list item shows its state but can't be toggled.
  return <EnrichedMarkdownText markdown={text} flavor="github" markdownStyle={markdownStyle}
    streamingAnimation={streaming} enableTaskListItemToggle={false}
    onLinkPress={({ url }) => { void openExternalLink(url); }} />;
}
