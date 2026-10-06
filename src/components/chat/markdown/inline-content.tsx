import { memo } from 'react';
import { Platform, StyleSheet, Text } from 'react-native';

import { useChatColors } from '@/hooks/use-chat-colors';
import { openExternalLink } from '../source-link';
import { citedInlineRuns, type InlineCitation } from '../web-search-presentation';
import type { InlineFragment } from './types';

/** New arrays of unchanged provider annotations must not repaint closed blocks. */
export function sameCitations(previous: readonly InlineCitation[], next: readonly InlineCitation[]): boolean {
  return previous === next || (previous.length === next.length && previous.every((citation, index) => {
    const other = next[index];
    return citation.id === other.id && citation.startIndex === other.startIndex && citation.endIndex === other.endIndex
      && citation.url === other.url && citation.title === other.title && citation.number === other.number;
  }));
}

/** Used inside a native Text so formatting, selection, and links remain inline. */
export const InlineContent = memo(function InlineContent({ fragment, citations }: {
  fragment: InlineFragment;
  citations: readonly InlineCitation[];
}) {
  const colors = useChatColors();
  return citedInlineRuns(fragment, citations).map((run) => {
    const citation = run.citation;
    const href = citation?.url ?? run.href;
    const linked = !!citation || run.href !== undefined;
    const deleted = run.marks.includes('delete');

    return <Text key={run.key}
      accessibilityRole={href ? 'link' : undefined}
      accessibilityLabel={citation ? `Citation ${citation.number}, ${citation.title || citation.url}` : undefined}
      accessibilityHint={href ? 'Opens in your browser' : undefined}
      testID={citation ? `inline-citation-${citation.id}-${run.key}` : undefined}
      onPress={href ? () => { void openExternalLink(href); } : undefined}
      style={[
        run.marks.includes('strong') && styles.strong,
        run.marks.includes('emphasis') && styles.emphasis,
        run.marks.includes('code') && [styles.code, { backgroundColor: colors.subtle }],
        deleted && styles.deleted,
        linked && { color: colors.accent, textDecorationLine: deleted ? 'underline line-through' : 'underline' },
      ]}>
      {run.text}
    </Text>;
  });
}, (previous, next) => previous.fragment === next.fragment && sameCitations(previous.citations, next.citations));

const styles = StyleSheet.create({
  strong: { fontWeight: '600' },
  emphasis: { fontStyle: 'italic' },
  code: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 14 },
  deleted: { textDecorationLine: 'line-through' },
});
