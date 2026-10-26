/**
 * Makes Pi's published modules bundle and run on Hermes without changing their portable code paths.
 *
 * Metro's dependency collector rejects `import(specifier)` when the specifier is not a literal
 * (metro/src/ModuleGraph/worker/collectDependencies.js), even in branches Pi only takes on Node or Bun.
 * Hermes also forwards numeric keys to a Proxy's `getOwnPropertyDescriptor` trap without converting them,
 * and Chord's tracked-array trap accepts string indices only, which breaks its strict-JSON copy of a
 * tracked partial. Both edits are applied here, in Babel, before Metro collects dependencies.
 *
 * Only files inside Pi's packages are touched, and only for iOS and Android client bundles.
 */

const PI_SCOPE = /[/\\]@earendil-works[/\\]/;
const CHORD_JSON = /[/\\]chord[/\\](?:dist[/\\]json\.js|src[/\\]json\.ts)$/;
const HELPER_NAME = '__piUnsupportedDynamicImport';

const HELPER_SOURCE = `
  function ${HELPER_NAME}(specifier) {
    return Promise.reject(new Error(
      "Cannot load " + String(specifier) +
      ": dynamic import with a variable specifier is not available in this Hermes bundle.",
    ));
  }
`;

function isIdentifier(node, name) {
  return node.type === 'Identifier' && node.name === name;
}

/** Metro resolves string-literal specifiers at build time, so those are left alone. */
function isStaticSpecifier(node) {
  if (node === undefined) return false;
  if (node.type === 'StringLiteral') return true;
  return node.type === 'TemplateLiteral' && node.expressions.length === 0;
}

function isPiFile(filename) {
  return typeof filename === 'string' && PI_SCOPE.test(filename);
}

/** Chord's copyJson loop indexes with a number, but its tracked-array trap accepts string keys only. */
function isChordDescriptorCall(node) {
  const { callee, arguments: args } = node;
  return callee.type === 'MemberExpression' && !callee.computed &&
    isIdentifier(callee.object, 'Object') && isIdentifier(callee.property, 'getOwnPropertyDescriptor') &&
    args.length === 2 && isIdentifier(args[0], 'value') && isIdentifier(args[1], 'index');
}

module.exports = function piCompat(api) {
  const t = api.types;
  const template = api.template;
  const platform = api.caller((caller) => caller && caller.platform);

  // Server bundles and every other platform keep Pi's portable imports and its own chord copy.
  if (platform !== 'ios' && platform !== 'android') return { name: 'pi-compat' };

  const filenameOf = (state) => state.file.opts.filename;

  return {
    name: 'pi-compat',
    visitor: {
      CallExpression(path, state) {
        const filename = filenameOf(state);
        if (!isPiFile(filename)) return;
        const { callee, arguments: args } = path.node;
        if (callee.type === 'Import' && !isStaticSpecifier(args[0])) {
          state.piHelperUsed = true;
          path.get('callee').replaceWith(t.identifier(HELPER_NAME));
          return;
        }
        if (CHORD_JSON.test(filename) && isChordDescriptorCall(path.node)) {
          path.get('arguments.1').replaceWith(t.callExpression(t.identifier('String'), [t.identifier('index')]));
        }
      },
      ImportExpression(path, state) {
        if (!isPiFile(filenameOf(state)) || isStaticSpecifier(path.node.source)) return;
        state.piHelperUsed = true;
        path.replaceWith(t.callExpression(t.identifier(HELPER_NAME), [path.node.source]));
      },
      Program: {
        exit(path, state) {
          if (!state.piHelperUsed) return;
          path.pushContainer('body', template.statement(HELPER_SOURCE)());
        },
      },
    },
  };
};
