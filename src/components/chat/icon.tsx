import { SymbolView } from 'expo-symbols';

const symbols = {
  compose: { ios: 'square.and.pencil', android: 'edit_square', web: 'edit_square' },
  person: { ios: 'person.crop.circle', android: 'account_circle', web: 'account_circle' },
  plus: { ios: 'plus', android: 'add', web: 'add' },
  close: { ios: 'xmark', android: 'close', web: 'close' },
  search: { ios: 'magnifyingglass', android: 'search', web: 'search' },
  chevron: { ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' },
  down: { ios: 'chevron.down', android: 'expand_more', web: 'expand_more' },
  send: { ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' },
  stop: { ios: 'stop.fill', android: 'stop', web: 'stop' },
  copy: { ios: 'doc.on.doc', android: 'content_copy', web: 'content_copy' },
  check: { ios: 'checkmark', android: 'check', web: 'check' },
  more: { ios: 'ellipsis', android: 'more_horiz', web: 'more_horiz' },
  archive: { ios: 'archivebox', android: 'archive', web: 'archive' },
  pencil: { ios: 'pencil', android: 'edit', web: 'edit' },
  message: { ios: 'bubble.left', android: 'chat_bubble_outline', web: 'chat_bubble_outline' },
  spark: { ios: 'sparkles', android: 'auto_awesome', web: 'auto_awesome' },
  tool: { ios: 'wrench.and.screwdriver', android: 'build', web: 'build' },
  retry: { ios: 'arrow.clockwise', android: 'refresh', web: 'refresh' },
  warning: { ios: 'exclamationmark.circle', android: 'error_outline', web: 'error_outline' },
  lock: { ios: 'lock', android: 'lock', web: 'lock' },
  phone: { ios: 'iphone', android: 'smartphone', web: 'smartphone' },
  arrowDown: { ios: 'arrow.down', android: 'arrow_downward', web: 'arrow_downward' },
  idea: { ios: 'lightbulb', android: 'lightbulb', web: 'lightbulb' },
  number: { ios: 'number', android: 'calculate', web: 'calculate' },
} as const;

export type ChatIconName = keyof typeof symbols;

export function ChatIcon({ name, color, size = 21 }: { name: ChatIconName; color: string; size?: number }) {
  return <SymbolView name={symbols[name]} tintColor={color} size={size} style={{ width: size, height: size }} />;
}
