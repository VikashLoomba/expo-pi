/**
 * The provider that reaches Claude through a machine's own Claude Code login, pi-claude-code's `PROVIDER_ID`
 * (github.com/earendil-works/pi-claude-code, `src/model-catalog.ts`). A machine's server registers it in place of
 * Anthropic's API-key provider (`infinichat-server/src/claude-code.ts`); the phone cannot run it, since it drives the
 * `claude` program, so the apps only name it, to show its sign-in as Claude Code's own.
 */
export const CLAUDE_CODE_PROVIDER_ID = 'claude-code';
