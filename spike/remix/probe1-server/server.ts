// Real listener for probe 1. Binds 127.0.0.1 only. STATIC_DIR picks the directory to serve
// (probe 2's dist/ for the browser probes), PORT defaults to 5191.
import * as path from 'node:path'
import { createAppRouter } from './router.ts'

let staticDir = process.env.STATIC_DIR ?? path.join(import.meta.dir, 'fixture-public')
let port = Number(process.env.PORT ?? 5191)
// Placeholder, not a secret: the spike never runs outside localhost.
let token = process.env.SPIKE_TOKEN ?? 'spike-token-placeholder'

let router = createAppRouter({ staticDir, token })

let server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
    try {
      return await router.fetch(request)
    } catch (error) {
      console.error(error)
      return new Response('Internal Server Error', { status: 500 })
    }
  },
})

console.log(`probe1 listening on http://${server.hostname}:${server.port} serving ${staticDir}`)
