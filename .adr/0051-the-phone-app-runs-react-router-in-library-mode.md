# 0051 — The phone app runs React Router in library mode

- **Status:** Accepted
- **Date:** 2026-09-21
- **Shipped in:** nothing to ship; this records a standing choice
- **Trail:** `web/src/router.tsx` (`createBrowserRouter`) · `web/src/lib/loaders.ts` · `web/vite.config.ts`
  (the `index.html` transform hook, the playground page, the PWA plugin) · `web/src/sw.ts` ·
  `web/CLAUDE.md` → "Data flows through React Router" · PR #253, whose review asked the question

## Context

**The question was asked on a base-path change.** PR #253 wires a URL prefix through Vite's `base`,
`import.meta.env.BASE_URL` and `basename` on `createBrowserRouter`. Reviewing it, we asked why the app
is not on React Router's **framework mode**, where the router's own Vite plugin owns the build and a
`basename` sits in `react-router.config.ts`. No ADR answered. `web/CLAUDE.md` states data mode as a
fact, and it has been the shape of the app since the first route. This ADR turns the fact into a
decision, so the next reviewer reads the reason instead of asking it again.

**What framework mode is.** `@react-router/dev` becomes the Vite plugin. It owns the entry, generates
the root HTML from a `root.tsx`, builds the route table from a config file or the file tree, renders on
a server by default, and with `ssr: false` emits a static single-page build. It brings typed routes,
route-level code splitting and the config-file `basename`.

**What Collie is.** Eight routes with hand-written loaders (`web/src/lib/loaders.ts`), served from
disk by the Bun bridge, which is also the API. There is no Node render step and no server to render
on. The bridge serves `web/dist` the way it serves any file, with an SPA fallback to `index.html`.

## Decision

**The app stays on React Router in library mode (`createBrowserRouter`), and Collie keeps ownership of
its Vite build and its `index.html`.** Four things the build does today are the argument. Each is a
requirement of the product, not a habit, and framework mode takes the seam each one sits on.

1. **The release `index.html` ships byte for byte.** A transform hook in `web/vite.config.ts`
   rewrites four icon `<link>` hrefs on the dev channel and is a no-op on the release channel. Framework
   mode generates the root document from a component; there is no `index.html` to guarantee.

2. **The playground is a second page in the same build.** `playground.html` is a Vite entry of its
   own on port 5199, and `collie-website` imports its exports by name (`app-screens/main.tsx`), built
   from `collie-tip.ref` inside the website's image. Framework mode builds one app. A second page means
   a second Vite project, and the website's import path moves with it.

3. **The idle lock unmounts and remounts `RouterProvider`.** `router` is created once at module scope
   so the instance keeps the location across that remount and loaders re-run fresh. Framework mode
   owns the entry (`HydratedRouter`); the trick has no place to live.

4. **The service worker is Collie's own `sw.ts`**, built through `vite-plugin-pwa` in `injectManifest`
   mode with `createHandlerBoundToURL` and `NavigationRoute`. The PWA plugin has a separate integration
   for framework mode. That is new ground for the one file that decides whether a phone opens the app
   at all when the bridge is down.

**What is given up, named.** Typed routes, route-level code splitting and the config-file `basename`.
Eight routes and one bundle make the first two small, and the third does not change the shape of the
base-path problem: in either mode the router `basename` must match Vite's `base`, and both are read at
build time. PR #253's gap, that a released binary ships a root build, is the same in both modes.

## Consequences

**A base path is wired by hand at the seam between two libraries**, `base` on one side and
`basename` on the other, because no document joins them in library mode. That is a line in
`vite.config.ts` and a line in `router.tsx`, and PR #253 is where it is done.

**A contributor who proposes framework mode is pointed here.** The four items above are the checklist:
a proposal that keeps the shipped `index.html`, the playground page, the remount and the custom
service worker, or replaces each with something as good, reopens this ADR. One that does not is
declined with this file as the reason, not in the thread.

**What would justify revisiting this.** The playground moving out of `web/` into its own project, or
the bridge growing a render step. Either removes one of the four, and two gone is worth the question
again.
