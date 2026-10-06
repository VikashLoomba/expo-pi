import type { Context } from '@earendil-works/chord';
import type { ArtifactWriter } from '../execution/types';

export const TOOL_OUTPUT_BYTES = 48 * 1024;
export const STREAM_OUTPUT_LINES = 800;
/** Full output retention is bounded independently of an environment's own receiving limits. */
export const STREAM_ARTIFACT_BYTES = 8 * 1024 * 1024;

function scalarBytes(point: number): number { return point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4; }

export class BoundedOutputStream {
  bytes = 0;
  private preview = '';
  private previewBytes = 0;
  private lines = 0;
  private previewDone = false;
  private full: string | undefined;

  constructor(retainArtifact: boolean) { this.full = retainArtifact ? '' : undefined; }

  append(text: string): void {
    let end = 0;
    let selecting = !this.previewDone && this.previewBytes < TOOL_OUTPUT_BYTES / 2 && this.lines < STREAM_OUTPUT_LINES;
    for (let at = 0; at < text.length;) {
      const point = text.codePointAt(at)!;
      const units = point > 0xffff ? 2 : 1;
      const bytes = scalarBytes(point);
      this.bytes += bytes;
      if (selecting && this.previewBytes + bytes <= TOOL_OUTPUT_BYTES / 2) {
        this.previewBytes += bytes;
        end = at + units;
        if (point === 10 && ++this.lines >= STREAM_OUTPUT_LINES) selecting = false;
      } else selecting = false;
      at += units;
    }
    if (text.length && !selecting) this.previewDone = true;
    // Copy the bounded excerpt so a substring implementation cannot retain the
    // backing storage of a much larger incoming callback chunk.
    if (end) this.preview += Array.from(text.slice(0, end)).join('');
    if (this.full !== undefined) {
      if (this.bytes <= STREAM_ARTIFACT_BYTES) this.full += text;
      else this.full = undefined;
    }
  }

  get text(): string { return this.preview; }
  get truncated(): boolean { return this.bytes > this.previewBytes; }
  get artifact(): string | undefined { return this.full; }
  /** Useful to audit the actual receiving bound even after many callbacks. */
  get retainedBytes(): number { return this.full === undefined ? this.previewBytes : this.bytes + this.previewBytes; }
}

export class BashOutput {
  readonly stdout: BoundedOutputStream;
  readonly stderr: BoundedOutputStream;
  constructor(retainArtifacts: boolean) {
    this.stdout = new BoundedOutputStream(retainArtifacts);
    this.stderr = new BoundedOutputStream(retainArtifacts);
  }
}

export async function presentOutput(
  output: BashOutput, exitCode: number, context: Context, artifacts?: ArtifactWriter,
  options: { allowSpill?: boolean; failure?: string } = {},
) {
  const { stdout, stderr } = output;
  const truncated = stdout.truncated || stderr.truncated;
  const outputFiles: { stdout?: string; stderr?: string } = {};
  let spillError: string | undefined;
  if (truncated && options.allowSpill === false) {
    spillError = 'The command deadline expired; no additional output files were written.';
  } else if (truncated && !artifacts) {
    spillError = 'This environment has no persistent artifact writer.';
  } else if (truncated) {
    for (const stream of ['stdout', 'stderr'] as const) {
      if (!output[stream].bytes) continue;
      const full = output[stream].artifact;
      if (full === undefined) {
        spillError = `Full ${stream} exceeded the ${STREAM_ARTIFACT_BYTES} byte artifact capture limit and was not retained.`;
        continue;
      }
      try {
        context.abortSignal?.throwIfAborted();
        outputFiles[stream] = await artifacts!.write(`bash-${stream}`, full, context);
      } catch (cause) {
        context.abortSignal?.throwIfAborted();
        spillError = (cause instanceof Error ? cause.message : String(cause)).slice(0, 1024);
      }
    }
  }
  const hasFiles = Object.keys(outputFiles).length > 0;
  const pieces = [`Exit code: ${exitCode}`];
  if (options.failure) pieces.push(options.failure);
  for (const [stream, path] of Object.entries(outputFiles)) pieces.push(`Full ${stream}: ${path}`);
  if (spillError) pieces.push(`Output was truncated; full output unavailable: ${spillError}`);
  if (stdout.text) pieces.push(`stdout:\n${stdout.text}${stdout.truncated ? '\n[stdout truncated]' : ''}`);
  if (stderr.text) pieces.push(`stderr:\n${stderr.text}${stderr.truncated ? '\n[stderr truncated]' : ''}`);
  return {
    text: pieces.join('\n\n'),
    details: { exitCode, stdoutBytes: stdout.bytes, stderrBytes: stderr.bytes, truncated,
      ...(hasFiles ? { outputFiles } : {}), ...(spillError ? { spillError } : {}) },
  };
}
