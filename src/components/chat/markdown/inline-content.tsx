import { Platform, StyleSheet, Text } from 'react-native';

import { useChatColors } from '@/hooks/use-chat-colors';
import { openExternalLink } from '../source-link';
import { citedInlineRuns, type InlineCitation } from '../web-search-presentation';
import type { InlineFragment } from './types';

/** Used inside a native Text so formatting, selection, and links remain inline. */
export function InlineContent({ fragment, citations }: {
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
}

const styles = StyleSheet.create({
  strong: { fontWeight: '600' },
  emphasis: { fontStyle: 'italic' },
  code: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 14 },
  deleted: { textDecorationLine: 'line-through' },
});
