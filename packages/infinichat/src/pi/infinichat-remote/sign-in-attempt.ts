import { stringLiteral } from '@earendil-works/pi-ai/providers/schema-builders';
import {
  arr, bool, num, obj, oneOf, opt, str, union, type Static, type StaticObject,
} from '@earendil-works/pi-schema';

/** pi-ai's `AuthPrompt` without its signal, which stays on the server. */
export const AuthPromptSchema = union([
  obj({
    type: oneOf(['text', 'secret', 'manual_code']), message: str(),
    placeholder: opt(str()),
  }, { open: true }),
  obj({
    type: stringLiteral('select'), message: str(),
    options: arr(obj({
      id: str(), label: str(), description: opt(str()),
    }, { open: true })),
  }, { open: true }),
]);
export type ShownAuthPrompt = Static<typeof AuthPromptSchema>;

/**
 * What every sign-in a machine runs for its clients shows, whatever it signs in to (`node/sign-in.ts`): its number,
 * whether it runs, the copy for the screen, pi-ai's `auth_url` while it runs, and the prompt that waits for an answer
 * with its `id`. A contract adds the field that names what it signs in to.
 */
export const signInAttemptFields = {
  attempt: num(),
  running: bool(),
  status: opt(str()),
  url: opt(str()),
  prompt: opt(obj({ id: num(), prompt: AuthPromptSchema }, { open: true })),
};
export type ShownAttempt = StaticObject<typeof signInAttemptFields>;

/** A machine's latest sign-in as a client follows it: null before its first, undefined until connected. */
export interface AttemptSource<A extends ShownAttempt> {
  subscribe(listener: () => void): () => void;
  getAttempt(): A | null | undefined;
}

/**
 * Resolves with what `read` finds in sign-in attempt `attempt` while it runs. Its number can arrive before the state
 * that shows it, so an earlier attempt or none means not yet; it rejects once the attempt has ended, once a later one
 * shows, once it is gone after it showed (a restarted server), or with `signal`'s reason.
 */
export function attemptStep<A extends ShownAttempt, T>(source: AttemptSource<A>, attempt: number,
  read: (shown: A) => T | undefined, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let seen = false;
    const settle = (finish: () => void) => {
      stop();
      signal.removeEventListener('abort', abort);
      finish();
    };
    const check = () => {
      const shown = source.getAttempt() ?? null;
      if (shown?.attempt === attempt && shown.running) {
        seen = true;
        const value = read(shown);
        if (value !== undefined) settle(() => resolve(value));
      } else if (seen || (shown !== null && shown.attempt >= attempt)) {
        settle(() => reject(new Error('Sign-in ended.')));
      }
    };
    const abort = () => settle(() => reject(signal.reason));
    const stop = source.subscribe(check);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else check();
  });
}

/** Where a sign-in's browser returns, and the `state` it returns with, when that is a loopback address. */
export interface LoopbackRedirect {
  /** `http://127.0.0.1:<port><path>` or `http://localhost:<port><path>`, as the authorization URL names it. */
  readonly url: URL;
  readonly port: number;
  readonly state: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

/**
 * The loopback redirect of an authorization URL, as RFC 8252 §7.3 has native apps receive one: an `http` URI on the
 * loopback address with an explicit port. A machine's sign-in names its own loopback, which the browser can't reach
 * from a client, so a client listens on the same port and path and hands the callback to the machine's `manual_code`
 * prompt. Undefined for any other redirect, or one without state: then the browser's return URL is pasted.
 */
export function loopbackRedirect(authorizationUrl: string): LoopbackRedirect | undefined {
  let url: URL;
  let redirect: URL;
  try {
    url = new URL(authorizationUrl);
    redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
  } catch {
    return undefined;
  }
  const state = url.searchParams.get('state');
  const port = Number(redirect.port);
  if (redirect.protocol !== 'http:' || !LOOPBACK_HOSTS.has(redirect.hostname) || !Number.isInteger(port) || port < 1
    || redirect.username || redirect.password || redirect.search || redirect.hash || !state) return undefined;
  return { url: redirect, port, state };
}

/**
 * Whether `callback` is the browser's return to `redirect`: the same origin and path, one matching `state`, and either
 * one nonempty `code` or one `error`, which the machine's flow reports. The machine checks the rest (the issuer, the
 * code itself), so a client never exchanges anything.
 */
export function isLoopbackCallback(callback: string, redirect: LoopbackRedirect): boolean {
  let url: URL;
  try {
    url = new URL(callback);
  } catch {
    return false;
  }
  const one = (name: string) => {
    const values = url.searchParams.getAll(name);
    return values.length === 1 ? values[0] : undefined;
  };
  const code = one('code');
  const error = one('error');
  return url.origin === redirect.url.origin && url.pathname === redirect.url.pathname && !url.hash
    && one('state') === redirect.state && (code ? error === undefined : !!error && url.searchParams.getAll('code')
      .length === 0);
}
