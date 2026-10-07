import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

const sourceRoot = new URL('../../src/', import.meta.url).href;
const zlibStubUrl = new URL('../../src/pi/bash/engine/zlib-stub.ts', import.meta.url).href;
const JUST_BASH_BROWSER = /[/\\]just-bash[/\\]dist[/\\]bundle[/\\]browser\.js$/;

/**
 * Load app TypeScript and the published just-bash browser bundle as Metro does: node:zlib resolves to the app's stub
 * for just-bash, and app imports of expo-crypto get Node's WebCrypto instead of the native module.
 */
export function installBashBrowserHooks() {
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'node:zlib' && JUST_BASH_BROWSER.test(context.parentURL ?? '')) {
        return { url: zlibStubUrl, shortCircuit: true };
      }
      if (specifier === 'expo-crypto' && context.parentURL?.startsWith(sourceRoot)) {
        return { url: 'test:expo-crypto', shortCircuit: true };
      }
      if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.')) {
        try { return nextResolve(specifier, context); }
        catch (error) {
          if (!['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT'].includes(error.code)) throw error;
          return nextResolve(`${specifier}.ts`, context);
        }
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === 'test:expo-crypto') return {
        format: 'module', shortCircuit: true,
        source: `import { webcrypto } from 'node:crypto';
          export const CryptoDigestAlgorithm = { SHA1: 'SHA-1', SHA256: 'SHA-256' };
          export const digest = (algorithm, bytes) => webcrypto.subtle.digest(algorithm, bytes);
          export const getRandomValues = (bytes) => webcrypto.getRandomValues(bytes);`,
      };
      if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return {
        format: 'module', shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'),
          { mode: 'transform', sourceMap: false, sourceUrl: url }),
      };
      return nextLoad(url, context);
    },
  });
}
