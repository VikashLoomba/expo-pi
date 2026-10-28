// The same configuration as the workspace's other projects; the built bundle and the daemons are not source.
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([expoConfig, { ignores: ['assets/**', 'node_modules/**'] }]);
