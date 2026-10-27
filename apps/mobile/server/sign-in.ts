import type { AuthPrompt, LoginOptions, Models } from '@earendil-works/pi-ai';
import { AuthPromptController } from '@pi-agent/infinichat/chat/auth-prompt-controller';
import type { SignInAttempt } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import { OPENAI_PROVIDER_ID } from '@pi-agent/infinichat/pi/openai-auth/core';
import type { ProviderCredentialStore } from '@pi-agent/infinichat/pi/provider-credentials';

type Attempt = Exclude<SignInAttempt, null>;

/** A prompt as the contract carries it: its signal stays here, and an absent field is left out, as Chord requires. */
function shown(prompt: AuthPrompt): NonNullable<Attempt['prompt']>['prompt'] {
  if (prompt.type === 'select') {
    return { type: prompt.type, message: prompt.message, options: prompt.options.map(({ id, label, description }) =>
      ({ id, label, ...(description === undefined ? {} : { description }) })) };
  }
  return { type: prompt.type, message: prompt.message,
    ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }) };
}

/**
 * Sign-in to this machine's providers, from the phone: the account screen's `useProviderSignIn` with its interaction
 * kept as state, so a phone that reconnects mid-attempt finds the pending prompt again. One attempt at a time. It ends
 * when it succeeds or fails, when it is cancelled, when another starts, or when the server closes; a dropped link alone
 * does not end it. API keys take the account screen's `modify` path.
 */
export class ServerSignIn {
  private readonly listeners = new Set<() => void>();
  private readonly prompts = new AuthPromptController();
  private attempts = 0;
  private running?: AbortController;
  /** The latest attempt without its prompt, which the controller holds; none before the first. */
  private latest?: Omit<Attempt, 'prompt'>;
  private snapshot: SignInAttempt = null;

  /** `openAILogin` gives ChatGPT's sign-in this machine's installation ID (`server/credentials.ts`). */
  constructor(private readonly models: Models, private readonly credentials: ProviderCredentialStore,
    private readonly openAILogin: () => Promise<LoginOptions>) {
    this.prompts.subscribe(() => this.publish());
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getSnapshot = () => this.snapshot;

  /** Starts an attempt, ending one under way, and returns its number. */
  signIn(providerId: string): number {
    const provider = this.models.getProvider(providerId);
    if (!provider?.auth.oauth) throw new Error(`${provider?.name ?? providerId} has no sign-in.`);
    this.running?.abort();
    const controller = new AbortController();
    this.running = controller;
    const attempt = ++this.attempts;
    this.latest = { attempt, providerId, running: true, status: 'Starting sign-in…' };
    this.publish();
    void this.run(attempt, providerId, controller);
    return attempt;
  }

  /** Answers the pending prompt `promptId`; an answer to another prompt, or an empty one, changes nothing. */
  answer(promptId: number, value: string): void {
    this.prompts.submit(promptId, value);
  }

  /** Ends the attempt under way, as the phone's Cancel and the server's close do. */
  cancel(): void {
    this.running?.abort();
  }

  async setApiKey(providerId: string, input: string): Promise<void> {
    if (this.running) throw new Error('Finish or cancel sign-in before changing provider credentials.');
    const key = input.trim();
    if (!key) throw new Error('Enter an API key.');
    if (!this.models.getProvider(providerId)?.auth.apiKey?.login) {
      throw new Error('This provider does not support API key sign-in.');
    }
    // Pi's store contract has one write path, the same `modify` that `models.login` ends in.
    await this.credentials.modify(providerId, async () => ({ type: 'api_key', key }));
  }

  async signOut(providerId: string): Promise<void> {
    this.cancel();
    try {
      await this.models.logout(providerId);
    } catch (error) {
      const name = this.models.getProvider(providerId)?.name ?? providerId;
      throw new Error(`Could not remove the saved ${name} key. Try again.`, { cause: error });
    }
  }

  private async run(attempt: number, providerId: string, controller: AbortController): Promise<void> {
    const { signal } = controller;
    const current = () => this.running === controller;
    const show = (change: Partial<Omit<Attempt, 'prompt'>>) => {
      if (!current() || this.latest === undefined) return;
      this.latest = { ...this.latest, ...change };
      this.publish();
    };
    try {
      const options = providerId === OPENAI_PROVIDER_ID ? await this.openAILogin() : undefined;
      signal.throwIfAborted();
      await this.models.login(providerId, 'oauth', {
        signal,
        prompt: (prompt) => {
          show({ status: prompt.type === 'manual_code'
            ? 'Finish sign-in with the browser return URL.' : 'Complete the next sign-in step.' });
          return this.prompts.prompt(prompt, signal);
        },
        notify(event) {
          if (signal.aborted) return;
          // OAuth diagnostics can include callback URLs or tokens; the phone gets the account screen's public copy.
          if (event.type === 'auth_url') show({ url: event.url, status: 'Continue in your browser to sign in.' });
          else if (event.type === 'progress' || event.type === 'info') show({ status: 'Sign-in in progress…' });
        },
      }, options);
      // No status after a sign-in, as the account screen clears its notice; the access state says it.
      if (current()) this.latest = { attempt, providerId, running: false };
    } catch (error) {
      if (current()) {
        // Before its URL, ChatGPT's flow has talked to no server (openai-chatgpt.ts:237-269), so its message is pi-ai's
        // own setup copy, such as "Port 1455 is in use…" (:243-248), and says what to do. Later ones, and other
        // providers' device-code requests, can carry a server's reply.
        const setup = providerId === OPENAI_PROVIDER_ID && this.latest?.url === undefined && error instanceof Error
          ? error.message : undefined;
        this.latest = { attempt, providerId, running: false, status: signal.aborted ? 'Sign-in cancelled.'
          : setup ?? 'Sign-in could not be completed. Please try again.' };
      }
    } finally {
      if (current()) {
        this.running = undefined;
        this.prompts.cancel();
        this.publish();
      }
    }
  }

  private publish() {
    const pending = this.prompts.getSnapshot();
    const prompt = pending === null ? undefined : { id: pending.id, prompt: shown(pending.prompt) };
    this.snapshot = this.latest === undefined ? null
      : { ...this.latest, ...(prompt === undefined || !this.latest.running ? {} : { prompt }) };
    for (const listener of [...this.listeners]) listener();
  }
}
