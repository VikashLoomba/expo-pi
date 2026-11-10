// What scripts/build.mjs gives the bundle.

/** esbuild's binary loader gives a `.wasm` import its bytes. */
declare module '*.wasm' {
  const bytes: Uint8Array;
  export default bytes;
}

/**
 * This server's release, defined at build time from package.json. Only InfiniChat's plugin reads it (`facet.ts` and
 * what it imports): a runtime that held it would differ in every release, and no machine could keep its runtime
 * (`update.ts`).
 */
declare const INFINICHAT_SERVER_VERSION: string;
