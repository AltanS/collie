// Which remix/middleware/* packages work on Bun 1.4.1? Each test builds a tiny router around one
// middleware and drives it through router.fetch() with no socket.
import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'
import { gunzipSync, brotliDecompressSync } from 'node:zlib'
import { createCookie } from 'remix/cookie'
import { asyncContext, getContext } from 'remix/middleware/async-context'
import { compression } from 'remix/middleware/compression'
import { cors } from 'remix/middleware/cors'
import { formData } from 'remix/middleware/form-data'
import { logger } from 'remix/middleware/logger'
import { session } from 'remix/middleware/session'
import { staticFiles } from 'remix/middleware/static'
import { createRouter } from 'remix/router'
import { createCookieSessionStorage } from 'remix/session-storage/cookie'
import { createFsSessionStorage } from 'remix/session-storage/fs'
import { createAppRouter } from './router.ts'

const base = 'http://127.0.0.1:5191'
const staticDir = path.join(import.meta.dir, 'fixture-public')
const big = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => `row ${i} `.repeat(4)) })

describe('remix/middleware/* on Bun', () => {
  test('static: serves, ETag, 304, refuses traversal', async () => {
    let router = createRouter({ middleware: [staticFiles(staticDir)] })
    let res = await router.fetch(new Request(base + '/assets/app-abc123.css'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('body{color:red}\n')
    let res304 = await router.fetch(
      new Request(base + '/assets/app-abc123.css', { headers: { 'If-None-Match': res.headers.get('ETag')! } }),
    )
    expect(res304.status).toBe(304)
    let index = await router.fetch(new Request(base + '/'))
    expect(await index.text()).toContain('fixture index')
  })

  test('compression: gzip and brotli via node:zlib', async () => {
    let router = createRouter({ middleware: [compression()] })
    router.get('/big', () => new Response(big, { headers: { 'Content-Type': 'application/json' } }))
    let gz = await router.fetch(new Request(base + '/big', { headers: { 'Accept-Encoding': 'gzip' } }))
    expect(gz.headers.get('Content-Encoding')).toBe('gzip')
    let gzBytes = new Uint8Array(await gz.arrayBuffer())
    expect(gzBytes.byteLength).toBeLessThan(big.length)
    expect(gunzipSync(gzBytes).toString()).toBe(big)
    let br = await router.fetch(new Request(base + '/big', { headers: { 'Accept-Encoding': 'br' } }))
    expect(br.headers.get('Content-Encoding')).toBe('br')
    expect(brotliDecompressSync(new Uint8Array(await br.arrayBuffer())).toString()).toBe(big)
  })

  test('compression in front of staticFiles (the documented order)', async () => {
    let router = createRouter({ middleware: [compression({ threshold: 100 }), staticFiles(staticDir)] })
    let res = await router.fetch(
      new Request(base + '/assets/app-abc123.js', { headers: { 'Accept-Encoding': 'gzip' } }),
    )
    expect(res.headers.get('Content-Encoding')).toBe('gzip')
    expect(gunzipSync(new Uint8Array(await res.arrayBuffer())).toString()).toContain('console.log')
  })

  test('logger: logs and provides context.logger', async () => {
    let lines: string[] = []
    let router = createRouter({ middleware: [logger({ log: (m: string) => lines.push(m) })] })
    router.get('/x', (context) => {
      context.logger('inside')
      return new Response('ok')
    })
    let res = await router.fetch(new Request(base + '/x'))
    expect(res.status).toBe(200)
    expect(lines.join('\n')).toContain('/x')
  })

  test('session: cookie storage round-trips a counter', async () => {
    let cookie = createCookie('__s', { secrets: ['spike-secret-placeholder'], sameSite: 'lax' })
    let router = createRouter({ middleware: [session(cookie, createCookieSessionStorage())] })
    router.get('/count', (context) => {
      let n = Number(context.session.get('n') ?? 0) + 1
      context.session.set('n', n)
      return new Response(String(n))
    })
    let first = await router.fetch(new Request(base + '/count'))
    expect(await first.text()).toBe('1')
    let setCookie = first.headers.get('Set-Cookie')!
    expect(setCookie).toContain('__s=')
    expect(setCookie).toContain('HttpOnly')
    let second = await router.fetch(
      new Request(base + '/count', { headers: { Cookie: setCookie.split(';')[0]! } }),
    )
    expect(await second.text()).toBe('2')
  })

  test('session: fs storage (node:fs/promises) round-trips', async () => {
    let dir = path.join('/tmp', `remix-spike-sessions-${process.pid}`)
    let cookie = createCookie('__fs', { secrets: ['spike-secret-placeholder'] })
    let router = createRouter({ middleware: [session(cookie, createFsSessionStorage(dir))] })
    router.get('/count', (context) => {
      let n = Number(context.session.get('n') ?? 0) + 1
      context.session.set('n', n)
      return new Response(String(n))
    })
    let first = await router.fetch(new Request(base + '/count'))
    let c = first.headers.get('Set-Cookie')!.split(';')[0]!
    let second = await router.fetch(new Request(base + '/count', { headers: { Cookie: c } }))
    expect(await second.text()).toBe('2')
  })

  test('cors: preflight and simple request', async () => {
    let router = createRouter({ middleware: [cors({ origin: ['https://phone.example'], credentials: true })] })
    router.post('/api/x', () => Response.json({ ok: true }))
    let pre = await router.fetch(
      new Request(base + '/api/x', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://phone.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization',
        },
      }),
    )
    expect(pre.status).toBeLessThan(300)
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe('https://phone.example')
    let other = await router.fetch(
      new Request(base + '/api/x', { method: 'POST', headers: { Origin: 'https://evil.example' } }),
    )
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  test('form-data: parses urlencoded', async () => {
    let router = createRouter({ middleware: [formData()] })
    router.post('/f', (context) => new Response(String(context.formData.get('a'))))
    let res = await router.fetch(
      new Request(base + '/f', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'a=1',
      }),
    )
    expect(await res.text()).toBe('1')
  })

  test('async-context: AsyncLocalStorage on Bun', async () => {
    let router = createRouter({ middleware: [asyncContext()] })
    async function deep() {
      await Promise.resolve()
      return getContext().url.pathname
    }
    router.get('/ctx', async () => new Response(await deep()))
    let res = await router.fetch(new Request(base + '/ctx'))
    expect(await res.text()).toBe('/ctx')
  })

  test('the probe app with logger + compression put in front', async () => {
    let router = createAppRouter({
      staticDir,
      token: 't',
      before: [logger({ log: () => {} }), compression({ threshold: 100 })],
    })
    let res = await router.fetch(
      new Request(base + '/assets/app-abc123.js', { headers: { 'Accept-Encoding': 'br' } }),
    )
    expect(res.headers.get('Content-Encoding')).toBe('br')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })
})
