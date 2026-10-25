// Pure helpers behind the per-channel icon story (CHANGELOG "A dev build wears an orange icon").
// No `vite` import here on purpose: `vite.config.ts` imports this module to build the real
// `VitePWA` options and the `transformIndexHtml` rewrite, and `src/vite-icons.test.ts` imports the
// same functions to assert the release/dev/playground shapes without running a Vite build. Keeping
// this file dependency-free is what makes that second import cheap.
//
// The release shapes below are BYTE-IDENTICAL to what `index.html` and the manifest already
// declared before channels existed — the release build must render no diff at all.

export type Channel = "release" | "dev";

// The evidence vite.config.ts gathers about the checkout, each field independently nullable when
// the underlying git call fails. `channelFor` is the pure decision behind `isReleaseBuild` — see
// vite.config.ts for why the three shapes below exist and how this evidence is collected.
export interface ChannelEvidence {
  readonly head: string | null;
  readonly tagCommit: string | null;
  readonly tagCount: number | null;
}

/**
 * The build channel for a checkout, from three facts about its git state. A checkout is one of
 * three shapes, checked in order:
 *
 * 1. No git at all (`head` is null): a tarball or packaged build with no `.git` directory. Builds
 *    as release, the same fallback the old catch-all gave.
 * 2. Git works but the checkout holds no tags at all (`tagCount` is 0): the shallow, detached
 *    checkout `herdr plugin install` leaves behind. It never fetched any tag, release or not, so
 *    an empty tag list is expected there, not a sign of a dev tree. Builds as release.
 * 3. Git works and tags exist: this is a real dev checkout, so the version's own tag decides. Its
 *    commit matching HEAD means the checkout sits on a cut, tagged release; anything else,
 *    including a missing tag for this version, is dev.
 */
export function channelFor(evidence: ChannelEvidence): Channel {
  if (evidence.head === null) return "release";
  if (evidence.tagCount === 0) return "release";
  if (evidence.tagCommit !== null && evidence.tagCommit === evidence.head) return "release";
  return "dev";
}

export interface IconLink {
  readonly rel: string;
  readonly href: string;
  readonly type?: string;
  readonly sizes?: string;
}

// Order matches the four `<link>` tags in index.html — kept as arrays (not a Map) so
// `transformIndexIcons` can zip release ↔ dev by index.
const RELEASE_ICON_LINKS: readonly IconLink[] = [
  { rel: "icon", type: "image/png", href: "/favicon-96x96.png", sizes: "96x96" },
  { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
  { rel: "shortcut icon", href: "/favicon.ico" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png", sizes: "180x180" },
];

const DEV_ICON_LINKS: readonly IconLink[] = [
  { rel: "icon", type: "image/png", href: "/favicon-dev-96x96.png", sizes: "96x96" },
  { rel: "icon", type: "image/svg+xml", href: "/favicon-dev.svg" },
  { rel: "shortcut icon", href: "/favicon-dev.ico" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon-dev.png", sizes: "180x180" },
];

/** The four `<link>` icon tags index.html should carry for this channel. */
export function iconLinksFor(channel: Channel): readonly IconLink[] {
  return channel === "dev" ? DEV_ICON_LINKS : RELEASE_ICON_LINKS;
}

const RELEASE_INCLUDE_ASSETS: readonly string[] = [
  "favicon.svg",
  "favicon.ico",
  "favicon-96x96.png",
  "apple-touch-icon.png",
];

const DEV_INCLUDE_ASSETS: readonly string[] = [
  "favicon-dev.svg",
  "favicon-dev.ico",
  "favicon-dev-96x96.png",
  "apple-touch-icon-dev.png",
];

/** The `VitePWA({ includeAssets })` list for this channel. A fresh mutable array each call — the
 *  plugin option's own type is `string[]`, not `readonly string[]`. */
export function includeAssetsFor(channel: Channel): string[] {
  return [...(channel === "dev" ? DEV_INCLUDE_ASSETS : RELEASE_INCLUDE_ASSETS)];
}

export interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose: string;
}

export interface ChannelManifest {
  readonly name: string;
  readonly short_name: string;
  readonly icons: readonly ManifestIcon[];
}

const RELEASE_MANIFEST: ChannelManifest = {
  name: "Collie",
  short_name: "Collie",
  icons: [
    { src: "/web-app-manifest-192x192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/web-app-manifest-512x512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
};

// Same dark polarity as the release tiles (vite.config.ts's long comment above `icons` explains
// why the tile must stay dark) — only the paint and the name change, so an operator who installs
// both a release and a dev build still recognises the app family at a glance.
const DEV_MANIFEST: ChannelManifest = {
  name: "Collie (dev)",
  short_name: "Collie dev",
  icons: [
    { src: "/web-app-manifest-dev-192x192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/web-app-manifest-dev-512x512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
};

/** The manifest `name`/`short_name`/`icons` for this channel. Everything else in the manifest
 *  (`id`, `start_url`, `scope`, colours, …) stays fixed across channels — see vite.config.ts. */
export function manifestFor(channel: Channel): ChannelManifest {
  return channel === "dev" ? DEV_MANIFEST : RELEASE_MANIFEST;
}

/** The states playground wears its own red set — no manifest, no service worker, so just the
 *  three direct `<link>` tags playground.html carries. */
export const PLAYGROUND_ICON_LINKS: readonly IconLink[] = [
  { rel: "icon", type: "image/svg+xml", href: "/favicon-playground.svg" },
  { rel: "shortcut icon", href: "/favicon-playground.ico" },
  { rel: "icon", type: "image/png", href: "/favicon-playground-96x96.png", sizes: "96x96" },
];

// The bare (no leading "/") filenames for one channel's icons, derived from the same lists
// `includeAssetsFor`/`manifestFor` build from — so a new icon added to either list is picked up
// here for free, and the two can never drift apart.
function channelIconFiles(channel: Channel): string[] {
  const includeAssets = channel === "dev" ? DEV_INCLUDE_ASSETS : RELEASE_INCLUDE_ASSETS;
  const manifest = channel === "dev" ? DEV_MANIFEST : RELEASE_MANIFEST;
  return [...includeAssets, ...manifest.icons.map((icon) => icon.src.replace(/^\//, ""))];
}

// The playground's own files, by the same derivation from PLAYGROUND_ICON_LINKS, plus its HTML
// entry and a wildcard for any asset named after it — the playground never builds into `dist`
// today (it's a dev-only Vite server, see playground.html's own header), but a precache ignore
// list is cheap insurance against that changing silently.
function playgroundFiles(): string[] {
  return [
    ...PLAYGROUND_ICON_LINKS.map((link) => link.href.replace(/^\//, "")),
    "playground.html",
    "playground-*",
  ];
}

/**
 * The workbox `globIgnores` for this channel's precache: every icon file that belongs to a
 * DIFFERENT channel, plus everything playground. A release build's service worker has no
 * business precaching the dev tiles or the playground's red icon set, and vice versa — every
 * byte of that precache competes with the app's own polls on a slow link.
 */
export function precacheIgnoresFor(channel: Channel): string[] {
  const otherChannel: Channel = channel === "dev" ? "release" : "dev";
  return [...channelIconFiles(otherChannel), ...playgroundFiles()];
}

/**
 * Rewrite index.html's icon `<link>` hrefs for `channel`. A release channel returns `html`
 * unchanged — byte-identical is the point, not merely equivalent. A dev channel swaps each
 * RELEASE_ICON_LINKS href for its DEV_ICON_LINKS counterpart, by position; index.html's markup
 * (rel/type/sizes attributes) is left alone, only the `href="…"` value moves.
 */
export function transformIndexIcons(html: string, channel: Channel): string {
  if (channel === "release") return html;
  let out = html;
  for (const [i, devLink] of DEV_ICON_LINKS.entries()) {
    const releaseHref = RELEASE_ICON_LINKS[i]?.href;
    if (releaseHref === undefined) continue;
    out = out.replaceAll(`href="${releaseHref}"`, `href="${devLink.href}"`);
  }
  return out;
}

/**
 * The largest single file the service worker's precache accepts (Workbox's
 * `injectManifest.maximumFileSizeToCacheInBytes`). The main chunk `assets/index-*.js` must stay
 * inside it: a chunk over the limit is left out of the precache, and Workbox then fails the build
 * (that is the only reason it is loud), because an uncached main chunk breaks offline reading
 * (M46).
 *
 * Measured main chunk, minified and ungzipped, in bytes:
 *   1.21.0   1,621,690
 *   1.22.0   1,814,958
 *   1.23.x   1,948,674
 *   edge.5   2,026,635
 *   1.24.1   2,101,583 (2026-10-25, int/1.24.1 f653954ad; 325218dcd was 2,095,645, 1.5 kB under
 *            the old 2 MiB default, so one merge of ordinary code, +5.9 kB, tipped it over)
 * The growth is organic: the 2026-10-25 source-map attribution found no wrong import, no test
 * fixture and no node-only module in the chunk, and the message catalogs other than English are
 * already their own lazy chunks. The chunk has grown about 100 to 150 kB a minor release.
 *
 * 3 MiB leaves room for roughly seven minor releases at that rate. Before it is raised again, run
 * `bunx vite build --sourcemap --outDir /tmp/x` and look at what grew; the English catalog
 * (`en.ts`, ~150 kB) and `react-router`'s `development` build (~94 kB) are the two large
 * candidates for a split.
 */
export const PRECACHE_MAX_FILE_BYTES = 3 * 1024 * 1024;
