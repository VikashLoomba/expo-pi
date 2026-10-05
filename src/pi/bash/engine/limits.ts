import type { BashOptions } from 'just-bash/browser';

const MiB = 1024 * 1024;

/** Shared with the compression adapter; a codec call cannot exceed this ceiling. */
export const MAX_CODEC_BYTES = 4 * MiB;

/** Phone-sized ceilings, in addition to the persistent filesystem's own quotas. */
export const BASH_EXECUTION_LIMITS = Object.freeze({
  maxSourceBytes: 64 * 1024,
  maxExecDepth: 16,
  maxCallDepth: 32,
  maxCommandCount: 2_000,
  maxLoopIterations: 2_000,
  maxAwkIterations: 10_000,
  maxSedIterations: 10_000,
  maxJqIterations: 10_000,
  maxQueryTokens: 10_000,
  maxQueryDepth: 64,
  maxQueryElements: 20_000,
  maxAwkParserTokens: 10_000,
  maxAwkParserDepth: 64,
  maxAwkParserOperations: 50_000,
  maxWorkUnits: 100_000,
  maxTraversalEntries: 10_000,
  maxTraversalDepth: 64,
  maxTraversalWork: 50_000,
  maxGlobOperations: 50_000,
  maxLiveBytes: 32 * MiB,
  maxInputBytes: 16 * MiB,
  maxFileSystemBytes: 8 * MiB,
  maxStringLength: MAX_CODEC_BYTES,
  maxOutputSize: MAX_CODEC_BYTES,
  maxArrayElements: 20_000,
  maxHeredocSize: 64 * 1024,
  maxSubstitutionDepth: 16,
  maxBraceExpansionResults: 2_000,
  maxFileDescriptors: 128,
  maxSourceDepth: 16,
  maxExecutionTimeMs: 30_000,
  maxExtensionCleanupTimeMs: 100,
} satisfies NonNullable<BashOptions['executionLimits']>);
