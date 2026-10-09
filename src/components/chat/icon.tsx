import { SymbolView } from 'expo-symbols';

const symbols = {
  compose: { ios: 'square.and.pencil', android: 'edit_square' },
  person: { ios: 'person.crop.circle', android: 'account_circle' },
  plus: { ios: 'plus', android: 'add' },
  close: { ios: 'xmark', android: 'close' },
  search: { ios: 'magnifyingglass', android: 'search' },
  chevron: { ios: 'chevron.right', android: 'chevron_right' },
  down: { ios: 'chevron.down', android: 'expand_more' },
  send: { ios: 'arrow.up', android: 'arrow_upward' },
  stop: { ios: 'stop.fill', android: 'stop' },
  copy: { ios: 'doc.on.doc', android: 'content_copy' },
  check: { ios: 'checkmark', android: 'check' },
  more: { ios: 'ellipsis', android: 'more_horiz' },
  archive: { ios: 'archivebox', android: 'archive' },
  pencil: { ios: 'pencil', android: 'edit' },
  message: { ios: 'bubble.left', android: 'chat_bubble_outline' },
  spark: { ios: 'sparkles', android: 'auto_awesome' },
  tool: { ios: 'wrench.and.screwdriver', android: 'build' },
  retry: { ios: 'arrow.clockwise', android: 'refresh' },
  warning: { ios: 'exclamationmark.circle', android: 'error_outline' },
  lock: { ios: 'lock', android: 'lock' },
  phone: { ios: 'iphone', android: 'smartphone' },
  arrowDown: { ios: 'arrow.down', android: 'arrow_downward' },
  idea: { ios: 'lightbulb', android: 'lightbulb' },
  number: { ios: 'number', android: 'calculate' },
} as const;

export type ChatIconName = keyof typeof symbols;

export function ChatIcon({ name, color, size = 21 }: { name: ChatIconName; color: string; size?: number }) {
  return <SymbolView name={symbols[name]} tintColor={color} size={size} style={{ width: size, height: size }} />;
}
