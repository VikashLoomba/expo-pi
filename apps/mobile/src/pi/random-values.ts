import { polyfillWebCrypto } from 'expo-standard-web-crypto';

// Hermes has no `crypto` global, and Pi generates ids with `crypto.getRandomValues` (pi-ai `utils/uuid`,
// `auth/oauth/pkce`; pi-durable's codemode seed): installed before any Pi module runs.
polyfillWebCrypto();
