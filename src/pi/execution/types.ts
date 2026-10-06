import type { Context } from '@earendil-works/chord';
import type { PromptInput } from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';

export type ArtifactKind = 'edit-patch' | 'bash-stdout' | 'bash-stderr';

/** Optional, application-owned persistence; returned paths must survive invocation cleanup. */
export interface ArtifactWriter {
  write(kind: ArtifactKind, content: string, context: Context): Promise<string>;
}

export interface ToolScope {
  readonly env: ExecutionEnv;
  readonly context: Context;
  /** Idempotent; seals and drains request-owned resources, not the shared backend. */
  release(): Promise<void>;
}

/** Composition supplies ownership and facts for the environment already selected by Pi. */
export interface SharedToolPolicy {
  scope(env: ExecutionEnv, context: Context): Promise<ToolScope>;
  artifacts?(env: ExecutionEnv): ArtifactWriter | undefined;
  promptFacts(input: PromptInput, context: Context): readonly string[] | Promise<readonly string[]>;
}
