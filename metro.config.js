const { getDefaultConfig } = require('expo/metro-config');
const { withPi } = require('@automatalabs/expo-pi/metro');

const JUST_BASH_BROWSER = /[/\\]just-bash[/\\]dist[/\\]bundle[/\\]browser\.js$/;

const config = getDefaultConfig(__dirname);
if (!config.resolver.assetExts.includes('bin')) config.resolver.assetExts.push('bin');
const piConfig = withPi(config);
const resolveRequest = piConfig.resolver.resolveRequest;
piConfig.resolver.resolveRequest = (context, moduleName, platform) => {
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
module.exports = piConfig;
