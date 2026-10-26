export type BootstrapErrorCode = 'UNSUPPORTED_REMOTE' | 'DAEMON_ASSET' | 'DAEMON_SETUP' | 'DAEMON_VERIFY' | 'DAEMON_UPLOAD' | 'TIMEOUT' | 'CANCELLED';

const messages: Record<BootstrapErrorCode, string> = {
  UNSUPPORTED_REMOTE: 'Automatic remote setup supports macOS and Linux on arm64 or x86-64.',
  DAEMON_ASSET: 'The bundled Pi daemon asset is unavailable or failed verification. Reinstall the app.',
  DAEMON_SETUP: 'Automatic Pi daemon setup failed. Check the remote account’s home-directory permissions and available disk space.',
  DAEMON_VERIFY: 'The remote Pi daemon could not be verified. The machine needs sha256sum, shasum, or openssl for SHA-256 verification.',
  DAEMON_UPLOAD: 'The Pi daemon upload did not complete or pass verification. Check connectivity and remote disk space, then retry.',
  TIMEOUT: 'Automatic Pi daemon setup timed out. Check Tailscale connectivity and the remote SSH server.',
  CANCELLED: 'SSH connection cancelled.',
};

/** Constructed from local fixed messages only; remote shell diagnostics never enter model context or logs. */
export class BootstrapError extends Error {
  readonly code: BootstrapErrorCode;
  constructor(code: BootstrapErrorCode) {
    super(messages[code]);
    this.name = 'BootstrapError';
    this.code = code;
  }
}
