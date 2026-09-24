const { getDefaultConfig } = require('expo/metro-config');
const withPiNative = require('./metro/with-pi-native.cjs');

module.exports = withPiNative(getDefaultConfig(__dirname));
