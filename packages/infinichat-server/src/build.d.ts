// What scripts/build.mjs gives the bundle.

/** esbuild's binary loader gives a `.wasm` import its bytes. */
declare module '*.wasm' {
  const bytes: Uint8Array;
  export default bytes;
}

/** The pi versions the bundle was built with, defined at build time from the installed packages. */
declare const INFINICHAT_PI: { durable: string; ai: string; chord: string };
