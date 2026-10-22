/** esbuild's binary loader gives a `.wasm` import its bytes (scripts/build-infinichat-server.mjs). */
declare module '*.wasm' {
  const bytes: Uint8Array;
  export default bytes;
}
