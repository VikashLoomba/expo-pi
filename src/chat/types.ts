import type { FileToolPresentation } from './file-tool-presentation';
import type { ChatModelSettings } from '../pi/model-catalog';
import type { WebSearchPresentation } from './web-search-types';

export interface ChatSummary {
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'notice';
  text: string;
  createdAt: number;
  streaming?: boolean;
  interrupted?: boolean;
  thinking?: string;
  webSearch?: WebSearchPresentation;
  tool?: { name: string; args: string; status: 'running' | 'completed' | 'error'; output: string; file?: FileToolPresentation };
  error?: string;
}

export interface ChatConversation {
  id: string;
  title: string;
  settings: ChatModelSettings;
  messages: ChatMessage[];
  busy: boolean;
  pending: boolean;
  error?: string;
}
