const { getDefaultConfig } = require('expo/metro-config');

const JUST_BASH_BROWSER = /[/\\]just-bash[/\\]dist[/\\]bundle[/\\]browser\.js$/;

const config = getDefaultConfig(__dirname);
if (!config.resolver.assetExts.includes('bin')) config.resolver.assetExts.push('bin');
const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // just-bash's browser bundle imports node:zlib only for its gzip-family commands, which this shell
  // does not offer (rg's --search-zip would fail if used); Hermes has no zlib. Metro's own empty
  // resolution drops the import, so no stub module is needed.
  if (moduleName === 'node:zlib' && JUST_BASH_BROWSER.test(context.originModulePath)) {
    return { type: 'empty' };
  }
  return resolveRequest
    ? resolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};
// docs/infinichat is the OptChat implementation guide: reference TypeScript with its own package.json, never part of
// the app bundle. Keep Metro from crawling it, or any node_modules an agent installs there to run its tests.
const INFINICHAT_GUIDE = /[/\\]docs[/\\]infinichat[/\\]/;
const { blockList } = config.resolver;
config.resolver.blockList = [...(Array.isArray(blockList) ? blockList : blockList ? [blockList] : []), INFINICHAT_GUIDE];
module.exports = config;
