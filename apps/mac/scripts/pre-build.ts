// Hutch's preBuild hook: compiles the window's stylesheet with Tailwind, which streamdown's components are styled
// with (its docs: "Streamdown uses Tailwind CSS for styling"), into build-css/, which build.copy places beside the
// page. Hutch's own bundler has no CSS step, so this is the one build step beyond it.
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = Bun.spawnSync(['pnpm', 'exec', 'tailwindcss', '-i', 'src/view/app.css', '-o', 'build-css/app.css',
  '--minify'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
if (result.exitCode !== 0) throw new Error(`Tailwind failed with exit code ${result.exitCode}.`);
