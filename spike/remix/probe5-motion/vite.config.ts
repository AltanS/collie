import { defineConfig } from 'vite'

// Probe 5: built once, then served by `vite preview` on 127.0.0.1:5190 (SPA fallback included).
export default defineConfig({
  root: import.meta.dirname,
  oxc: { jsx: { runtime: 'automatic', importSource: 'remix/component' } },
  server: { host: '127.0.0.1', port: 5190, strictPort: true, fs: { allow: ['../../..'] } },
  preview: { host: '127.0.0.1', port: 5190, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2024' },
})
