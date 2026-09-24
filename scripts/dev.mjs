import esbuild from 'esbuild'
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import electronPath from 'electron'

const PORT = 5199

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  sourcemap: 'inline',
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"development"' },
}

const server = await createServer()
await server.listen(PORT)
console.log(`[dev] renderer on http://localhost:${PORT}`)

let child = null
let restarting = false

function launch() {
  if (child) {
    child.removeAllListeners('exit')
    child.kill()
  }
  child = spawn(electronPath, ['.'], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: `http://localhost:${PORT}`, NODE_ENV: 'development' },
  })
  child.on('exit', (code) => {
    if (!restarting) {
      server.close()
      process.exit(code ?? 0)
    }
  })
}

const reload = {
  name: 'relaunch',
  setup(build) {
    build.onEnd((r) => {
      if (r.errors.length) return console.error('[dev] build failed')
      restarting = true
      launch()
      setTimeout(() => (restarting = false), 200)
    })
  },
}

const mainCtx = await esbuild.context({
  ...common,
  entryPoints: ['electron/main.ts'],
  outfile: 'dist-electron/main.cjs',
  plugins: [reload],
})
const preCtx = await esbuild.context({
  ...common,
  entryPoints: ['electron/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
})

await preCtx.watch()
await mainCtx.watch()

process.on('SIGINT', () => {
  restarting = false
  child?.kill()
  server.close()
  process.exit(0)
})
