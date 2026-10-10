import { StyleSheet, Text } from 'react-native';

import { useChatColors } from '@/hooks/use-chat-colors';
import { openExternalLink } from '../source-link';
import type { InlineFragment } from './types';

/** Used inside a native Text so formatting, selection, and links remain inline. */
export function InlineContent({ fragment }: { fragment: InlineFragment }) {
  const colors = useChatColors();
  return fragment.runs.map((run) => {
    const href = run.href;
    const linked = href !== undefined;
    const deleted = run.marks.includes('delete');

    return <Text key={run.key}
      accessibilityRole={href ? 'link' : undefined}
      accessibilityHint={href ? 'Opens in your browser' : undefined}
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
  code: { fontFamily: 'Menlo', fontSize: 14 },
  deleted: { textDecorationLine: 'line-through' },
});
