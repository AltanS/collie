import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'
import { createAppRouter } from './router.ts'

const staticDir = path.join(import.meta.dir, 'fixture-public')
const token = 'test-token-placeholder'
const base = 'http://127.0.0.1:5191'
const auth = { Authorization: `Bearer ${token}` }

function app() {
  return createAppRouter({ staticDir, token })
}

describe('probe 1: Remix router on Bun, no socket', () => {
  test('security headers on every response, including static and 401', async () => {
    let router = app()
    for (let [url, init] of [
      ['/api/status', {}],
      ['/api/status', { headers: auth }],
      ['/assets/app-abc123.css', {}],
      ['/pane/7', {}],
    ] as const) {
      let res = await router.fetch(new Request(base + url, init))
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
      expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
    }
  })

  test('bearer gate: missing and wrong token give Collie-shaped JSON 401', async () => {
    let router = app()
    let attempts: HeadersInit[] = [{}, { Authorization: 'Bearer nope' }, { Authorization: 'Basic x' }]
    for (let headers of attempts) {
      let res = await router.fetch(new Request(base + '/api/status', { headers }))
      expect(res.status).toBe(401)
      expect(res.headers.get('Content-Type')).toContain('application/json')
      expect(res.headers.get('WWW-Authenticate')).toBe('Bearer')
      expect(await res.json()).toEqual({ error: { code: 'auth.required' } })
    }
    let post = await router.fetch(
      new Request(base + '/api/echo', { method: 'POST', body: '{"text":"x"}' }),
    )
    expect(post.status).toBe(401)
  })

  test('GET JSON with ETag, 304 on If-None-Match, new ETag after a POST', async () => {
    let router = app()
    let first = await router.fetch(new Request(base + '/api/status', { headers: auth }))
    expect(first.status).toBe(200)
    let etag = first.headers.get('ETag')!
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/)
    expect(await first.json()).toEqual({ panes: 20, lastText: '', revision: 0 })

    let cached = await router.fetch(
      new Request(base + '/api/status', { headers: { ...auth, 'If-None-Match': etag } }),
    )
    expect(cached.status).toBe(304)
    expect(cached.headers.get('ETag')).toBe(etag)
    expect(await cached.text()).toBe('')

    let weak = await router.fetch(
      new Request(base + '/api/status', { headers: { ...auth, 'If-None-Match': `W/${etag}` } }),
    )
    expect(weak.status).toBe(304)

    let posted = await router.fetch(
      new Request(base + '/api/echo', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      }),
    )
    expect(posted.status).toBe(200)
    expect(await posted.json()).toEqual({ ok: true, revision: 1, text: 'hello' })

    let after = await router.fetch(
      new Request(base + '/api/status', { headers: { ...auth, 'If-None-Match': etag } }),
    )
    expect(after.status).toBe(200)
    expect(after.headers.get('ETag')).not.toBe(etag)
  })

  test('POST rejects bad JSON and wrong shape with JSON 400', async () => {
    let router = app()
    let bad = await router.fetch(
      new Request(base + '/api/echo', { method: 'POST', headers: auth, body: '{nope' }),
    )
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: { code: 'body.invalid_json' } })
    let wrongType = await router.fetch(
      new Request(base + '/api/echo', { method: 'POST', headers: auth, body: '{"text":1}' }),
    )
    expect(await wrongType.json()).toEqual({ error: { code: 'body.text_required' } })
  })

  test('GET on a POST-only API path falls through to the less specific /*path route', async () => {
    // fetch-router falls through to a less specific route that handles the method before it
    // answers 405, so GET /api/echo reaches the SPA catch-all, which answers a JSON 404.
    let res = await app().fetch(new Request(base + '/api/echo', { headers: auth }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: { code: 'route.not_found' } })
  })

  test('static files: served with ETag; conditional GET gives 304; range gives 206', async () => {
    let router = app()
    let res = await router.fetch(new Request(base + '/assets/app-abc123.js'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('javascript')
    let etag = res.headers.get('ETag')
    expect(etag).toBeTruthy()
    let again = await router.fetch(
      new Request(base + '/assets/app-abc123.js', { headers: { 'If-None-Match': etag! } }),
    )
    expect(again.status).toBe(304)
    // Ranges are on only for non-compressible types (createFileResponse default), so a JS file
    // answers 200 to a Range request and a binary answers 206.
    let jsRange = await router.fetch(
      new Request(base + '/assets/app-abc123.js', { headers: { Range: 'bytes=0-9' } }),
    )
    expect(jsRange.status).toBe(200)
    let range = await router.fetch(
      new Request(base + '/assets/blob.png', { headers: { Range: 'bytes=0-9' } }),
    )
    expect(range.status).toBe(206)
    expect((await range.arrayBuffer()).byteLength).toBe(10)
  })

  test('SPA fallback: extension-less paths get index.html, missing files with an extension 404', async () => {
    let router = app()
    for (let url of ['/', '/pane/7', '/settings/updates']) {
      let res = await router.fetch(new Request(base + url))
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toContain('text/html')
      expect(await res.text()).toContain('fixture index')
    }
    let missing = await router.fetch(new Request(base + '/assets/missing.js'))
    expect(missing.status).toBe(404)
    let api = await router.fetch(new Request(base + '/api/nothing', { headers: auth }))
    expect(api.status).toBe(404)
    expect(await api.json()).toEqual({ error: { code: 'route.not_found' } })
  })

  test('path traversal is refused by staticFiles and the fallback', async () => {
    let res = await app().fetch(new Request(base + '/..%2f..%2fpackage.json'))
    expect(res.status).not.toBe(200)
    let res2 = await app().fetch(new Request(base + '/assets/../../router.ts'))
    expect(await res2.text()).not.toContain('createAppRouter')
  })
})
