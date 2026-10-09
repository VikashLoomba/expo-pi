import { requireOptionalNativeModule, type NativeModule } from 'expo';

/** A session owns one listener; a stale session ID cannot stop a later login. */
export interface NativeOAuthCallbackModule extends NativeModule {
  /** Resolves only after 127.0.0.1:1455 is ready to accept the matching callback. */
  start(state: string): Promise<string>;
  /** Retains a completed callback until this waiter receives it. */
  waitForCallback(sessionId: string): Promise<string>;
  stop(sessionId: string): Promise<void>;
}

// Older development builds keep Pi's manual-return fallback.
export default requireOptionalNativeModule<NativeOAuthCallbackModule>('PiOAuthCallback');
