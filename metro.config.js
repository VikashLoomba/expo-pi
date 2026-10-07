const { getDefaultConfig } = require('expo/metro-config');
const { withPi } = require('@automatalabs/expo-pi/metro');
const path = require('node:path');
const { isBashBrowser } = require('./src/pi/bash/engine/browser-compat.cjs');

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
  if (moduleName === 'node:zlib' && isBashBrowser(context.originModulePath)) {
    return { type: 'sourceFile', filePath: path.resolve(__dirname, 'src/pi/bash/engine/bounded-zlib.ts') };
  }
  return resolveRequest
    ? resolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};
piConfig.transformer.piBashUpstreamTransformerPath = piConfig.transformerPath;
piConfig.transformerPath = require.resolve('./src/pi/bash/engine/metro-transformer.cjs');
module.exports = piConfig;
