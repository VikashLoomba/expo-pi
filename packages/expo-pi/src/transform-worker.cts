import * as fs from 'node:fs';
import * as path from 'node:path';
import { rewritePiModule } from './rewrite.cjs';

/** Transformer config key holding the worker that `withPi` wraps, relative to the project root. */
export const UPSTREAM_TRANSFORMER_KEY = 'expoPiUpstreamTransformerPath';
/** Opt-in for applying the same rewrite to Metro browser clients. */
export const WEB_CLIENT_TRANSFORM_KEY = 'expoPiWebClient';

const PI_PACKAGE_SCOPE = '@earendil-works/';
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;

interface TransformerConfig {
  readonly [key: string]: unknown;
}

interface TransformOptions {
  readonly platform?: string | null;
  readonly customTransformOptions?: { readonly [key: string]: unknown } | null;
}

interface CacheKeyOptions {
  readonly projectRoot: string;
}

interface TransformWorker {
  transform(
    config: TransformerConfig,
    projectRoot: string,
    filename: string,
    data: Buffer,
    options: TransformOptions,
  ): Promise<unknown>;
  getCacheKey?(config: TransformerConfig, options: CacheKeyOptions): string;
}

function isTransformWorker(value: unknown): value is TransformWorker {
  return typeof value === 'object' && value !== null && 'transform' in value &&
    typeof value.transform === 'function';
}

const upstreamWorkers = new Map<string, TransformWorker>();

function loadUpstream(config: TransformerConfig, projectRoot: string): TransformWorker {
  const configured = config[UPSTREAM_TRANSFORMER_KEY];
  if (typeof configured !== 'string') {
    throw new Error('[expo-pi] This transform worker must be configured with withPi() from @automatalabs/expo-pi/metro.');
  }
  const workerPath = path.resolve(projectRoot, configured);
  let worker = upstreamWorkers.get(workerPath);
  if (!worker) {
    const loaded: unknown = require(workerPath);
    if (!isTransformWorker(loaded)) {
      throw new Error(`[expo-pi] ${workerPath} is not a Metro transform worker.`);
    }
    worker = loaded;
    upstreamWorkers.set(workerPath, worker);
  }
  return worker;
}

const packageNames = new Map<string, string | null>();

/** The name in the nearest package.json that has one, for files inside Pi's packages. */
function owningPackageName(directory: string): string | null {
  const cached = packageNames.get(directory);
  if (cached !== undefined) return cached;
  let name: string | null = null;
  const manifest = path.join(directory, 'package.json');
  const parent = path.dirname(directory);
  if (fs.existsSync(manifest)) {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'name' in parsed && typeof parsed.name === 'string') {
      name = parsed.name;
    }
  }
  if (name === null && parent !== directory) name = owningPackageName(parent);
  packageNames.set(directory, name);
  return name;
}

function isSupportedClientBundle(options: TransformOptions, web: boolean): boolean {
  const environment = options.customTransformOptions?.environment;
  return (options.platform === 'ios' || options.platform === 'android' || (web && options.platform === 'web')) &&
    environment !== 'node' && environment !== 'react-server';
}

export function shouldRewrite(absolutePath: string, options: TransformOptions, web = false): boolean {
  return SCRIPT_FILE.test(absolutePath) && isSupportedClientBundle(options, web) &&
    (owningPackageName(path.dirname(absolutePath))?.startsWith(PI_PACKAGE_SCOPE) ?? false);
}

export async function transform(
  config: TransformerConfig,
  projectRoot: string,
  filename: string,
  data: Buffer,
  options: TransformOptions,
): Promise<unknown> {
  const upstream = loadUpstream(config, projectRoot);
  let input = data;
  if (shouldRewrite(path.resolve(projectRoot, filename), options, config[WEB_CLIENT_TRANSFORM_KEY] === true)) {
    const source = data.toString('utf8');
    const result = rewritePiModule(source, filename);
    if (result.code !== source) {
      input = Buffer.from(result.code, 'utf8');
      if (process.env.EXPO_PI_DEBUG === '1') {
        console.log(`[expo-pi] ${filename}: ${result.variableImports} variable import(s) replaced` +
          (result.cryptoBridge ? ', crypto bridge added' : ''));
      }
    }
  }
  return upstream.transform(config, projectRoot, filename, input, options);
}

export function getCacheKey(config: TransformerConfig, options: CacheKeyOptions): string {
  // withPi() also adds a version stamp to the transformer config, which Expo's own
  // cache key includes when Expo CLI supervises this worker.
  const upstream = loadUpstream(config, options.projectRoot).getCacheKey?.(config, options) ?? '';
  // Custom upstream workers may ignore our config fields, so always include the opt-in.
  return `${upstream}:expo-pi-web:${config[WEB_CLIENT_TRANSFORM_KEY] === true ? '1' : '0'}`;
}
