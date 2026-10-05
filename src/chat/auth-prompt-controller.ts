import type { AuthPrompt } from '@earendil-works/pi-ai';

export interface PendingAuthPrompt { id: number; prompt: AuthPrompt }

/** Bridges Pi's awaited prompts to React without retaining entered credentials. */
export class AuthPromptController {
  private nextId = 0;
  private snapshot: PendingAuthPrompt | null = null;
  private pending?: { id: number; resolve(value: string): void; reject(reason: unknown): void };
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getSnapshot = () => this.snapshot;
  private publish(snapshot: PendingAuthPrompt | null) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  prompt(prompt: AuthPrompt, flowSignal: AbortSignal): Promise<string> {
    flowSignal.throwIfAborted();
    prompt.signal?.throwIfAborted();
    if (this.pending) return Promise.reject(new Error('Another sign-in prompt is already open.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const signals = new Set([flowSignal, ...(prompt.signal ? [prompt.signal] : [])]);
      const finish = (action: () => void) => {
        if (this.pending?.id !== id) return;
        for (const signal of signals) signal.removeEventListener('abort', abort);
        this.pending = undefined;
        this.publish(null);
        action();
      };
      const abort = () => finish(() => reject([...signals].find((signal) => signal.aborted)?.reason));
      this.pending = { id, resolve: (value) => finish(() => resolve(value)), reject: (reason) => finish(() => reject(reason)) };
      for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
      this.publish({ id, prompt });
    });
  }

  readonly submit = (id: number, value: string) => {
    if (this.pending?.id !== id || !value.trim()) return false;
    if (this.snapshot?.prompt.type === 'select' && !this.snapshot.prompt.options.some((option) => option.id === value)) return false;
    this.pending.resolve(value);
    return true;
  };
  readonly cancel = () => {
    const error = new Error('Sign-in cancelled.');
    error.name = 'AbortError';
    this.pending?.reject(error);
  };
}
