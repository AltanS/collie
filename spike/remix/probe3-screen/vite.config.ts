import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  root: import.meta.dirname,
  plugins: [tailwindcss()],
  oxc: { jsx: { runtime: 'automatic', importSource: 'remix/component' } },
  server: { host: '127.0.0.1', port: 5195, strictPort: true, fs: { allow: ['../../..'] } },
  build: { outDir: 'dist', emptyOutDir: true },
})
