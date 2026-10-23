import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { createContext, use } from 'react';
import { View } from 'react-native';

import { useChatColors } from '@/hooks/use-chat-colors';
import { PiMark } from './primitives';

/** The agent a chat screen shows answering. InfiniChat provides its own; ordinary chats are Pi's. */
export type ChatAgent = {
  name: string;
  /** The avatar the user made; InfiniChat's infinity, as its tab shows it, until then. */
  avatar: string | undefined;
};

export const ChatAgentContext = createContext<ChatAgent | undefined>(undefined);

export function useChatAgentName(): string {
  return use(ChatAgentContext)?.name ?? 'Pi';
}

/** The answering agent's mark, in Pi's shape. */
export function AgentMark({ size }: { size: number }) {
  const colors = useChatColors();
  const agent = use(ChatAgentContext);
  if (!agent) return <PiMark size={size} />;
  const frame = { width: size, height: size, borderRadius: size * 0.31 };
  if (agent.avatar) {
    return <Image source={agent.avatar} accessible accessibilityRole="image" accessibilityLabel={agent.name}
      contentFit="cover" style={frame} />;
  }
  const symbol = size * 0.6;
  return <View accessible accessibilityRole="image" accessibilityLabel={agent.name}
    style={[frame, { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft }]}>
    <SymbolView name="infinity" tintColor={colors.accent} size={symbol} style={{ width: symbol, height: symbol }} />
  </View>;
}
