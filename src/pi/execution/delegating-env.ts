import type { ExecutionEnv } from '@earendil-works/pi-durable/env';

/** A policy forwards the complete public contract and preserves namespace/cwd identity. */
export class DelegatingExecutionEnv implements ExecutionEnv {
  constructor(protected readonly environment: ExecutionEnv) {}
  get id() { return this.environment.id; }
  get cwd() { return this.environment.cwd; }
  set cwd(value: string) { this.environment.cwd = value; }
  absolutePath(...args: Parameters<ExecutionEnv['absolutePath']>): ReturnType<ExecutionEnv['absolutePath']> {
    return this.environment.absolutePath(...args);
  }
  joinPath(...args: Parameters<ExecutionEnv['joinPath']>): ReturnType<ExecutionEnv['joinPath']> {
    return this.environment.joinPath(...args);
  }
  readTextFile(...args: Parameters<ExecutionEnv['readTextFile']>): ReturnType<ExecutionEnv['readTextFile']> {
    return this.environment.readTextFile(...args);
  }
  openTextLineReader(...args: Parameters<ExecutionEnv['openTextLineReader']>): ReturnType<ExecutionEnv['openTextLineReader']> {
    return this.environment.openTextLineReader(...args);
  }
  readTextLines(...args: Parameters<ExecutionEnv['readTextLines']>): ReturnType<ExecutionEnv['readTextLines']> {
    return this.environment.readTextLines(...args);
  }
  readBinaryFile(...args: Parameters<ExecutionEnv['readBinaryFile']>): ReturnType<ExecutionEnv['readBinaryFile']> {
    return this.environment.readBinaryFile(...args);
  }
  openBinaryReader(...args: Parameters<ExecutionEnv['openBinaryReader']>): ReturnType<ExecutionEnv['openBinaryReader']> {
    return this.environment.openBinaryReader(...args);
  }
  writeFile(...args: Parameters<ExecutionEnv['writeFile']>): ReturnType<ExecutionEnv['writeFile']> {
    return this.environment.writeFile(...args);
  }
  appendFile(...args: Parameters<ExecutionEnv['appendFile']>): ReturnType<ExecutionEnv['appendFile']> {
    return this.environment.appendFile(...args);
  }
  truncateFile(...args: Parameters<ExecutionEnv['truncateFile']>): ReturnType<ExecutionEnv['truncateFile']> {
    return this.environment.truncateFile(...args);
  }
  flushFile(...args: Parameters<ExecutionEnv['flushFile']>): ReturnType<ExecutionEnv['flushFile']> {
    return this.environment.flushFile(...args);
  }
  renameFile(...args: Parameters<ExecutionEnv['renameFile']>): ReturnType<ExecutionEnv['renameFile']> {
    return this.environment.renameFile(...args);
  }
  fileInfo(...args: Parameters<ExecutionEnv['fileInfo']>): ReturnType<ExecutionEnv['fileInfo']> {
    return this.environment.fileInfo(...args);
  }
  listDir(...args: Parameters<ExecutionEnv['listDir']>): ReturnType<ExecutionEnv['listDir']> {
    return this.environment.listDir(...args);
  }
  openDirReader(...args: Parameters<ExecutionEnv['openDirReader']>): ReturnType<ExecutionEnv['openDirReader']> {
    return this.environment.openDirReader(...args);
  }
  watch(...args: Parameters<ExecutionEnv['watch']>): ReturnType<ExecutionEnv['watch']> {
    return this.environment.watch(...args);
  }
  canonicalPath(...args: Parameters<ExecutionEnv['canonicalPath']>): ReturnType<ExecutionEnv['canonicalPath']> {
    return this.environment.canonicalPath(...args);
  }
  exists(...args: Parameters<ExecutionEnv['exists']>): ReturnType<ExecutionEnv['exists']> {
    return this.environment.exists(...args);
  }
  createDir(...args: Parameters<ExecutionEnv['createDir']>): ReturnType<ExecutionEnv['createDir']> {
    return this.environment.createDir(...args);
  }
  remove(...args: Parameters<ExecutionEnv['remove']>): ReturnType<ExecutionEnv['remove']> {
    return this.environment.remove(...args);
  }
  createTempDir(...args: Parameters<ExecutionEnv['createTempDir']>): ReturnType<ExecutionEnv['createTempDir']> {
    return this.environment.createTempDir(...args);
  }
  createTempFile(...args: Parameters<ExecutionEnv['createTempFile']>): ReturnType<ExecutionEnv['createTempFile']> {
    return this.environment.createTempFile(...args);
  }
  exec(...args: Parameters<ExecutionEnv['exec']>): ReturnType<ExecutionEnv['exec']> {
    return this.environment.exec(...args);
  }
  cleanup(...args: Parameters<ExecutionEnv['cleanup']>): ReturnType<ExecutionEnv['cleanup']> {
    return this.environment.cleanup(...args);
  }
}
