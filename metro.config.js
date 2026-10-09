const { getDefaultConfig } = require('expo/metro-config');
const { withPi } = require('@automatalabs/expo-pi/metro');
const path = require('node:path');

const JUST_BASH_BROWSER = /[/\\]just-bash[/\\]dist[/\\]bundle[/\\]browser\.js$/;

const config = getDefaultConfig(__dirname);
if (!config.resolver.assetExts.includes('bin')) config.resolver.assetExts.push('bin');
const piConfig = withPi(config);
const resolveRequest = piConfig.resolver.resolveRequest;
piConfig.resolver.resolveRequest = (context, moduleName, platform) => {
  // just-bash's browser bundle imports node:zlib for gzip, which Hermes lacks and the app does not offer.
  if (moduleName === 'node:zlib' && JUST_BASH_BROWSER.test(context.originModulePath)) {
    return { type: 'sourceFile', filePath: path.resolve(__dirname, 'src/pi/bash/engine/zlib-stub.ts') };
  }
  return resolveRequest
    ? resolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};
module.exports = piConfig;
