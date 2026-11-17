import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { __resetAuthedUrls, authedObjectUrl, useAuthedUrl } from "@/lib/authed-url";
import { server } from "@/test/setup";

// C5 of the calm-load survey: the hook's first state used to be `null` for every mount, even for a
// path whose object URL the page already held, so a cached picture cost one frame with no picture.
// These read the value of the FIRST render, not the one after the effect.

const path = (n: number) => `/api/blobs/${n.toString(16).padStart(64, "0")}`;

function bytes() {
  server.use(
    http.get("/api/blobs/:hash", () => new HttpResponse(new Uint8Array([1]), { headers: { "content-type": "image/png" } })),
  );
}

/** Mount the hook and record `url` on every render, so the first one can be told from the settled one. */
function mount(src: string | null) {
  const urls: (string | null)[] = [];
  const view = renderHook(() => {
    const out = useAuthedUrl(src);
    urls.push(out.url);
    return out;
  });
  return { urls, ...view };
}

describe("useAuthedUrl — the first render", () => {
  it("answers a path the page already resolved on the first render, with no effect in between", async () => {
    bytes();
    await authedObjectUrl(path(1));
    const { urls } = mount(path(1));
    expect(urls[0]).toMatch(/^blob:/);
    expect(urls.every((u) => u === urls[0])).toBe(true);
  });

  it("is null on the first render for a path nobody fetched, then the object URL", async () => {
    bytes();
    const { urls, result } = mount(path(2));
    expect(urls[0]).toBeNull();
    await waitFor(() => expect(result.current.url).toMatch(/^blob:/));
  });

  it("peeks the path it is given, so a changed path does not show the old picture", async () => {
    bytes();
    await authedObjectUrl(path(3));
    const { result, rerender } = renderHook(({ src }) => useAuthedUrl(src), { initialProps: { src: path(3) } });
    const first = result.current.url;
    expect(first).toMatch(/^blob:/);
    rerender({ src: path(4) });
    expect(result.current.url).toBeNull();
    await waitFor(() => expect(result.current.url).toMatch(/^blob:/));
    expect(result.current.url).not.toBe(first);
  });

  it("keeps nothing past the reset helper", async () => {
    bytes();
    await authedObjectUrl(path(5));
    __resetAuthedUrls();
    expect(mount(path(5)).urls[0]).toBeNull();
  });

  it("drops an evicted path from the peek along with its promise", async () => {
    bytes();
    for (let n = 100; n < 100 + 65; n++) await authedObjectUrl(path(n));
    // 65 loads past a cap of 64: the oldest is gone, the newest is there on the first render.
    expect(mount(path(100)).urls[0]).toBeNull();
    expect(mount(path(164)).urls[0]).toMatch(/^blob:/);
  });

  it("does not remember a failed load", async () => {
    server.use(http.get("/api/blobs/:hash", () => new HttpResponse("nope", { status: 404 })));
    await expect(authedObjectUrl(path(6))).rejects.toThrow();
    expect(mount(path(6)).urls[0]).toBeNull();
  });
});
