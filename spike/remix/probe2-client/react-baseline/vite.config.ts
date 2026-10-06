import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('/node_modules/')) return 'vendor'
          if (id.includes('/web/src/lib/')) return 'collie-lib'
        },
      },
    },
  },
})
