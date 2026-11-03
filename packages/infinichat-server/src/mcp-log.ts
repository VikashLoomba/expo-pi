import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** pi's coding agent moves its MCP log aside past 5 MB (`src/extensions/mcp/log.ts`). */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function formatData(data: unknown): string {
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data) ?? String(data);
  } catch {
    return String(data);
  }
}

/** One `notifications/message` from `server` as a log line; continuation lines are indented. */
function formatLine(server: string, params: unknown): string {
  const message = typeof params === 'object' && params !== null && !Array.isArray(params)
    ? Object.fromEntries(Object.entries(params)) : { data: params };
  const level = typeof message.level === 'string' ? message.level : 'info';
  const logger = typeof message.logger === 'string' && message.logger ? ` ${message.logger}:` : '';
  const text = formatData(message.data).replace(/\r?\n/g, '\n    ');
  return `${new Date().toISOString()} [${server}] ${level}${logger} ${text}\n`;
}

/**
 * The log messages the MCP servers send (`notifications/message`), appended to `~/.infinichat/mcp.log` as
 * `<time> [<server>] <level> <logger>: <message>`, as the coding agent keeps `mcp.log` and moves it to `mcp.log.1`
 * past its size. Write errors are ignored: logging must not break tools.
 */
export class McpLog {
  private size: number | undefined;

  constructor(readonly path: string) {}

  write(server: string, params: unknown): void {
    const line = formatLine(server, params);
    try {
      if (this.size === undefined) {
        mkdirSync(dirname(this.path), { recursive: true });
        this.size = this.currentSize();
      }
      if (this.size > MAX_LOG_BYTES) {
        renameSync(this.path, `${this.path}.1`);
        this.size = 0;
      }
      appendFileSync(this.path, line, { mode: 0o600 });
      this.size += Buffer.byteLength(line);
    } catch {
      // The log is best effort.
    }
  }

  private currentSize(): number {
    try {
      return statSync(this.path).size;
    } catch {
      return 0;
    }
  }
}
