// The app's `expo lint` covers only apps/mobile, so the package lints itself with the same configuration, plus the
// guard that keeps it host-neutral: Metro also resolves from the app's node_modules, so pnpm's isolation alone would
// let a stray host import bundle.
const { builtinModules } = require('node:module');
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    files: ['src/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        // A group is a gitignore pattern, so a bare `events` would also match `./events`; the slash anchors each name
        // at the start of the specifier, where `/fs` still matches `fs` and `fs/promises`.
        // pi's host adapters are subpaths of the packages allowed here (`env/node`, `chord/sqlite/node`,
        // `storage/sqlite/cloudflare`, …), and they resolve from the package's own peers, so they're named too.
        { group: ['node:*', ...builtinModules.map((name) => `/${name}`), '@earendil-works/**/node',
          '@earendil-works/pi-ai/bun-oauth', '@earendil-works/pi-env'],
          message: 'Node APIs belong in src/node (piece 5).' },
        { group: ['expo', 'expo-*', 'expo/*', '@expo/*', 'react', 'react-native', 'react-native-*', '@osuki-dev/*',
          '@shopify/*', '@strawberrytech/*', 'torch-image-playground', 'just-bash', 'just-bash/*', 'ws',
          '@earendil-works/**/cloudflare', '@earendil-works/pi-durable/storage/indexeddb'],
          message: 'Host APIs stay in the apps.' },
      ] }],
      // no-restricted-imports checks only static declarations, while Metro and esbuild bundle a literal `import()` or
      // `require()` all the same, so those would carry a host module past the guard.
      'no-restricted-syntax': ['error',
        { selector: 'ImportExpression', message: 'Dynamic imports bypass the host guard; import statically.' },
        { selector: "CallExpression[callee.name='require']",
          message: 'require() bypasses the host guard; import statically.' },
      ],
    },
  },
]);
