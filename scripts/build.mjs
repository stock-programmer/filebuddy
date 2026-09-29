import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/ui', { recursive: true });
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  target: 'node24',
});
await build({
  entryPoints: ['src/app/controller.ts'],
  outfile: 'dist/backend.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  target: 'node24',
});
await build({
  entryPoints: ['src/desktop/preload.ts'],
  outfile: 'dist/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  target: 'node24',
});
await build({
  entryPoints: ['src/ui/app.ts'],
  outfile: 'dist/ui/app.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome130',
});
await copyFile('src/ui/index.html', 'dist/ui/index.html');
await copyFile('src/ui/styles.css', 'dist/ui/styles.css');
console.log('Build complete.');
