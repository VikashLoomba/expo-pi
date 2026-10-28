// @hutch cli=0.28.2 cottontail=0.7.3
// The workspace's pnpm owns the dependencies and the lockfile; Hutch owns the Electrobun release and the builds.
export default {
  electrobun: { version: '2.0.5' },
  packageManager: 'pnpm',
  scripts: {
    dev: ['hutch', 'electrobun', 'dev', '--watch'],
    'build:dev': ['hutch', 'electrobun', 'build', '--env=dev'],
    build: ['hutch', 'electrobun', 'build', '--env=stable'],
  },
};
