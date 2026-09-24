const { getDefaultConfig } = require('expo/metro-config');
const { withPi } = require('@automatalabs/expo-pi/metro');

module.exports = withPi(getDefaultConfig(__dirname));
