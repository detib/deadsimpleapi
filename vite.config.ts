import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  root: 'src',
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: { port: 5199, strictPort: true },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'chrome130',
    sourcemap: false,
    // One bundle beats split chunks here: it is read from local disk, so
    // fewer requests wins over cacheability we never benefit from.
    chunkSizeWarningLimit: 4000,
  },
})
