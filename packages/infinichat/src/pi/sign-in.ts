import type { AuthPrompt, LoginOptions, Models, ProviderAuthInteraction } from '@earendil-works/pi-ai';
import { AuthPromptController } from '../chat/auth-prompt-controller';
import type { SignInAttempt } from './infinichat-remote/contract';
import type { ShownAttempt, ShownAuthPrompt } from './infinichat-remote/sign-in-attempt';
import { OPENAI_PROVIDER_ID } from './openai-auth/core';
import type { ProviderCredentialStore } from './provider-credentials';

/** A prompt as a contract carries it: its signal stays here, and an absent field is left out, as Chord requires. */
function shown(prompt: AuthPrompt): ShownAuthPrompt {
  if (prompt.type === 'select') {
    return { type: prompt.type, message: prompt.message, options: prompt.options.map(({ id, label, description }) =>
      ({ id, label, ...(description === undefined ? {} : { description }) })) };
  }
  return { type: prompt.type, message: prompt.message,
    ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }) };
}

/** What the screen says of an attempt for `subject` that failed with `error`, given whether it showed its URL. */
export type FailureCopy<S> = (error: unknown, subject: S, shownUrl: boolean) => string | undefined;

/**
 * Sign-ins run one at a time and kept as state, so whoever shows one finds the pending prompt again: a machine's
 * clients after they reconnect mid-attempt, and an app's own account screen. A sign-in is any flow over pi-ai's
 * `AuthInteraction`, which the screens answer: a provider's `models.login`, or an MCP server's OAuth (the tools
 * plugin's `mcp-oauth.ts`). `subject` names what an attempt signs in to, as its contract's field. An attempt ends when
 * it succeeds or fails, when it is cancelled, when another starts, or when its owner closes; a dropped link alone does
 * not end it.
 */
export class SignInAttempts<S extends object> {
  private readonly listeners = new Set<() => void>();
  private readonly prompts = new AuthPromptController();
  private attempts = 0;
  private running?: AbortController;
  /** The latest attempt without its prompt, which the controller holds; none before the first. */
  private latest?: S & Omit<ShownAttempt, 'prompt'>;
  private snapshot: (S & ShownAttempt) | null = null;

  /** `failure` is the copy for a failed attempt; without it, or when it has none, a generic line. */
  constructor(private readonly failure?: FailureCopy<S>) {
    this.prompts.subscribe(() => this.publish());
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getSnapshot = () => this.snapshot;

  /** Whether an attempt is under way. */
  get busy(): boolean {
    return this.running !== undefined;
  }

  /** Starts `run` as an attempt for `subject`, ending one under way, and returns its number. */
  start(subject: S, run: (interaction: ProviderAuthInteraction) => Promise<unknown>): number {
    this.running?.abort();
    const controller = new AbortController();
    this.running = controller;
    const attempt = ++this.attempts;
    this.latest = { ...subject, attempt, running: true, status: 'Starting sign-in…' };
    this.publish();
    void this.run(attempt, subject, run, controller);
    return attempt;
  }

  /** Answers the pending prompt `promptId`; an answer to another prompt, or an empty one, changes nothing. */
  answer(promptId: number, value: string): void {
    this.prompts.submit(promptId, value);
  }

  /** Ends the attempt under way, as a client's Cancel and the owner's close do. */
  cancel(): void {
    this.running?.abort();
  }

  private async run(attempt: number, subject: S, run: (interaction: ProviderAuthInteraction) => Promise<unknown>,
    controller: AbortController): Promise<void> {
    const { signal } = controller;
    const current = () => this.running === controller;
    const show = (change: Partial<Omit<ShownAttempt, 'prompt' | 'attempt'>>) => {
      if (!current() || this.latest === undefined) return;
      this.latest = { ...this.latest, ...change };
      this.publish();
    };
    try {
      await run({
        signal,
        prompt: (prompt) => {
          show({ status: prompt.type === 'manual_code'
            ? 'Finish sign-in with the browser return URL.' : 'Complete the next sign-in step.' });
          return this.prompts.prompt(prompt, signal);
        },
        notify(event) {
          if (signal.aborted) return;
          // OAuth diagnostics can include callback URLs or tokens; the clients get the account screen's public copy.
          if (event.type === 'auth_url') show({ url: event.url, status: 'Continue in your browser to sign in.' });
          else if (event.type === 'progress' || event.type === 'info') show({ status: 'Sign-in in progress…' });
        },
      });
      // No status after a sign-in, as the account screen clears its notice; the access state says it.
      if (current()) this.latest = { ...subject, attempt, running: false };
    } catch (error) {
      if (current()) {
        const copy = signal.aborted ? undefined : this.failure?.(error, subject, this.latest?.url !== undefined);
        this.latest = { ...subject, attempt, running: false, status: signal.aborted ? 'Sign-in cancelled.'
          : copy ?? 'Sign-in could not be completed. Please try again.' };
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

/**
 * Sign-in to a credential store's providers, as a `SignInAttempts` over pi-ai's `models.login`: a machine's own
 * store for its clients, the Mac app's account, and the iPhone's. API keys take the store's `modify` path.
 */
export class ProviderSignIn {
  private readonly attempts = new SignInAttempts<{ providerId: string }>((error, { providerId }, shownUrl) =>
    // Before its URL, ChatGPT's flow has talked to no server (openai-chatgpt.ts:237-269), so its message is pi-ai's own
    // setup copy, such as "Port 1455 is in use…" (:243-248), and says what to do. Later ones, and other providers'
    // device-code requests, can carry a server's reply.
    providerId === OPENAI_PROVIDER_ID && !shownUrl && error instanceof Error ? error.message : undefined);

  /**
   * `openAILogin` gives ChatGPT's sign-in this installation's ID (`node/credentials.ts`, the iPhone's
   * `openai-auth/installation.ts`). `signedIn` runs once a sign-in has stored its credential.
   */
  constructor(private readonly models: Models, private readonly credentials: ProviderCredentialStore,
    private readonly openAILogin: () => Promise<LoginOptions>, private readonly signedIn?: () => void) {}

  readonly subscribe = (listener: () => void) => this.attempts.subscribe(listener);
  readonly getSnapshot = (): SignInAttempt => this.attempts.getSnapshot();

  /** Starts an attempt, ending one under way, and returns its number. */
  signIn(providerId: string): number {
    const provider = this.models.getProvider(providerId);
    if (!provider?.auth.oauth) throw new Error(`${provider?.name ?? providerId} has no sign-in.`);
    return this.attempts.start({ providerId }, async (interaction) => {
      const options = providerId === OPENAI_PROVIDER_ID ? await this.openAILogin() : undefined;
      interaction.signal.throwIfAborted();
      await this.models.login(providerId, 'oauth', interaction, options);
      this.signedIn?.();
    });
  }

  answer(promptId: number, value: string): void {
    this.attempts.answer(promptId, value);
  }

  cancel(): void {
    this.attempts.cancel();
  }

  async setApiKey(providerId: string, input: string): Promise<void> {
    if (this.attempts.busy) throw new Error('Finish or cancel sign-in before changing provider credentials.');
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
}
