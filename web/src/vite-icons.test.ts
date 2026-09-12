import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PLAYGROUND_ICON_LINKS,
  channelFor,
  iconLinksFor,
  includeAssetsFor,
  manifestFor,
  precacheIgnoresFor,
  transformIndexIcons,
} from "../vite-icons";

// These are the pure helpers vite.config.ts's VitePWA options and transformIndexHtml plugin are
// built from (see the config's `channel` derivation). Testing them here — rather than running a
// real Vite build — is what lets this suite run under plain Vitest: vite.config.ts is the only
// file that imports `vite`/`vite-plugin-pwa`, and this module imports neither.

describe("channelFor", () => {
  it("no git at all (head null): a tarball or packaged build, release", () => {
    expect(channelFor({ head: null, tagCommit: null, tagCount: null })).toBe("release");
  });

  it("git works but holds no tags at all: the shallow detached install, release", () => {
    expect(channelFor({ head: "abc123", tagCommit: null, tagCount: 0 })).toBe("release");
  });

  it("tags exist and the version's tag matches HEAD: a real release checkout", () => {
    expect(channelFor({ head: "abc123", tagCommit: "abc123", tagCount: 3 })).toBe("release");
  });

  it("tags exist but the version's tag is missing: dev checkout on an untagged commit", () => {
    // This is the case that shipped 1.8.1 as "release" before v1.8.1 was tagged.
    expect(channelFor({ head: "abc123", tagCommit: null, tagCount: 3 })).toBe("dev");
  });

  it("tags exist but the version's tag points elsewhere: dev", () => {
    expect(channelFor({ head: "abc123", tagCommit: "def456", tagCount: 3 })).toBe("dev");
  });
});

describe("iconLinksFor", () => {
  it("release: names the original, undecorated icon files", () => {
    const links = iconLinksFor("release");
    expect(links.map((l) => l.href)).toEqual([
      "/favicon-96x96.png",
      "/favicon.svg",
      "/favicon.ico",
      "/apple-touch-icon.png",
    ]);
  });

  it("dev: names the -dev icon files, one per release link, same order", () => {
    const release = iconLinksFor("release");
    const dev = iconLinksFor("dev");
    expect(dev).toHaveLength(release.length);
    expect(dev.map((l) => l.href)).toEqual([
      "/favicon-dev-96x96.png",
      "/favicon-dev.svg",
      "/favicon-dev.ico",
      "/apple-touch-icon-dev.png",
    ]);
    // rel/type/sizes travel unchanged — only the href moves.
    dev.forEach((l, i) => {
      expect(l.rel).toBe(release[i]?.rel);
      expect(l.type).toBe(release[i]?.type);
      expect(l.sizes).toBe(release[i]?.sizes);
    });
  });
});

describe("manifestFor", () => {
  it("release: names Collie and the original manifest tiles", () => {
    const manifest = manifestFor("release");
    expect(manifest.name).toBe("Collie");
    expect(manifest.short_name).toBe("Collie");
    expect(manifest.icons.map((i) => i.src)).toEqual([
      "/web-app-manifest-192x192.png",
      "/web-app-manifest-512x512.png",
    ]);
  });

  it("dev: names Collie (dev) and the -dev manifest tiles", () => {
    const manifest = manifestFor("dev");
    expect(manifest.name).toBe("Collie (dev)");
    expect(manifest.short_name).toBe("Collie dev");
    expect(manifest.icons.map((i) => i.src)).toEqual([
      "/web-app-manifest-dev-192x192.png",
      "/web-app-manifest-dev-512x512.png",
    ]);
  });

  it("keeps sizes/type/purpose identical across channels — only src changes", () => {
    const release = manifestFor("release").icons;
    const dev = manifestFor("dev").icons;
    dev.forEach((icon, i) => {
      expect(icon.sizes).toBe(release[i]?.sizes);
      expect(icon.type).toBe(release[i]?.type);
      expect(icon.purpose).toBe(release[i]?.purpose);
    });
  });
});

describe("includeAssetsFor", () => {
  it("dev lists the -dev favicon files instead of the release ones", () => {
    expect(includeAssetsFor("dev")).toEqual([
      "favicon-dev.svg",
      "favicon-dev.ico",
      "favicon-dev-96x96.png",
      "apple-touch-icon-dev.png",
    ]);
  });
});

describe("transformIndexIcons — the release build stays byte-identical", () => {
  const indexHtml = readFileSync(resolve(import.meta.dirname, "../index.html"), "utf8");

  it("release: returns index.html completely unchanged", () => {
    expect(transformIndexIcons(indexHtml, "release")).toBe(indexHtml);
  });

  it("dev: rewrites all four icon hrefs to the -dev files, nothing else", () => {
    const out = transformIndexIcons(indexHtml, "dev");
    expect(out).toContain('href="/favicon-dev-96x96.png"');
    expect(out).toContain('href="/favicon-dev.svg"');
    expect(out).toContain('href="/favicon-dev.ico"');
    expect(out).toContain('href="/apple-touch-icon-dev.png"');
    // The originals are gone, not merely joined by the dev ones.
    expect(out).not.toContain('href="/favicon-96x96.png"');
    expect(out).not.toContain('href="/favicon.svg"');
    expect(out).not.toContain('href="/favicon.ico"');
    expect(out).not.toContain('href="/apple-touch-icon.png"');
    // Everything past the four <link> tags is untouched (e.g. the title, the boot splash CSS).
    expect(out).toContain("<title>Collie</title>");
  });
});

describe("the states playground wears its own red icon set", () => {
  const playgroundHtml = readFileSync(resolve(import.meta.dirname, "../playground.html"), "utf8");

  it("PLAYGROUND_ICON_LINKS names the -playground files", () => {
    expect(PLAYGROUND_ICON_LINKS.map((l) => l.href)).toEqual([
      "/favicon-playground.svg",
      "/favicon-playground.ico",
      "/favicon-playground-96x96.png",
    ]);
  });

  it("playground.html links every -playground file directly, unconditionally", () => {
    for (const link of PLAYGROUND_ICON_LINKS) {
      expect(playgroundHtml).toContain(`href="${link.href}"`);
    }
    // No manifest link, no apple-touch-icon — the file header says why (no install, no SW).
    expect(playgroundHtml).not.toContain('rel="manifest"');
    expect(playgroundHtml).not.toContain("apple-touch-icon");
  });
});

describe("precacheIgnoresFor — a channel's precache carries only its own icons", () => {
  const releaseFiles = [
    ...includeAssetsFor("release"),
    ...manifestFor("release").icons.map((i) => i.src.replace(/^\//, "")),
  ];
  const devFiles = [
    ...includeAssetsFor("dev"),
    ...manifestFor("dev").icons.map((i) => i.src.replace(/^\//, "")),
  ];
  const playgroundFiles = PLAYGROUND_ICON_LINKS.map((l) => l.href.replace(/^\//, ""));

  it("release ignores every dev file and no release file", () => {
    const ignores = precacheIgnoresFor("release");
    for (const file of devFiles) expect(ignores).toContain(file);
    for (const file of releaseFiles) expect(ignores).not.toContain(file);
  });

  it("release ignores every playground file", () => {
    const ignores = precacheIgnoresFor("release");
    for (const file of playgroundFiles) expect(ignores).toContain(file);
  });

  it("dev ignores every release file and no dev file", () => {
    const ignores = precacheIgnoresFor("dev");
    for (const file of releaseFiles) expect(ignores).toContain(file);
    for (const file of devFiles) expect(ignores).not.toContain(file);
  });

  it("dev ignores every playground file", () => {
    const ignores = precacheIgnoresFor("dev");
    for (const file of playgroundFiles) expect(ignores).toContain(file);
  });

  it("never ignores index.html, sw.js or the JS/CSS asset bundle, in either channel", () => {
    for (const channel of ["release", "dev"] as const) {
      const ignores = precacheIgnoresFor(channel);
      expect(ignores).not.toContain("index.html");
      expect(ignores).not.toContain("sw.js");
      expect(ignores).not.toContain("assets/**");
    }
  });
});
