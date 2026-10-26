import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useChatColors } from '@/hooks/use-chat-colors';
import { ChatIcon, type ChatIconName } from './icon';

export function PiMark({ size = 52 }: { size?: number }) {
  const colors = useChatColors();
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.31, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft }}>
      <Text accessibilityLabel="Pi" style={{ color: colors.accent, fontSize: size * 0.64, fontWeight: '500', lineHeight: size * 0.83 }}>π</Text>
    </View>
  );
}

export function ActionButton({ title, onPress, testID, disabled, loading, secondary, icon }: {
  title: string; onPress: () => void; testID?: string; disabled?: boolean; loading?: boolean; secondary?: boolean; icon?: ChatIconName;
}) {
  const colors = useChatColors();
  const foreground = secondary ? colors.accent : colors.onAccent;
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      onPress={onPress} disabled={disabled || loading}
      style={({ pressed }) => [styles.action, { backgroundColor: secondary ? colors.accentSoft : colors.accent, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 }]}>
      {loading ? <ActivityIndicator size="small" color={foreground} /> : icon ? <ChatIcon name={icon} color={foreground} size={18} /> : null}
      <Text style={[styles.actionLabel, { color: foreground }]}>{title}</Text>
    </Pressable>
  );
}

export function InlineNotice({ message, action, onAction, testID, tone = 'error' }: {
  message: string; action?: string; onAction?: () => void; testID?: string; tone?: 'error' | 'neutral';
}) {
  const colors = useChatColors();
  const color = tone === 'error' ? colors.danger : colors.secondary;
  return (
    <View testID={testID} accessibilityLiveRegion="polite" style={[styles.notice, { backgroundColor: tone === 'error' ? colors.dangerSoft : colors.subtle }]}>
      <ChatIcon name={tone === 'error' ? 'warning' : 'lock'} color={color} size={18} />
      <View style={styles.noticeContent}>
        <Text selectable style={[styles.noticeText, { color }]}>{message}</Text>
        {action && onAction ? <Pressable accessibilityRole="button" onPress={onAction} style={styles.noticeAction}>
          <Text style={[styles.noticeActionLabel, { color: tone === 'error' ? colors.danger : colors.accent }]}>{action}</Text>
        </Pressable> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  action: { minHeight: 52, borderRadius: 16, paddingHorizontal: 20, paddingVertical: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  actionLabel: { fontSize: 16, fontWeight: '600' },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderRadius: 14, padding: 14 },
  noticeContent: { flex: 1 },
  noticeText: { fontSize: 14, lineHeight: 20 },
  noticeAction: { paddingTop: 8, paddingBottom: 3, alignSelf: 'flex-start' },
  noticeActionLabel: { fontSize: 14, fontWeight: '600' },
});
