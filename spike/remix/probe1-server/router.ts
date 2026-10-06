// Probe 1: a Remix 3 fetch router shaped like Collie's bridge, run on Bun.
//
// Two middlewares (security headers on every response, a bearer gate on /api/*), a JSON GET with
// ETag/304, a JSON POST, and static files with an SPA fallback to index.html for extension-less
// paths. Everything is a Web Request -> Response; no Node adapter.

import * as path from 'node:path'
import { object, parseSafe, string } from 'remix/data-schema'
import { IfNoneMatch } from 'remix/headers'
import { openLazyFile } from 'remix/fs'
import { staticFiles } from 'remix/middleware/static'
import { createFileResponse } from 'remix/response/file'
import { createController, createRouter, type Middleware } from 'remix/router'
import { get, post, route } from 'remix/routes'

export const routes = route({
  home: get('/'),
  api: {
    status: get('/api/status'),
    echo: post('/api/echo'),
  },
  spa: get('/*path'),
})

/** Collie's error shape: `{ error: { code } }`. */
export function jsonError(status: number, code: string, headers?: HeadersInit): Response {
  return Response.json({ error: { code } }, { status, headers })
}

/** Sets security headers on every response on the way out, including early static responses. */
export function securityHeaders(): Middleware {
  return async (_context, next) => {
    let response = await next()
    let headers = new Headers(response.headers)
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('Referrer-Policy', 'no-referrer')
    headers.set('X-Frame-Options', 'DENY')
    headers.set(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    )
    // Rebuild instead of mutating: a Response from fetch() or Response.redirect() has immutable headers.
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Gates by `Authorization: Bearer <token>`; answers a JSON 401 in Collie's shape otherwise. */
export function requireBearer(token: string): Middleware {
  return (context, next) => {
    let header = context.request.headers.get('Authorization') ?? ''
    let match = /^Bearer (.+)$/.exec(header)
    if (!match || !timingSafeEqual(match[1]!, token)) {
      return jsonError(401, 'auth.required', { 'WWW-Authenticate': 'Bearer' })
    }
    return next()
  }
}

async function etagOf(body: string): Promise<string> {
  let digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(body))
  let hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  return `"${hex.slice(0, 16)}"`
}

interface AppState {
  panes: number
  lastText: string
  revision: number
}

const EchoBody = object({ text: string() })

export interface AppOptions {
  staticDir: string
  token: string
  /** Extra router middleware placed first (the middleware matrix test uses this). Context-providing
   *  middleware such as logger() carries a transform type, so a plain Middleware[] rejects it. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  before?: Middleware<any>[]
}

export function createAppRouter(options: AppOptions) {
  let staticDir = path.resolve(options.staticDir)
  let state: AppState = { panes: 20, lastText: '', revision: 0 }

  let router = createRouter({
    middleware: [
      ...(options.before ?? []),
      securityHeaders(),
      staticFiles(staticDir, { index: false }),
    ],
  })

  async function sendIndex(request: Request): Promise<Response> {
    let response = await createFileResponse(
      openLazyFile(path.join(staticDir, 'index.html')),
      request,
      { cacheControl: 'no-cache' },
    )
    return response
  }

  router.map(
    routes.api,
    createController(routes.api, {
      middleware: [requireBearer(options.token)],
      actions: {
        async status({ request }) {
          let body = JSON.stringify(state)
          let etag = await etagOf(body)
          let common = { ETag: etag, 'Cache-Control': 'no-cache' }
          // IfNoneMatch.matches() is exact-match only; RFC 9110 wants weak comparison here,
          // so a client echoing W/"..." would miss. Check both spellings (spike finding).
          let ifNoneMatch = IfNoneMatch.from(request.headers.get('If-None-Match'))
          if (ifNoneMatch.matches(etag) || ifNoneMatch.has(`W/${etag}`)) {
            return new Response(null, { status: 304, headers: common })
          }
          return new Response(body, {
            headers: { ...common, 'Content-Type': 'application/json; charset=utf-8' },
          })
        },
        async echo({ request }) {
          let input: unknown
          try {
            input = await request.json()
          } catch {
            return jsonError(400, 'body.invalid_json')
          }
          let body = parseSafe(EchoBody, input)
          if (!body.success) return jsonError(400, 'body.text_required')
          state.lastText = body.value.text
          state.revision++
          return Response.json({ ok: true, revision: state.revision, text: state.lastText })
        },
      },
    }),
  )

  router.map(routes, {
    actions: {
      home({ request }) {
        return sendIndex(request)
      },
      spa({ request, params }) {
        let rest = params.path
        if (rest === 'api' || rest.startsWith('api/')) return jsonError(404, 'route.not_found')
        let last = rest.split('/').pop() ?? ''
        if (last.includes('.')) return new Response('Not Found', { status: 404 })
        return sendIndex(request)
      },
    },
  })

  return router
}
