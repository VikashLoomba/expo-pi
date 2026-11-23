// The same configuration as the workspace's other projects; the built modules, the runtime's packages and the
// daemons are not source. Its React rules ask which React they lint for and look for the package, which the server
// does not have, so each run warned that it found none: it is named, the apps'.
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  { settings: { react: { version: '19.3.0' } } },
  { ignores: ['assets/**', 'dist/**', 'runtime/**', 'node_modules/**'] },
]);
