// What scripts/build.mjs gives the bundle.

/** esbuild's binary loader gives a `.wasm` import its bytes. */
declare module '*.wasm' {
  const bytes: Uint8Array;
  export default bytes;
}

/** This server's release, defined at build time from package.json. */
declare const INFINICHAT_SERVER_VERSION: string;
