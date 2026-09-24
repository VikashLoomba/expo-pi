import type { OAuthAuth } from '@earendil-works/pi-ai';

type FlowLoader = () => OAuthAuth | Promise<OAuthAuth>;
type OAuthFlowLoaders = {
  anthropic: FlowLoader;
  openaiCodex: FlowLoader;
  githubCopilot: FlowLoader;
  openrouter: FlowLoader;
  kimiCoding: FlowLoader;
  meta: FlowLoader;
  xai: FlowLoader;
  radius: (options: { name: string; gateway: string }) => OAuthAuth | Promise<OAuthAuth>;
};

let bundledLoaders: OAuthFlowLoaders | undefined;

// Preserve the original registration export, without dynamically loading code.
export function registerBundledOAuthFlowLoaders(loaders: OAuthFlowLoaders): void {
  bundledLoaders = loaders;
}

function requireLoaders(): OAuthFlowLoaders {
  if (!bundledLoaders) {
    throw new Error(
      'Pi desktop OAuth loaders are disabled in the native bundle. ' +
      'Use an explicit API-key credential or supply a mobile OAuth implementation.',
    );
  }
  return bundledLoaders;
}

// Importing this module is safe. Unsupported OAuth rejects only on invocation.
export const loadAnthropicOAuth = async (): Promise<OAuthAuth> => requireLoaders().anthropic();
export const loadOpenAICodexOAuth = async (): Promise<OAuthAuth> => requireLoaders().openaiCodex();
export const loadGitHubCopilotOAuth = async (): Promise<OAuthAuth> => requireLoaders().githubCopilot();
export const loadOpenRouterOAuth = async (): Promise<OAuthAuth> => requireLoaders().openrouter();
export const loadKimiCodingOAuth = async (): Promise<OAuthAuth> => requireLoaders().kimiCoding();
export const loadMetaOAuth = async (): Promise<OAuthAuth> => requireLoaders().meta();
export const loadXaiOAuth = async (): Promise<OAuthAuth> => requireLoaders().xai();
export const loadRadiusOAuth = async (
  options: { name: string; gateway: string },
): Promise<OAuthAuth> => requireLoaders().radius(options);
