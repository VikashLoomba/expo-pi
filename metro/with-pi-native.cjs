const fs = require('node:fs');
const path = require('node:path');

// Reviewed against Pi commit b45597504eeaba1f11a9920a1d1048c361ed4b8e.
const REVIEWED_PI_VERSION = '0.87.1';
const shims = new Map([
  ['auth/context', 'auth-context.native.ts'],
  ['env-api-keys', 'env-api-keys.native.ts'],
  ['auth/oauth/load', 'oauth-load.native.ts'],
  ['utils/provider-env', 'provider-env.native.ts'],
]);

/**
 * Replace the Pi AI modules containing desktop platform loaders in native bundles.
 * Apply after any other Metro config wrappers to preserve their resolver behavior.
 * No files in node_modules are changed. Web and server bundles are left unchanged.
 */
module.exports = function withPiNative(config) {
  const previousResolveRequest = config.resolver.resolveRequest;
  const packageCache = new Map();
  const logged = new Set();

  config.resolver.resolveRequest = (context, moduleName, platform) => {
    // Resolve the incoming static import/re-export to a file, but don't return it
    // to Metro for transformation until we've checked for a replacement.
    const result = previousResolveRequest
      ? previousResolveRequest(context, moduleName, platform)
      : context.resolveRequest(context, moduleName, platform);

    const environment = context.customResolverOptions?.environment;
    if (
      (platform !== 'ios' && platform !== 'android') ||
      environment === 'node' || environment === 'react-server' ||
      result.type !== 'sourceFile'
    ) {
      return result;
    }

    const normalized = result.filePath.replace(/\\/g, '/');
    const match = normalized.match(
      /^(.*)\/(?:dist|src)\/(auth\/context|env-api-keys|auth\/oauth\/load|utils\/provider-env)\.(?:js|ts)$/,
    );
    if (!match) return result;

    const [, packageRoot, moduleKey] = match;
    // Check package identity instead of assuming a flat node_modules layout.
    // This also covers pnpm installations and built/source workspaces.
    let pkg = packageCache.get(packageRoot);
    if (pkg === undefined) {
      const manifest = path.join(packageRoot, 'package.json');
      pkg = fs.existsSync(manifest)
        ? JSON.parse(fs.readFileSync(manifest, 'utf8'))
        : null;
      packageCache.set(packageRoot, pkg);
    }
    if (pkg?.name !== '@earendil-works/pi-ai') return result;
    if (pkg.version !== REVIEWED_PI_VERSION) {
      throw new Error(
        `[pi-native] Shims were reviewed for pi-ai ${REVIEWED_PI_VERSION}, ` +
        `but resolved ${pkg.version}. Review the four upstream modules before updating the guard.`,
      );
    }

    const replacement = path.join(__dirname, 'pi-native', shims.get(moduleKey));
    if (!fs.existsSync(replacement)) {
      throw new Error(`[pi-native] Missing shim: ${replacement}`);
    }
    if (process.env.PI_NATIVE_DEBUG === '1' && !logged.has(result.filePath)) {
      console.log(`[pi-native] ${result.filePath} -> ${replacement}`);
      logged.add(result.filePath);
    }
    return { type: 'sourceFile', filePath: replacement };
  };

  return config;
};
