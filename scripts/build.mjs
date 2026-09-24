import esbuild from 'esbuild'
import { rmSync } from 'node:fs'

rmSync('dist-electron', { recursive: true, force: true })

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  minify: true,
  sourcemap: false,
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
}

await esbuild.build({
  ...common,
  entryPoints: ['electron/main.ts'],
  outfile: 'dist-electron/main.cjs',
})

await esbuild.build({
  ...common,
  entryPoints: ['electron/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
})

console.log('[build] electron bundles ready')
