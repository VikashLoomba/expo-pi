const path = require('node:path');
const { Buffer } = require('node:buffer');
const { adaptBashBrowser, isBashBrowser, BROWSER_SHA256 } = require('./browser-compat.cjs');

function upstream(config, projectRoot) {
  const configured = config.piBashUpstreamTransformerPath;
  if (typeof configured !== 'string') throw new Error('The bash transformer must be configured by metro.config.js');
  return require(path.resolve(projectRoot, configured));
}

exports.transform = async function transform(config, projectRoot, filename, data, options) {
  if (isBashBrowser(filename)) {
    data = Buffer.from(adaptBashBrowser(data.toString('utf8'), path.resolve(projectRoot, 'src/pi/bash/engine/native-crypto.ts')));
  }
  return upstream(config, projectRoot).transform(config, projectRoot, filename, data, options);
};

exports.getCacheKey = function getCacheKey(config, options) {
  return `${upstream(config, options.projectRoot).getCacheKey?.(config, options) ?? ''}:pi-bash-v3:${BROWSER_SHA256}`;
};
