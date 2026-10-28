import type { WebSearchCall } from '@pi-agent/infinichat/chat/web-search-types';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useChatColors } from '@/hooks/use-chat-colors';
import { ChatIcon } from './icon';
import { openExternalLink } from './source-link';
import { safeSourceUrl, searchCallLabel, sourceHost, type SearchSource } from '@pi-agent/infinichat/chat/web-search-presentation';

function SearchCall({ call }: { call: WebSearchCall }) {
  const colors = useChatColors();
  const running = call.status === 'running';
  const failed = call.status === 'failed';
  const interrupted = call.status === 'interrupted';
  const url = call.url && safeSourceUrl(call.url);
  return <View testID={`web-search-call-${call.id}`} style={styles.call}>
    <View style={styles.callIcon}>{running ? <ActivityIndicator size="small" color={colors.accent} />
      : <ChatIcon name={failed ? 'warning' : interrupted ? 'stop' : 'check'} size={14} color={failed ? colors.danger : colors.secondary} />}</View>
    <View style={styles.callContent}>
      <Text style={[styles.callLabel, { color: failed ? colors.danger : colors.secondary }]}>{searchCallLabel(call)}</Text>
      {call.queries?.map((query, index) => <Text key={`${index}:${query}`} selectable style={[styles.query, { color: colors.text }]}>{query}</Text>)}
      {call.pattern ? <Text selectable style={[styles.query, { color: colors.text }]}>“{call.pattern}”</Text> : null}
      {url ? <Pressable accessibilityRole="link" accessibilityLabel={`Open searched page, ${sourceHost(url)}`}
        accessibilityHint="Opens in your browser" onPress={() => { void openExternalLink(url); }} style={styles.pageLink}>
        <Text numberOfLines={2} style={[styles.pageLinkText, { color: colors.accent }]}>{sourceHost(url)}</Text>
        <ChatIcon name="chevron" size={10} color={colors.accent} />
      </Pressable> : null}
      {running && !call.queries?.length && !call.pattern && !url
        ? <Text style={[styles.pending, { color: colors.muted }]}>Preparing search…</Text> : null}
      {call.error ? <Text selectable style={[styles.pending, { color: colors.danger }]}>{call.error}</Text> : null}
    </View>
  </View>;
}

/** Search activity lives with its assistant response, so no synthetic local tool runs are shown. */
export function WebSearchActivity({ calls, messageId }: {
  calls: readonly WebSearchCall[]; messageId: string;
}) {
  const colors = useChatColors();
  const [expanded, setExpanded] = useState<boolean | undefined>(undefined);
  const active = calls.filter((call) => call.status === 'running').at(-1);
  const failed = calls.some((call) => call.status === 'failed');
  const interrupted = calls.some((call) => call.status === 'interrupted');
  const open = expanded ?? !!active;
  if (!calls.length) return null;
  const label = active ? searchCallLabel(active) : failed ? 'Web search failed' : interrupted ? 'Search interrupted' : 'Searched the web';
  const detail = active?.queries?.at(-1) ?? (active?.url ? sourceHost(active.url) : undefined);
  return <View style={[styles.activity, { borderColor: colors.border, backgroundColor: colors.subtle }]}>
    <Pressable testID={`web-search-${messageId}`} accessibilityRole="button"
      accessibilityLabel={`${label}. ${open ? 'Hide' : 'Show'} search activity`}
      accessibilityState={{ expanded: open, busy: !!active }} onPress={() => setExpanded(!open)} style={styles.header}>
      {active ? <ActivityIndicator size="small" color={colors.accent} />
        : <ChatIcon name={failed ? 'warning' : interrupted ? 'stop' : 'search'} size={17} color={failed ? colors.danger : colors.accent} />}
      <View style={styles.headerCopy}>
        <Text accessibilityLiveRegion="polite" style={[styles.headerLabel, { color: failed && !active ? colors.danger : colors.secondary }]}>{label}</Text>
        {!open && detail ? <Text numberOfLines={1} style={[styles.pending, { color: colors.muted }]}>{detail}</Text> : null}
      </View>
      {calls.length > 1 ? <Text style={[styles.count, { color: colors.muted }]}>{calls.length}</Text> : null}
      <ChatIcon name={open ? 'down' : 'chevron'} size={11} color={colors.muted} />
    </Pressable>
    {open ? <View style={[styles.calls, { borderTopColor: colors.border }]}>{calls.map((call) => <SearchCall key={call.id} call={call} />)}</View> : null}
  </View>;
}

export function WebSearchSources({ sources, messageId }: {
  sources: readonly SearchSource[]; messageId: string;
}) {
  const colors = useChatColors();
  const [expanded, setExpanded] = useState(false);
  if (!sources.length) return null;
  const hosts = [...new Set(sources.map((source) => source.host))].slice(0, 3).join(' · ');
  return <View style={[styles.sources, { borderColor: colors.border }]}>
    <Pressable testID={`web-sources-${messageId}`} accessibilityRole="button" accessibilityState={{ expanded }}
      accessibilityLabel={`${sources.length} web sources. ${expanded ? 'Hide' : 'Show'} sources`}
      onPress={() => setExpanded(!expanded)} style={styles.header}>
      <ChatIcon name="search" color={colors.accent} size={16} />
      <View style={styles.headerCopy}>
        <Text style={[styles.headerLabel, { color: colors.secondary }]}>Sources · {sources.length}</Text>
        {!expanded ? <Text numberOfLines={1} style={[styles.pending, { color: colors.muted }]}>{hosts}</Text> : null}
      </View>
      <ChatIcon name={expanded ? 'down' : 'chevron'} color={colors.muted} size={11} />
    </Pressable>
    {expanded ? <View style={[styles.sourceList, { borderTopColor: colors.border }]}>{sources.map((source) => <Pressable key={source.url}
      testID={`web-source-${messageId}-${source.number}`} accessibilityRole="link"
      accessibilityLabel={`${source.cited ? 'Citation' : 'Source'} ${source.number}. ${source.title}. ${source.host}`}
      accessibilityHint="Opens in your browser" onPress={() => { void openExternalLink(source.url); }}
      style={({ pressed }) => [styles.sourceRow, { backgroundColor: pressed ? colors.subtle : 'transparent' }]}>
      <View style={[styles.sourceNumber, { backgroundColor: colors.accentSoft }]}><Text style={[styles.numberText, { color: colors.accent }]}>{source.number}</Text></View>
      <View style={styles.headerCopy}>
        <Text numberOfLines={3} style={[styles.sourceTitle, { color: colors.text }]}>{source.title}</Text>
        <Text numberOfLines={1} style={[styles.pending, { color: colors.secondary }]}>{source.host}{source.cited ? ' · Cited' : ''}</Text>
      </View>
      <ChatIcon name="chevron" size={10} color={colors.muted} />
    </Pressable>)}</View> : null}
  </View>;
}

const styles = StyleSheet.create({
  activity: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, overflow: 'hidden' },
  sources: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, overflow: 'hidden' },
  header: { minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, gap: 10 },
  headerCopy: { flex: 1, gap: 4 },
  headerLabel: { fontSize: 13, fontWeight: '600', lineHeight: 19 },
  count: { fontSize: 11 },
  calls: { borderTopWidth: StyleSheet.hairlineWidth, padding: 12, gap: 16 },
  call: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  callIcon: { width: 20, minHeight: 21, alignItems: 'center', justifyContent: 'center' },
  callContent: { flex: 1, gap: 4 },
  callLabel: { fontSize: 12, lineHeight: 19 },
  query: { fontSize: 14, lineHeight: 21 },
  pending: { fontSize: 12, lineHeight: 17 },
  pageLink: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 7, alignSelf: 'flex-start', maxWidth: '100%' },
  pageLinkText: { fontSize: 13, lineHeight: 19, flexShrink: 1, textDecorationLine: 'underline' },
  sourceList: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 4 },
  sourceRow: { minHeight: 60, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, gap: 10 },
  sourceNumber: { width: 25, height: 25, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  numberText: { fontSize: 12, fontWeight: '600' },
  sourceTitle: { fontSize: 13, lineHeight: 20, fontWeight: '500' },
});
