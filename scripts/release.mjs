// Builds the publishable npm package in release/: the server, core and facts bundled into one file (release/dist), the
// built viewer (release/viewer), README and LICENSE. Third-party packages stay normal dependencies, pinned to the
// versions the workspaces use, so npm installs the right per-platform parser builds.
//   node scripts/release.mjs          build release/
//   cd release && npm pack            try the package
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'release');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

// Every runtime dependency of the bundled workspaces, except the workspaces themselves and tsx (only the dev bin uses it).
const deps = {};
for (const ws of ['facts', 'core', 'server']) {
  for (const [name, version] of Object.entries(read(`packages/${ws}/package.json`).dependencies ?? {})) {
    if (name.startsWith('@illuminate/') || name === 'tsx') continue;
    if (deps[name] && deps[name] !== version) throw new Error(`${name} is pinned to ${deps[name]} and ${version}`);
    deps[name] = version;
  }
}

execSync('npm run build', { cwd: root, stdio: 'inherit' });
fs.rmSync(path.join(out, 'dist'), { recursive: true, force: true });
fs.rmSync(path.join(out, 'viewer'), { recursive: true, force: true });

await build({
  entryPoints: [path.join(root, 'packages/server/src/cli.ts')],
  outfile: path.join(out, 'dist/cli.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: Object.keys(deps).flatMap((d) => [d, `${d}/*`]),
  // Bundled ESM still meets packages that call require(); give it one.
  banner: { js: "import { createRequire as __illuminateRequire } from 'node:module'; const require = __illuminateRequire(import.meta.url);" },
  logLevel: 'info',
});

fs.cpSync(path.join(root, 'packages/viewer/dist'), path.join(out, 'viewer'), { recursive: true });
fs.copyFileSync(path.join(root, 'README.md'), path.join(out, 'README.md'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));

const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
pkg.dependencies = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`release/ is ready: ${pkg.name}@${pkg.version}`);
