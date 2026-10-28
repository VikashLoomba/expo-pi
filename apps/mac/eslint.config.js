// The same configuration as the workspace's other projects; Hutch's generated state and the builds are not source.
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  { ignores: ['.hutch/**', 'build/**', 'artifacts/**', 'node_modules/**'] },
  // shadcn's components come from its registry as they are; their style is the registry's.
  {
    files: ['src/view/components/ui/**', 'src/view/hooks/use-mobile.ts', 'src/view/hooks/use-highlighted-code.ts',
      'src/view/lib/highlighter.tsx'],
    rules: { '@typescript-eslint/array-type': 'off', eqeqeq: 'off', 'react-hooks/set-state-in-effect': 'off' },
  },
]);
