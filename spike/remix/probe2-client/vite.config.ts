import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  root: import.meta.dirname,
  plugins: [tailwindcss()],
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'remix/component' },
  },
  server: { host: '127.0.0.1', port: 5192, strictPort: true, fs: { allow: ['../../..'] } },
  preview: { host: '127.0.0.1', port: 5192, strictPort: true },
  build: {
    outDir: process.env.SPLIT_VENDOR ? 'dist-split' : 'dist',
    emptyOutDir: true,
    // SPLIT_VENDOR=1 only measures how much of the entry is the Remix runtime.
    rollupOptions: process.env.SPLIT_VENDOR
      ? {
          output: {
            manualChunks(id: string) {
              if (id.includes('/node_modules/')) return 'vendor'
              if (id.includes('/web/src/lib/')) return 'collie-lib'
            },
          },
        }
      : {},
  },
})
