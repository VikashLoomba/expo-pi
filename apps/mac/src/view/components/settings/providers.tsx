import type { AccountRef } from '../../hooks/use-chats';
import { ProviderSections } from '../providers/provider-sections';
import { FieldDescription } from '../ui/field';

const PRIVACY = 'Your chats stay on this Mac, including when you sign out. Your sign-in and API keys are saved in '
  + 'the app’s data folder, readable only by your account, and restored when the app opens; signing out removes '
  + 'them. Your messages are processed by the provider selected for that chat. InfiniChat’s providers are signed in '
  + 'on the machine it runs on, from its own settings.';

/**
 * This Mac's own providers, the phone's account screen: the sign-ins and API keys its chats send with. A sign-in
 * under way is the app's, so leaving the pane or closing the window changes nothing.
 */
export function ProvidersPane({ account, focus }: { account: AccountRef; focus?: string }) {
  return (
    <div className="pane-scroll">
      <header className="pane-header">
        <h1 className="pane-title">Providers</h1>
      </header>
      <div className="flex flex-col gap-5">
        <ProviderSections account={account} focus={focus} />
        <FieldDescription>{PRIVACY}</FieldDescription>
      </div>
    </div>
  );
}
