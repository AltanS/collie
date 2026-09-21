# 0052 — One build serves any mount

- **Status:** Accepted
- **Date:** 2026-09-21
- **Shipped in:** pending release (M33)
- **Trail:** `bridge/config.ts` (`basePath`, `normaliseBasePath`) · `bridge/server.ts` (`stripMount`,
  `mountIndexHtml`, `serveStatic`) · `web/src/lib/base-path.ts` · `web/vite.config.ts` (`BASE_FOR`,
  `mountReadyShellPlugin`) · `web/src/sw.ts` (`MOUNT`, `under`) · `web/src/lib/sw-routes.ts`
  (`navigationNetworkOnlyUnder`) · `bridge/front-door.ts` (`OwnershipRecord.path`) · `cli/serve.ts` ·
  `cli/doctor.ts` (`front-door`) · PR #253 by @edwinhu, which mapped the places · [ADR 0051](./0051-the-phone-app-runs-react-router-in-library-mode.md)

## Context

**A proxy that gives Collie a path broke it at the first asset.** `tailscale serve --set-path=/collie`
puts several apps on one node, and everything in the app assumed the origin root: the router, every
`/api/*` call, the manifest's `start_url` and `scope`, the fonts, the service worker's precache key and
its notification targets. PR #253 fixed every one of those with a build-time `COLLIE_BASE_PATH`: Vite
`base`, `import.meta.env.BASE_URL`, `basename` on `createBrowserRouter`. Each is the documented
primitive of its layer ([ADR 0051](./0051-the-phone-app-runs-react-router-in-library-mode.md)).

**A build-time value cannot reach the installs people run.** The release payload ships `web/dist`
prebuilt (`.github/workflows/release.yml`), so a binary install can never set it. A checkout can, by
building by hand, and loses it at the next `collie update`, which rebuilds without the operator's
shell. The feature would have served one build path and no released binary.

**The bridge already stands between the file and the phone.** It serves `index.html` from disk with an
SPA fallback, adds the CSP and the build header, and gzips. It reads the instance environment the CLI
writes. It is the one place that knows, at runtime, where this collie is mounted.

**A `<base href>` was the obvious tag and the wrong one.** The CSP carries `base-uri 'none'`, a
deliberate refusal that an injected `<base>` could redirect every relative URL on the page, and two
SVG components paint with `url(#id)`, whose resolution a `<base>` also moves in some engines.

## Decision

**The mount is a runtime setting of the bridge, `COLLIE_BASE_PATH`, and one build serves any mount.**

1. **The shell is root-absolute; the bundle is relative.** Vite's `base` stays `/`, so every
   reference in `index.html` is `/assets/…`, `/theme-init.js`, `/fonts/…`, and `vite preview`, the
   e2e static server and every other root-serving host keep working as they did. Inside the bundle
   nothing names the root: `experimental.renderBuiltUrl` makes every chunk and stylesheet reference
   relative, so a chunk reaches its siblings and assets from `import.meta.url` and a stylesheet from
   its own address, and the same files work under any path. The manifest's `start_url` and `scope`
   are `./`, resolved against the manifest's own address. A build whose shell carries one reference
   that is not root-absolute fails (`mountReadyShellPlugin`), because that shell would mount at the
   root and break under a path, at runtime, on someone else's machine.

2. **Under a mount the bridge resolves the shell when it serves it.** `mountIndexHtml` puts the mount
   in front of every `="/`, `url("/`, `url('/` and `url(/` (never a protocol-relative `//`) and sets
   `<meta name="collie-base" content>` to it. At the root the file goes out as built, byte for byte,
   through the same path as every other file. The gzip cache is keyed by the mount as well as the
   file.

3. **The app reads the mount from that meta tag, once, synchronously.** `lib/base-path.ts` is the one
   reader; `mounted("/api/x")` is how a root-absolute path is spelled for the mount. The router's
   `basename`, `apiFetch`, the service-worker registration (`<mount>sw.js` with the mount as scope),
   the operator font URL, the mux logo URL and the `/auth/` link go through it. `virtual:pwa-register`
   is gone: it registered `${BASE_URL}sw.js`, which under a relative base resolves against the page
   and breaks on a deep route.

4. **The service worker derives its mount from its own address** (`new URL("./", self.location.href)`)
   and puts every root-absolute path it names under it: the precached shell, the navigation denylist
   (`navigationNetworkOnlyUnder`), the font route, the font cache and its sweep, the notification icon,
   badge and tap target. The font cache is named per mount, because two collies mounted on one origin
   share one Cache Storage and each one's sweep would otherwise empty the other's fonts.

5. **The bridge also reads an inbound path that still carries the mount as if it had been stripped.**
   `tailscale serve` strips the mount before it proxies (Go `http.StripPrefix`); a reverse proxy that
   does not is answered correctly rather than with the app shell for `/collie/api/health`. The strip
   removes a known prefix and nothing else, before the crew surface and every gate.

6. **`collie serve` publishes at the mount, and the door is checked there.** The ownership record
   gains a fourth field, the path, absent on a root record so every existing record is unchanged byte
   for byte. Teardown, the publish gate and `doctor`'s `front-door` check read the same path, and
   `doctor` warns when the recorded door and `COLLIE_BASE_PATH` name different mounts. The CLI reads
   the mount with the bridge's own `normaliseBasePath`, so the two cannot disagree by construction.

7. **No manifest `id`.** A manifest `id` is resolved against the origin, so a relative one would name
   the root for every mount. Left out, it defaults to the processed `start_url`: `https://host/` for a
   root install, which is the identity every phone already holds. **This is an invariant:** adding an
   `id`, or a query to `start_url`, mints a new app and orphans every home-screen icon.

## Consequences

**A binary install mounts anywhere with one line in `.env` and a restart.** No rebuild, no flag on
`collie update`, and a checkout keeps the setting across updates because nothing about it is in the
build.

**A mount change is a new app on the phone, and is documented as such.** The installed PWA's scope and
identity are the path it was installed from. Moving a collie from the root to `/collie/`, or back, is a
remove-and-re-add on every phone. The bridge needs only a restart; `collie serve` moves the door on its
own because it tears down the mapping its record names before publishing.

**Three readers, one writer.** The bridge writes the mount into the shell and the URL the service worker
is fetched from; the app and the worker read it back. That holds because both are always served by the
bridge; a cache in front of the bridge that served one mount's `index.html` for another would break
it, and the per-mount gzip key is the bridge's side of that promise.

**At the root nothing changes on the wire.** `index.html` is served as built, byte for byte, and
the rewrite runs only under a mount, deterministically, by a function with a test. The bundle's
internal references are relative where they used to be root-absolute, which no root deployment can
observe.

**What would justify revisiting this.** A proxy that cannot be made to mount a subtree, or an install
kind that serves `web/dist` without the bridge. Either would need the mount to be known at build time
again, and then PR #253's mechanism is the fallback, not a replacement.
