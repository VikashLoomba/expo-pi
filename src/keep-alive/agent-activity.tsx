import { HStack, Image, Text, VStack } from '@expo/ui/swift-ui';
import { font, foregroundStyle, padding } from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity, type LiveActivityEnvironment } from 'expo-widgets';

export type AgentActivityProps = {
  activeChats: number;
  status: string;
};

const ACCENT = '#208AEF';

/**
 * Progress of the app's agent work on the Lock Screen and in the Dynamic Island. Registered entirely at runtime
 * by the library's built-in Live Activity target, so it takes no `widgets[]` entry in the app config.
 */
const AgentActivity = (props: AgentActivityProps, environment: LiveActivityEnvironment) => {
  'widget';
  const accent = environment.isLuminanceReduced ? '#FFFFFF' : ACCENT;
  const chats = props.activeChats === 1 ? '1 chat' : `${props.activeChats} chats`;
  return {
    banner: (
      <HStack modifiers={[padding({ all: 14 })]}>
        <Image systemName="sparkles" color={accent} />
        <VStack>
          <Text modifiers={[font({ weight: 'bold' }), foregroundStyle(accent)]}>{props.status}</Text>
          <Text>{chats} working in the background</Text>
        </VStack>
      </HStack>
    ),
    compactLeading: <Image systemName="sparkles" color={accent} />,
    compactTrailing: <Text>{props.activeChats}</Text>,
    minimal: <Image systemName="sparkles" color={accent} />,
  };
};

export default createLiveActivity('AgentActivity', AgentActivity);
