import { requireNativeModule, type NativeModule } from 'expo';

/** A session owns one listener; a stale session ID cannot stop a later login. */
export interface NativeOAuthCallbackModule extends NativeModule {
  /**
   * Resolves only after the IPv4 loopback is listening on `port`, ready to accept the callback to `path` with `state`;
   * `host` is how the redirect names the loopback (`127.0.0.1` or `localhost`), which the `Host` header must match.
   */
  start(host: string, port: number, path: string, state: string): Promise<string>;
  /** Retains a completed callback until this waiter receives it. */
  waitForCallback(sessionId: string): Promise<string>;
  stop(sessionId: string): Promise<void>;
}

export default requireNativeModule<NativeOAuthCallbackModule>('PiOAuthCallback');
