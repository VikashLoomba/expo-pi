// The same configuration as the workspace's other projects; the built modules, the runtime's packages and the
// daemons are not source.
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([expoConfig, { ignores: ['assets/**', 'dist/**', 'runtime/**', 'node_modules/**'] }]);
