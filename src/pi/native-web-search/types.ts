import type { JsonObject } from '@earendil-works/pi-durable';

export type { JsonObject } from '@earendil-works/pi-durable';

/** The provider's JSON is authoritative; presentation and replay are derived views. */
export type NativeResponseRecord = {
  requestId: string;
  taskId: number;
  provider: 'openai';
  model: string;
  status: 'in_progress' | 'completed' | 'failed' | 'incomplete' | 'interrupted';
  responseId?: string;
  /** Serialized Pi terminal content; native replay applies only while this content remains unedited. */
  normalizedContent?: string;
  output: JsonObject[];
  response?: JsonObject;
  /** Structural events retain metadata that may be absent from the terminal envelope. */
  events: JsonObject[];
  error?: string;
};

export interface NativeWebSearchIntegration {
  record: NativeResponseRecord;
  /** Only responses referenced by the current durable model context. */
  history: readonly NativeResponseRecord[];
  /** Resolves after storage commits. No uncommitted native state reaches the UI. */
  save(record: NativeResponseRecord): Promise<void>;
}

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Copy provider JSON without sharing references with the SDK's mutable stream. */
export function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
