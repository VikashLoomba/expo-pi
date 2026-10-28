import { createContext, use } from 'react';

/** The agent a chat screen shows answering, as the phone's `agent.tsx` keeps it. */
export type ChatAgent = {
  name: string;
  /** The avatar the user chose, as a URL the page can load; InfiniChat's mark until then. */
  avatar: string | undefined;
};

export const ChatAgentContext = createContext<ChatAgent | undefined>(undefined);

export function useChatAgentName(): string {
  return use(ChatAgentContext)?.name ?? 'Pi';
}

/** The answering agent's mark: its avatar, or the infinity InfiniChat's tab shows. */
export function AgentMark({ size }: { size: number }) {
  const agent = use(ChatAgentContext);
  const style = { width: size, height: size, borderRadius: size * 0.31, fontSize: size * 0.6 };
  return (
    <div className="agent-mark" role="img" aria-label={agent?.name ?? 'Pi'} style={style}>
      {agent?.avatar ? <img src={agent.avatar} alt="" /> : '∞'}
    </div>
  );
}
