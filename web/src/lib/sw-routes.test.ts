import { describe, expect, it } from "vitest";

import {
  NAVIGATION_NETWORK_ONLY,
  PROXY_AUTH_PATH,
  isNetworkOnlyNavigation,
} from "./sw-routes";

// These rules are the difference between an installed PWA that can reach its front door and one that
// is bricked behind a refused session, and the failure is silent in both directions: too narrow and
// the sign-in page is invisible, too wide and Collie's own deep links stop resolving offline. The
// regexes are what the service worker actually installs, so pin the contract here.
describe("service-worker navigation passthrough", () => {
  it("never answers the API from the precache", () => {
    expect(isNetworkOnlyNavigation("/api/snapshot")).toBe(true);
    expect(isNetworkOnlyNavigation("/api/pane/w1:p1/keys")).toBe(true);
  });

  it("passes the reserved proxy namespace to the network, with or without the slash", () => {
    expect(isNetworkOnlyNavigation("/auth")).toBe(true);
    expect(isNetworkOnlyNavigation("/auth/")).toBe(true);
    expect(isNetworkOnlyNavigation("/auth/sign-in")).toBe(true);
    expect(isNetworkOnlyNavigation("/auth/oidc/callback")).toBe(true);
  });

  // Workbox tests the denylist against `url.pathname + url.search` (verified in the vendored
  // workbox-routing/NavigationRoute.js `_match`), so these inputs carry their query string — a rule
  // anchored on a trailing slash passes every pathname-only test above and still bricks the app the
  // moment a proxy bounces you to `/auth?rd=…`, which is what Authelia and oauth2-proxy do.
  it("still passes through when the proxy appends a return-to query string", () => {
    expect(isNetworkOnlyNavigation("/auth?rd=%2F")).toBe(true);
    expect(isNetworkOnlyNavigation("/auth?rd=%2Fpane%2Fw1%3Ap1")).toBe(true);
    expect(isNetworkOnlyNavigation("/auth/?next=/settings")).toBe(true);
    expect(isNetworkOnlyNavigation("/api/snapshot?s=demo")).toBe(true);
  });

  // Cloudflare Access can't move off /cdn-cgi/access/, so the reservation has to come to it.
  it("passes Cloudflare Access's non-relocatable prefix to the network", () => {
    expect(isNetworkOnlyNavigation("/cdn-cgi/access/login")).toBe(true);
    expect(isNetworkOnlyNavigation("/cdn-cgi/access/callback?code=abc")).toBe(true);
  });

  it("does not leak a Collie route that merely carries a query string", () => {
    expect(isNetworkOnlyNavigation("/authors?x=1")).toBe(false);
    expect(isNetworkOnlyNavigation("/?s=collie-demo")).toBe(false);
    expect(isNetworkOnlyNavigation("/pane/w1:p1?s=demo")).toBe(false);
  });

  // The host param travels inside a proxy's return-to payload the moment a peer's deep link is the
  // thing you were bounced away from — same anchoring argument as above, one dimension out.
  it("still passes through when the return-to payload encodes a host param", () => {
    expect(isNetworkOnlyNavigation("/auth?rd=%2Fpane%2Fw1%3Fh%3Dbox2")).toBe(true);
    expect(isNetworkOnlyNavigation("/auth?rd=%2Fpane%2Fw1%3Ap1%3Fh%3Dbox2%26s%3Ddemo")).toBe(true);
    expect(isNetworkOnlyNavigation("/api/snapshot?host=box2")).toBe(true);
    // …and a peer's own deep link is still Collie's to answer offline.
    expect(isNetworkOnlyNavigation("/pane/w1%3Ap1?h=box2")).toBe(false);
    expect(isNetworkOnlyNavigation("/?h=box2&s=demo")).toBe(false);
  });

  // PACK_PROTOCOL.md §5: a browser never issues a pack request, so a browser must never be able to
  // cache one. Answering any of these from the precached app shell would hand a collie-to-collie
  // caller an HTML page.
  it("never answers the pack surface from the precache", () => {
    for (const path of [
      "/pack/v1/snapshot",
      "/pack/v1/snapshot?session=demo",
      "/pack/v1/pane/w1:p1",
      "/pack/v1/enroll",
      "/pack/v1/hello",
      "/pack/v1",
      "/pack/v1?x=1",
    ]) {
      expect(isNetworkOnlyNavigation(path)).toBe(true);
    }
  });

  it("does not claim routes that merely start with the pack prefix", () => {
    expect(isNetworkOnlyNavigation("/pack")).toBe(false);
    expect(isNetworkOnlyNavigation("/packages")).toBe(false);
    expect(isNetworkOnlyNavigation("/pack/v10/snapshot")).toBe(false);
  });

  it("still owns every Collie route, so deep links keep resolving offline", () => {
    for (const path of [
      "/",
      "/settings",
      "/pane/w1:p1",
      "/pane/w1:p1/history",
      "/space/w1",
    ]) {
      expect(isNetworkOnlyNavigation(path)).toBe(false);
    }
  });

  // A route merely STARTING with the reserved word is Collie's, not the proxy's: `/authors` must not
  // be handed to the network just because it shares five letters with `/auth`.
  it("does not leak a route that only shares the prefix", () => {
    expect(isNetworkOnlyNavigation("/authors")).toBe(false);
    expect(isNetworkOnlyNavigation("/apidocs")).toBe(false);
  });

  it("exports the reserved path the UI links to, ending in a slash", () => {
    expect(PROXY_AUTH_PATH).toBe("/auth/");
    expect(isNetworkOnlyNavigation(PROXY_AUTH_PATH)).toBe(true);
  });

  it("keeps the denylist the SW installs to exactly these rules", () => {
    expect(NAVIGATION_NETWORK_ONLY.map(String)).toEqual([
      String(/^\/api\//),
      String(/^\/auth(?:[/?]|$)/),
      String(/^\/cdn-cgi\//),
      String(/^\/pack\/v1(?:[/?]|$)/),
      String(/^\/standby(?:[/?]|$)/),
    ]);
  });

  // The standby door (PACK_PROTOCOL.md §18.15). On the bad day the phone's FIRST hit is an installed
  // service worker minted from the LEAD's origin, so a precached app shell here is the difference
  // between reaching the takeover page and staring at the UI of the collie that just died.
  it("passes the whole standby namespace to the network, query and all", () => {
    for (const path of ["/standby", "/standby/", "/standby/health", "/standby/takeover", "/standby?x=1"]) {
      expect(isNetworkOnlyNavigation(path)).toBe(true);
    }
    // A route that merely shares the prefix is Collie's, exactly as `/authors` is.
    expect(isNetworkOnlyNavigation("/standbyish")).toBe(false);
  });
});
