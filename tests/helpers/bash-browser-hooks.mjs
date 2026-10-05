import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { adaptBashBrowser, isBashBrowser } = require('../../src/pi/bash/engine/browser-compat.cjs');
const sourceRoot = new URL('../../src/', import.meta.url).href;
const codecUrl = new URL('../../src/pi/bash/engine/bounded-zlib.ts', import.meta.url).href;
const cryptoUrl = new URL('../../src/pi/bash/engine/native-crypto.ts', import.meta.url).href;

/**
 * Run the exact Metro-adapted published shell in Node tests. Only Expo's native
 * crypto bridge is substituted with real Node WebCrypto; no shell/FS fixtures.
 */
export function installBashBrowserHooks() {
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'node:zlib' && isBashBrowser(context.parentURL ?? '')) {
        return { url: codecUrl, shortCircuit: true };
      }
      if (specifier === 'expo-crypto' && context.parentURL === cryptoUrl) {
        return { url: 'test:bash-expo-crypto', shortCircuit: true };
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
      if (url === 'test:bash-expo-crypto') return {
        format: 'module', shortCircuit: true,
        source: `import { webcrypto } from 'node:crypto';
          export const CryptoDigestAlgorithm = { SHA1: 'SHA-1', SHA256: 'SHA-256' };
          export const digest = (algorithm, bytes) => webcrypto.subtle.digest(algorithm, bytes);
          export const getRandomValues = (bytes) => webcrypto.getRandomValues(bytes);`,
      };
      if (isBashBrowser(url)) return {
        format: 'module', shortCircuit: true,
        source: adaptBashBrowser(readFileSync(new URL(url), 'utf8'), cryptoUrl),
      };
      if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return {
        format: 'module', shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform', sourceMap: false, sourceUrl: url }),
      };
      return nextLoad(url, context);
    },
  });
}
