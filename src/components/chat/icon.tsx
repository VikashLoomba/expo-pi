import { SymbolView } from 'expo-symbols';

const symbols = {
  compose: 'square.and.pencil',
  person: 'person.crop.circle',
  plus: 'plus',
  close: 'xmark',
  search: 'magnifyingglass',
  chevron: 'chevron.right',
  down: 'chevron.down',
  send: 'arrow.up',
  stop: 'stop.fill',
  copy: 'doc.on.doc',
  check: 'checkmark',
  pencil: 'pencil',
  message: 'bubble.left',
  spark: 'sparkles',
  retry: 'arrow.clockwise',
  warning: 'exclamationmark.circle',
  lock: 'lock',
  phone: 'iphone',
  arrowDown: 'arrow.down',
  idea: 'lightbulb',
  number: 'number',
  folder: 'folder',
} as const;

export type ChatIconName = keyof typeof symbols;

export function ChatIcon({ name, color, size = 21 }: { name: ChatIconName; color: string; size?: number }) {
  return <SymbolView name={symbols[name]} tintColor={color} size={size} style={{ width: size, height: size }} />;
}
