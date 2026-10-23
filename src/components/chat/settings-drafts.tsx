import type { ConversationId } from '@earendil-works/pi-durable';
import { useNativeState } from '@expo/ui/swift-ui';
import { createContext, use, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';

import type { ChatView, ChatViewSource } from '@/pi/chat-view';
import type { ChatExecutionSettings } from '@/pi/execution/document';
import type { InfiniChatSettings } from '@/pi/infinichat-service';
import type { InfiniChatControls } from '@/pi/infinichat-view';
import type { ChatModelSettings } from '@/pi/model-catalog';

type ChatSettings = { settings: ChatModelSettings; execution: ChatExecutionSettings };
/** @expo/ui exports `useNativeState` but not the type of the state it returns. */
type NativeText = ReturnType<typeof useNativeState<string>>;

type ChatSettingsDraft = ChatSettings & {
  id: ConversationId;
  view: ChatView | undefined;
  /** The saved settings the draft is compared with. */
  initial: ChatSettings;
  setSettings: (settings: ChatModelSettings) => void;
  setExecution: (execution: ChatExecutionSettings) => void;
  /** The working directory field's text, which the folder browser also sets when a folder is chosen. */
  cwdText: NativeText;
};

const ChatSettingsDraftContext = createContext<ChatSettingsDraft | undefined>(undefined);

/**
 * One chat settings session's unsaved choices, shared by the sheet's screens. Incoming chat snapshots do not
 * overwrite them before the user saves or cancels.
 */
export function ChatSettingsDraftProvider({ id, view, initial, children }: {
  id: ConversationId; view: ChatView | undefined; initial: ChatSettings; children: ReactNode;
}) {
  const [settings, setSettings] = useState(initial.settings);
  const [execution, setExecution] = useState(initial.execution);
  const cwdText = useNativeState(initial.execution.cwd ?? '');
  return <ChatSettingsDraftContext value={{ id, view, initial, settings, setSettings, execution, setExecution,
    cwdText }}>
    {children}
  </ChatSettingsDraftContext>;
}

export function useChatSettingsDraft(): ChatSettingsDraft {
  const draft = use(ChatSettingsDraftContext);
  if (!draft) throw new Error('Chat settings screens render inside the chat settings layout.');
  return draft;
}

/** The main model answers and works; the summary model writes the memory's summaries in the background. */
export type InfiniChatRole = 'main' | 'summary';
/** The settings the conversation keeps, and the avatar, which stays on this phone. */
export type InfiniChatSettingsDraftValues = InfiniChatSettings & { avatar: string | undefined };

type InfiniChatSettingsDraft = {
  view: ChatViewSource<InfiniChatControls> | undefined;
  initial: InfiniChatSettingsDraftValues;
  draft: InfiniChatSettingsDraftValues;
  setDraft: Dispatch<SetStateAction<InfiniChatSettingsDraftValues>>;
};

const InfiniChatSettingsDraftContext = createContext<InfiniChatSettingsDraft | undefined>(undefined);

/** InfiniChat's unsaved settings, shared by its settings sheet's screens until the user saves or cancels. */
export function InfiniChatSettingsDraftProvider({ view, initial, children }: {
  view: ChatViewSource<InfiniChatControls> | undefined; initial: InfiniChatSettingsDraftValues; children: ReactNode;
}) {
  const [draft, setDraft] = useState(initial);
  return <InfiniChatSettingsDraftContext value={{ view, initial, draft, setDraft }}>
    {children}
  </InfiniChatSettingsDraftContext>;
}

export function useInfiniChatSettingsDraft(): InfiniChatSettingsDraft {
  const draft = use(InfiniChatSettingsDraftContext);
  if (!draft) throw new Error('InfiniChat settings screens render inside the InfiniChat settings layout.');
  return draft;
}
