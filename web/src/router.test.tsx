import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

// The QR `collie pair` prints names `/settings?pair=<code>`. Settings became an index of four
// sections and the pairing form moved to System, so the index forwards (src/router.tsx, with the
// target from `pairLandingPath` in lib/nav.ts, which nav.test.ts pins). The forward is a router
// fact: the loader returns `replace(...)`, so Back does not land on the index and bounce forward
// again. The router is created at module scope from the document's own location, so each case
// sets the URL first and imports a fresh copy.
async function bootAt(path: string) {
  vi.resetModules();
  window.history.replaceState(null, "", "/");
  window.history.pushState(null, "", path);
  const { router } = await import("./router");
  await waitFor(() => expect(router.state.initialized).toBe(true));
  return router;
}

describe("router: the pairing forward", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("lands a scanned pairing link on System with the whole query intact", async () => {
    const router = await bootAt("/settings?h=badger&pair=ABCD2345");
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/system"));
    expect(router.state.location.search).toBe("?h=badger&pair=ABCD2345");
    expect(window.location.pathname).toBe("/settings/system");
  });

  it("replaces the entry, so there is no extra history step to bounce back through", async () => {
    const before = window.history.length;
    const router = await bootAt("/settings?pair=ABCD2345");
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/system"));
    // bootAt pushed exactly one entry (the scanned URL); the forward replaced it instead of adding one.
    expect(window.history.length).toBe(before + 1);
  });

  it("leaves Settings without a code as the index", async () => {
    const router = await bootAt("/settings");
    expect(router.state.location.pathname).toBe("/settings");
    expect(window.location.pathname).toBe("/settings");
  });
});
