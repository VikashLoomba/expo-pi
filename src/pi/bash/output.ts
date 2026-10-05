import { uuidv7 } from '@earendil-works/pi-ai';
import type { IFileSystem } from 'just-bash/browser';

export const TOOL_OUTPUT_BYTES = 48 * 1024;
const STREAM_OUTPUT_LINES = 800;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function excerpt(value: string, budget: number) {
  const bytes = encoder.encode(value);
  let end = Math.min(bytes.length, Math.max(0, budget));
  while (end < bytes.length && end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  let lines = 0;
  for (let index = 0; index < end; index++) {
    if (bytes[index] === 10 && ++lines === STREAM_OUTPUT_LINES) { end = index + 1; break; }
  }
  return { text: decoder.decode(bytes.subarray(0, end)), bytes: bytes.length, truncated: end < bytes.length };
}

/** Preserve oversized output as ordinary workspace files, without following guest-created links. */
async function spill(files: IFileSystem, stdout: string, stderr: string) {
  const directory = '/.bash-output';
  try { await files.mkdir(directory); }
  catch (error) {
    if (!(await files.lstat(directory)).isDirectory) throw error;
  }
  if (!files.createExclusive) throw new Error('Workspace does not support exclusive output files.');
  const paths: { stdout?: string; stderr?: string } = {};
  const name = uuidv7();
  for (const [stream, content] of [['stdout', stdout], ['stderr', stderr]] as const) {
    if (!content) continue;
    const path = `${directory}/${name}.${stream}.txt`;
    await files.createExclusive(path, { mode: 0o600 });
    await files.writeFile(path, content);
    paths[stream] = `/workspace${path}`;
  }
  return paths;
}

export async function presentOutput(files: IFileSystem, result: { stdout: string; stderr: string; exitCode: number }, options: { allowSpill?: boolean } = {}) {
  const stdout = excerpt(result.stdout, TOOL_OUTPUT_BYTES / 2);
  const stderr = excerpt(result.stderr, TOOL_OUTPUT_BYTES / 2);
  const truncated = stdout.truncated || stderr.truncated;
  let outputFiles: { stdout?: string; stderr?: string } | undefined;
  let spillError: string | undefined;
  if (truncated && options.allowSpill === false) {
    spillError = 'The command deadline expired; no additional output files were written.';
  } else if (truncated) {
    try { outputFiles = await spill(files, result.stdout, result.stderr); }
    catch (error) { spillError = error instanceof Error ? error.message : String(error); }
  }
  const pieces = [`Exit code: ${result.exitCode}`];
  if (outputFiles) for (const [stream, path] of Object.entries(outputFiles)) pieces.push(`Full ${stream}: ${path}`);
  if (spillError) pieces.push(`Output was truncated; saving full output failed: ${spillError}`);
  if (stdout.text) pieces.push(`stdout:\n${stdout.text}${stdout.truncated ? '\n[stdout truncated]' : ''}`);
  if (stderr.text) pieces.push(`stderr:\n${stderr.text}${stderr.truncated ? '\n[stderr truncated]' : ''}`);
  return {
    text: pieces.join('\n\n'),
    details: { exitCode: result.exitCode, stdoutBytes: stdout.bytes, stderrBytes: stderr.bytes, truncated,
      ...(outputFiles ? { outputFiles } : {}), ...(spillError ? { spillError } : {}) },
  };
}
