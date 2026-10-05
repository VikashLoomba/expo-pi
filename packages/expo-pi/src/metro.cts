import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CRYPTO_BRIDGE_SPECIFIER } from './rewrite.cjs';
import { UPSTREAM_TRANSFORMER_KEY, WEB_CLIENT_TRANSFORM_KEY } from './transform-worker.cjs';

const TRANSFORM_WORKER_PATH = require.resolve('./transform-worker.cjs');
const CRYPTO_BRIDGE_PATH = path.join(__dirname, 'polyfills', 'crypto.js');

// Expo CLI keys its transform cache on the transformer config, not on a custom worker's
// source, so the config carries a stamp that changes whenever this package's code does.
const CACHE_KEY = crypto.createHash('sha1')
  .update(fs.readFileSync(path.join(__dirname, '..', 'package.json')))
  .update(fs.readFileSync(TRANSFORM_WORKER_PATH))
  .update(fs.readFileSync(require.resolve('./rewrite.cjs')))
  .digest('hex');

/** The subset of Metro's `Resolution` used here. */
export interface PiResolution {
  readonly type: string;
  readonly filePath?: string;
}

/** The subset of Metro's `CustomResolutionContext` used here. */
export interface PiResolutionContext {
  readonly resolveRequest: PiResolver;
}

// Declared as a method so Metro's richer context type remains assignable.
export type PiResolver = {
  resolve(context: PiResolutionContext, moduleName: string, platform: string | null): PiResolution;
}['resolve'];

/** Any Metro config, such as the one returned by `getDefaultConfig` from `expo/metro-config`. */
export interface PiMetroConfig {
  readonly projectRoot?: string;
  readonly transformerPath?: string;
  readonly transformer?: { readonly [key: string]: unknown };
  readonly resolver: {
    readonly resolveRequest?: PiResolver | null | undefined;
  };
}

export interface PiMetroOptions {
  /** Also rewrite Pi's desktop-only imports in Metro web client bundles. Defaults to false. */
  readonly web?: boolean;
}

/**
 * Make Pi bundle and run in iOS and Android apps, and optionally web clients.
 *
 * In native bundles, Pi's own modules are kept, with two changes applied as Metro transforms them:
 * `import(specifier)` calls with a variable specifier, which Metro can't bundle and which only
 * run on Node or Bun, become rejected promises; and modules that call `crypto.getRandomValues`
 * import a bridge that installs it from `expo-crypto` when Hermes lacks it.
 *
 * Apply after other Metro config wrappers so their resolvers and transform workers are kept.
 * Web clients are unchanged unless `web: true` is passed. Server bundles and all other
 * packages are always unchanged. No files in node_modules are modified.
 */
export function withPi<T extends PiMetroConfig>(config: T, options: PiMetroOptions = {}): T {
  // Wrapping twice would make the worker delegate to itself.
  if (config.transformerPath === TRANSFORM_WORKER_PATH) {
    const currentWeb = config.transformer?.[WEB_CLIENT_TRANSFORM_KEY] === true;
    const web = options.web ?? currentWeb;
    if (web === currentWeb) return config;
    return { ...config, transformer: { ...config.transformer, [WEB_CLIENT_TRANSFORM_KEY]: web } };
  }
  const projectRoot = config.projectRoot ?? process.cwd();
  const upstreamTransformerPath = config.transformerPath ??
    require.resolve('metro-transform-worker', { paths: [projectRoot] });
  const previousResolveRequest = config.resolver.resolveRequest;

  const resolveRequest: PiResolver = (context, moduleName, platform) => {
    // Resolve the injected bridge to this package regardless of where Pi is installed.
    if (moduleName === CRYPTO_BRIDGE_SPECIFIER) return { type: 'sourceFile', filePath: CRYPTO_BRIDGE_PATH };
    return previousResolveRequest
      ? previousResolveRequest(context, moduleName, platform)
      : context.resolveRequest(context, moduleName, platform);
  };

  return {
    ...config,
    transformerPath: TRANSFORM_WORKER_PATH,
    transformer: {
      ...config.transformer,
      // Relative to the project root so the cache key doesn't depend on the machine.
      [UPSTREAM_TRANSFORMER_KEY]: path.relative(projectRoot, upstreamTransformerPath),
      [WEB_CLIENT_TRANSFORM_KEY]: options.web === true,
      expoPiCacheKey: CACHE_KEY,
    },
    resolver: { ...config.resolver, resolveRequest },
  };
}
