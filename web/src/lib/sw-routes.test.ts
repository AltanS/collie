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

  it("keeps the denylist the SW installs to exactly these two rules", () => {
    expect(NAVIGATION_NETWORK_ONLY.map(String)).toEqual([
      String(/^\/api\//),
      String(/^\/auth(?:\/|$)/),
    ]);
  });
});
