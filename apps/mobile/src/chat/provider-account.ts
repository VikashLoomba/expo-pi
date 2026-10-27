import type { PendingAuthPrompt } from '@pi-agent/infinichat/chat/auth-prompt-controller';
import type { ProviderAccess } from '@pi-agent/infinichat/pi/provider-credentials';

/**
 * A credential store's sign-ins and their operations, as the providers screens show them: this iPhone's account
 * (`useChatApp`), or the machine's that InfiniChat runs on (`useInfiniChatAccount`).
 */
export interface ProviderAccount {
  providerAccess(providerId: string): ProviderAccess;
  providerOAuth(providerId: string): { name: string; loginLabel?: string; isSubscription?: boolean } | undefined;
  saveProviderKey(providerId: string, key: string): Promise<void>;
  disconnectProvider(providerId: string): Promise<void>;
  /** Reads a saved credential again after a storage error; absent where there is nothing to read again from. */
  retryAuth?(providerId: string): Promise<void>;
  signOutPending: boolean;
  disconnectingProvider?: string;
  signingIn: boolean;
  signingInProvider: string | null;
  signIn(providerId: string): Promise<void>;
  cancelSignIn(): void;
  authNotice?: { providerId: string; message: string };
  authPrompt: PendingAuthPrompt | null;
  submitAuthPrompt(id: number, value: string): boolean;
  openSignInPage(): Promise<void>;
  browserOpen: boolean;
}
