import { describe, expect, it, vi } from "vitest";

import {
  AUTHENTIK_PING_PATH,
  AUTHENTIK_START_PATH,
  isCollieApiRequest,
  isProxyRedirectResponse,
  proxyAwareFetch,
  resolveProxyAuthEntry,
} from "./proxy-auth-redirect";

const BASE = "https://collie.example/pane/w1%3Ap1?s=demo";

describe("proxy auth redirect recovery", () => {
  it("recognises only same-origin Collie API requests", () => {
    expect(isCollieApiRequest("/api/snapshot", BASE)).toBe(true);
    expect(isCollieApiRequest("/api/pane/w1%3Ap1?lines=600", BASE)).toBe(true);
    expect(isCollieApiRequest("/settings", BASE)).toBe(false);
    expect(isCollieApiRequest("https://idp.example/api/snapshot", BASE)).toBe(false);
  });

  it("recognises manual opaque redirects and real redirect statuses, but not pane 304s", () => {
    expect(isProxyRedirectResponse({ type: "opaqueredirect", status: 0 } as Response)).toBe(true);
    expect(isProxyRedirectResponse(new Response(null, { status: 302 }))).toBe(true);
    expect(isProxyRedirectResponse(new Response(null, { status: 307 }))).toBe(true);
    expect(isProxyRedirectResponse(new Response(null, { status: 304 }))).toBe(false);
    expect(isProxyRedirectResponse(new Response(null, { status: 401 }))).toBe(false);
  });

  it("forces API fetches to manual redirects without changing successful responses", async () => {
    const ok = new Response("{}", { status: 200 });
    const nativeFetch = vi.fn(async () => ok) as unknown as typeof fetch;
    const onRedirect = vi.fn();
    const guarded = proxyAwareFetch(nativeFetch, onRedirect, () => BASE);

    await expect(guarded("/api/snapshot", { headers: { "x-test": "1" } })).resolves.toBe(ok);
    expect(nativeFetch).toHaveBeenCalledWith(
      "/api/snapshot",
      expect.objectContaining({ redirect: "manual", headers: { "x-test": "1" } }),
    );
    expect(onRedirect).not.toHaveBeenCalled();
  });

  it("turns an identity-proxy redirect into the 401 Collie's auth path already understands", async () => {
    const redirected = { type: "opaqueredirect", status: 0 } as Response;
    const nativeFetch = vi.fn(async () => redirected) as unknown as typeof fetch;
    const onRedirect = vi.fn();
    const guarded = proxyAwareFetch(nativeFetch, onRedirect, () => BASE);

    const response = await guarded("/api/snapshot");
    expect(response.status).toBe(401);
    expect(await response.text()).toMatch(/requires sign-in/);
    expect(onRedirect).toHaveBeenCalledTimes(1);
  });

  it("does not alter non-API fetches", async () => {
    const ok = new Response("ok", { status: 200 });
    const nativeFetch = vi.fn(async () => ok) as unknown as typeof fetch;
    const onRedirect = vi.fn();
    const guarded = proxyAwareFetch(nativeFetch, onRedirect, () => BASE);
    const init: RequestInit = { redirect: "follow" };

    await expect(guarded("/fonts/test.woff2", init)).resolves.toBe(ok);
    expect(nativeFetch).toHaveBeenCalledWith("/fonts/test.woff2", init);
    expect(onRedirect).not.toHaveBeenCalled();
  });

  it("enters Authentik directly when its standard same-origin outpost answers the ping", async () => {
    const nativeFetch = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const href = `${BASE}#tail`;

    const entry = await resolveProxyAuthEntry(nativeFetch, href);
    const url = new URL(entry, href);
    expect(nativeFetch).toHaveBeenCalledWith(
      AUTHENTIK_PING_PATH,
      expect.objectContaining({ cache: "no-store", credentials: "same-origin", redirect: "manual" }),
    );
    expect(url.pathname).toBe(AUTHENTIK_START_PATH);
    expect(url.searchParams.get("rd")).toBe(href);
  });

  it("falls back to the operator-owned /auth/ path when Authentik is not present", async () => {
    const missing = vi.fn(async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    const broken = vi.fn(async () => {
      throw new TypeError("network failed");
    }) as unknown as typeof fetch;

    await expect(resolveProxyAuthEntry(missing, BASE)).resolves.toBe("/auth/");
    await expect(resolveProxyAuthEntry(broken, BASE)).resolves.toBe("/auth/");
  });
});
