// The app's `expo lint` covers only apps/mobile, so the package lints itself with the same configuration, plus the
// guard that keeps it host-neutral: Metro also resolves from the app's node_modules, so pnpm's isolation alone would
// let a stray host import bundle. src/node holds the Node implementations of the seams, for the server and the Mac app.
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

const hostApis = {
  group: ['expo', 'expo-*', 'expo/*', '@expo/*', 'react', 'react-native', 'react-native-*', '@osuki-dev/*',
    '@strawberrytech/*', 'just-bash', 'just-bash/*', 'ws', 'buffer'],
  message: 'Host APIs stay in the apps.',
};

module.exports = defineConfig([
  expoConfig,
  {
    files: ['src/**'],
    ignores: ['src/node/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['node:*'], message: 'Node APIs belong in src/node.' },
        { group: ['**/node/*', '@pi-agent/infinichat/node/*'], message: 'src/node is for the Node apps.' },
        hostApis,
      ] }],
    },
  },
  {
    files: ['src/node/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [hostApis] }],
    },
  },
]);
