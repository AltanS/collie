import { useEffect, useState } from "react";

import { fetchAuthedBytes } from "@/lib/api";

// ── A BRIDGE SUBRESOURCE, LOADED WITH THE PAIRING TOKEN (ADR 0086) ───────────────────────────────
//
// Reads need the pairing token, and the bridge serves three things a page would naturally load by
// URL: a journal picture (`/api/blobs/<hash>`), the multiplexer's mark (`/api/mux/logo.svg`) and an
// operator font (`/api/fonts/<name>`). An `<img src>` or a CSS `url()` cannot carry an
// `Authorization` header, so each of them would now answer 403. This module fetches the bytes with
// the token (lib/api.ts `fetchAuthedBytes`) and hands the page an object URL instead.
//
// ONE OBJECT URL PER PATH, FOR THE PAGE. A blob is content-addressed and the mark is one file, so the
// bytes behind a path do not change while the page lives; asking twice would only cost a second
// download. The table is bounded: the oldest entry is dropped and its URL revoked past the cap, which
// on a phone is far beyond the pictures one session shows. A failed load is not kept, so the next
// render asks again (after pairing, say).
//
// `data:` URLs are already the bytes and pass through untouched.

const CACHE_MAX = 64;
const cache = new Map<string, Promise<string>>();

function remember(path: string, url: Promise<string>): void {
  cache.set(path, url);
  if (cache.size <= CACHE_MAX) return;
  const oldest = cache.keys().next().value;
  if (oldest === undefined) return;
  const evicted = cache.get(oldest);
  cache.delete(oldest);
  void evicted?.then((u) => URL.revokeObjectURL(u)).catch(() => undefined);
}

/**
 * An object URL for a root-absolute `/api/...` path, fetched once with the token. Rejects when the
 * bridge refuses or the network fails; nothing is cached then.
 */
export function authedObjectUrl(path: string): Promise<string> {
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  const pending = fetchAuthedBytes(path).then((blob) => URL.createObjectURL(blob));
  remember(path, pending);
  pending.catch(() => {
    if (cache.get(path) === pending) cache.delete(path);
  });
  return pending;
}

/** What a component renders: the URL once it is ready, and whether the load failed. */
export interface AuthedUrl {
  url: string | null;
  failed: boolean;
}

/**
 * The displayable URL for `src`: itself for a `data:` URL, an object URL for an `/api` path, and
 * `null` while that is loading or when `src` is `null`. `failed` turns true when the load failed, so
 * a caller can show its own stand-in (an image card's "[Image]" badge, say).
 */
export function useAuthedUrl(src: string | null): AuthedUrl {
  const passThrough = src === null || src.startsWith("data:");
  const [state, setState] = useState<{ src: string | null; url: string | null; failed: boolean }>({
    src: null,
    url: null,
    failed: false,
  });
  useEffect(() => {
    if (passThrough || src === null) return;
    let live = true;
    const load = async (): Promise<void> => {
      try {
        const url = await authedObjectUrl(src);
        if (live) setState({ src, url, failed: false });
      } catch {
        if (live) setState({ src, url: null, failed: true });
      }
    };
    void load();
    return () => {
      live = false;
    };
  }, [src, passThrough]);
  if (passThrough) return { url: src, failed: false };
  // A state left from an earlier `src` says nothing about this one.
  if (state.src !== src) return { url: null, failed: false };
  return { url: state.url, failed: state.failed };
}

/** Test helper: forget every cached URL. */
export function __resetAuthedUrls(): void {
  cache.clear();
}
