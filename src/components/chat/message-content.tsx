import * as Clipboard from 'expo-clipboard';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useChatColors, type ChatColors } from '@/hooks/use-chat-colors';
import { ChatIcon } from './icon';
import { openSourceLink } from './source-link';
import { createMarkdownParser, parseInline, type MarkdownBlock } from './streaming-markdown';
import { citedInlineTokens, type CitedInlineToken, type InlineCitation } from './web-search-presentation';

const monospace = Platform.select({ ios: 'Menlo', default: 'monospace' });

const noCitations: readonly InlineCitation[] = [];

function InlineContent({ block, streaming, colors, citations }: {
  block: MarkdownBlock; streaming: boolean; colors: ChatColors; citations: readonly InlineCitation[];
}) {
  const tokens = citations.length || block.text.includes('\uE200') ? citedInlineTokens(block, streaming, citations) : parseInline(block.text, streaming);
  return tokens.map((token) => {
    const citation = (token as CitedInlineToken).citation;
    if (citation) return <Text key={token.key} accessibilityRole="link"
      accessibilityLabel={`Citation ${citation.number}, ${citation.title || citation.url}`}
      accessibilityHint="Opens source in your browser" testID={`inline-citation-${citation.id}-${token.key}`}
      onPress={() => { void openSourceLink(citation.url); }} style={[
        token.kind === 'strong' && styles.bold, token.kind === 'emphasis' && styles.emphasis,
        token.kind === 'code' && styles.inlineCode, { color: colors.accent, textDecorationLine: 'underline' },
      ]}>{token.text}</Text>;
    if (token.kind === 'strong') return <Text key={token.key} style={styles.bold}>{token.text}</Text>;
    if (token.kind === 'emphasis') return <Text key={token.key} style={styles.emphasis}>{token.text}</Text>;
    if (token.kind === 'code') return <Text key={token.key} style={[styles.inlineCode, { backgroundColor: colors.subtle }]}>{token.text}</Text>;
    if (token.kind === 'link') return <Text key={token.key} accessibilityRole={token.href ? 'link' : undefined}
      style={{ color: colors.accent, textDecorationLine: 'underline' }}
      onPress={token.href ? () => { void Linking.openURL(token.href!).catch(() => Alert.alert('Could not open link', token.href)); } : undefined}>{token.text}</Text>;
    return token.text;
  });
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const colors = useChatColors();
  const [copied, setCopied] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timeout.current), []);
  const copy = async () => {
    try {
      if (!await Clipboard.setStringAsync(code)) throw new Error('Clipboard unavailable');
      setCopied(true);
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setCopied(false), 2000);
    } catch { Alert.alert('Could not copy', 'You can select the text and copy it manually.'); }
  };
  return <View style={[styles.codeBlock, { backgroundColor: colors.subtle, borderColor: colors.border }]}>
    <View style={[styles.codeHeader, { borderBottomColor: colors.border }]}>
      <Text numberOfLines={1} style={[styles.codeLanguage, { color: colors.secondary }]}>{language || 'Code'}</Text>
      <Pressable accessibilityLabel={copied ? 'Code copied' : 'Copy code'} accessibilityRole="button" onPress={() => { void copy(); }} style={styles.copyCode}>
        <ChatIcon name={copied ? 'check' : 'copy'} color={colors.secondary} size={15} />
        <Text style={[styles.copyLabel, { color: colors.secondary }]}>{copied ? 'Copied' : 'Copy'}</Text>
      </Pressable>
    </View>
    <ScrollView horizontal contentContainerStyle={styles.codeScroll}>
      <Text selectable style={[styles.code, { color: colors.text }]}>{code || ' '}</Text>
    </ScrollView>
  </View>;
}

const ContentBlock = memo(function ContentBlock({ block, streaming, spacing, citations }: {
  block: MarkdownBlock; streaming: boolean; spacing: number; citations: readonly InlineCitation[];
}) {
  const colors = useChatColors();
  const content = <InlineContent block={block} streaming={streaming} colors={colors} citations={citations} />;
  return <View style={{ marginTop: spacing }}>
    {block.kind === 'code' ? <CodeBlock language={block.language ?? ''} code={block.text} />
      : block.kind === 'list-item' ? <View style={[styles.listRow, { paddingLeft: (block.indent ?? 0) * 5 }]}>
        <Text style={[styles.listMarker, { color: colors.secondary }]}>{block.marker}</Text>
        <Text selectable style={[styles.body, styles.listText, { color: colors.text }]}>{content}</Text>
      </View>
      : block.kind === 'heading' ? <Text selectable style={[styles.heading, { color: colors.text, fontSize: block.level === 1 ? 23 : 19 }]}>{content}</Text>
      : <Text selectable style={[styles.body, { color: colors.text }]}>{content}</Text>}
  </View>;
}, (previous, next) => previous.block === next.block && previous.streaming === next.streaming && previous.spacing === next.spacing
  && previous.citations.length === next.citations.length && previous.citations.every((citation, index) => {
    const other = next.citations[index];
    return citation.id === other.id && citation.startIndex === other.startIndex && citation.endIndex === other.endIndex
      && citation.url === other.url && citation.title === other.title && citation.number === other.number;
  }));

/** Closed blocks retain their native views while only the live suffix is parsed. */
export const MessageContent = memo(function MessageContent({ text, streaming = false, citations = noCitations }: {
  text: string; streaming?: boolean; citations?: readonly InlineCitation[];
}) {
  const [parse] = useState(() => createMarkdownParser(true));
  const blocks = useMemo(() => parse(text, streaming), [parse, text, streaming]);
  return <View style={styles.content}>
    {blocks.map((block, index) => <ContentBlock key={block.key} block={block}
      citations={citations}
      streaming={streaming && index === blocks.length - 1}
      spacing={index === 0 ? 0 : block.kind === 'list-item' && blocks[index - 1].kind === 'list-item' ? 7 : 12} />)}
  </View>;
});

const styles = StyleSheet.create({
  content: { minHeight: 25 },
  body: { fontSize: 16, lineHeight: 25 },
  bold: { fontWeight: '600' },
  emphasis: { fontStyle: 'italic' },
  inlineCode: { fontFamily: monospace, fontSize: 14 },
  heading: { fontWeight: '600', lineHeight: 28, marginTop: 4 },
  listRow: { flexDirection: 'row', gap: 9 },
  listMarker: { minWidth: 20, fontSize: 16, lineHeight: 25 },
  listText: { flex: 1 },
  codeBlock: { borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  codeHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 13, paddingRight: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  codeLanguage: { flex: 1, fontSize: 12, fontWeight: '500' },
  copyCode: { minHeight: 40, minWidth: 80, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 5 },
  copyLabel: { fontSize: 12 },
  codeScroll: { padding: 13, minHeight: 47 },
  code: { fontFamily: monospace, fontSize: 13, lineHeight: 21 },
});
