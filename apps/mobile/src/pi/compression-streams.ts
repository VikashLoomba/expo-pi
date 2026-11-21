// Hermes has no `CompressionStream` or `DecompressionStream`, and Chord's session sync gzips what it uploads and reads
// what it pulls through them, with no compressor a host could hand it instead (chord `src/sync/batch.ts`). The library
// installs both over the `TransformStream` Expo gives Hermes, from fflate's JavaScript: without a `Worker` it
// compresses on this thread, a chunk of the stream at a time. The owner allowed a library for it (2026-11-20), where
// this app otherwise adds no polyfill.
import 'compression-streams-polyfill';
