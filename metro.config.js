const { getDefaultConfig } = require('expo/metro-config');
const { withPi } = require('@automatalabs/expo-pi/metro');
const path = require('node:path');

const JUST_BASH_BROWSER = /[/\\]just-bash[/\\]dist[/\\]bundle[/\\]browser\.js$/;

const config = getDefaultConfig(__dirname);
if (!config.resolver.assetExts.includes('wasm')) config.resolver.assetExts.push('wasm');
if (!config.resolver.assetExts.includes('bin')) config.resolver.assetExts.push('bin');
const enhanceMiddleware = config.server.enhanceMiddleware;
config.server.enhanceMiddleware = (middleware, server) => {
  const handler = enhanceMiddleware ? enhanceMiddleware(middleware, server) : middleware;
  return (request, response, next) => {
    // Expo SQLite's browser worker uses SharedArrayBuffer.
    response.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    return handler(request, response, next);
  };
};
const piConfig = withPi(config, { web: true });
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
