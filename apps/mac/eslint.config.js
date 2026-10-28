// The same configuration as the workspace's other projects; Hutch's generated state and the builds are not source.
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  { ignores: ['.hutch/**', 'build/**', 'artifacts/**', 'node_modules/**'] },
]);
