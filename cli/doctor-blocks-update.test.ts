// `blocksUpdate` cases that depend on more than one fact, kept beside cli/doctor.test.ts because
// that file sits at its size ceiling (scripts/test-file-size.test.ts). The other stamps are asserted
// where their branches are already tested.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { leadStore, member, T0 } from "../bridge/crew/fixtures.ts";
import { markerFor } from "../bridge/crew/staleness.ts";
import { doctorDeps, frontDoor, storeDrift } from "./doctor.ts";
import { capture, context, fakeExec, fakeFiles, HANDLER_FILE, STATE } from "./fakes.ts";

/** Collie's own root mount, live on :443 and proxying to this bridge. */
const SERVE_OK = JSON.stringify({
  TCP: { "443": { HTTPS: true } },
  Web: { "laptop.tail.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } },
});

function deps(files: Record<string, string>) {
  return doctorDeps({
    ctx: context(),
    io: capture(),
    files: fakeFiles(files),
    exec: fakeExec({
      answers: [
        ["tailscale status --json", { stdout: JSON.stringify({ CertDomains: ["laptop.tail.ts.net"] }) }],
        ["tailscale serve status --json", { stdout: SERVE_OK }],
      ],
    }),
  });
}

describe("front-door on a peer", () => {
  // The mapping listens on the serve port (:443), the peer binds COLLIE_PORT (:8787): the new
  // version starts beside it either way, so neither branch blocks the update.
  test("an unrecorded mapping is an error that does not block an update", () => {
    const f = frontDoor(deps({}), "peer");
    expect(f.status).toBe("error");
    expect(f.detail).toContain("still proxies to");
    expect(f.blocksUpdate).toBeUndefined();
  });

  test("nor does a recorded one, which the peer's boot tears down", () => {
    const f = frontDoor(deps({ [HANDLER_FILE]: "https:443|laptop.tail.ts.net:443|http://127.0.0.1:8787" }), "peer");
    expect(f.status).toBe("error");
    expect(f.blocksUpdate).toBeUndefined();
  });
});

describe("store-drift", () => {
  // The marker was written when the lead had no peers; the store now has one.
  const store = leadStore({ peers: [member({ memberId: "laptop" })] });
  const files = { [join(STATE, "crew-runtime.json")]: JSON.stringify(markerFor(leadStore(), T0, 42)) };

  test("blocks an update on a packaged install, where no update restarts anything (ADR 0050)", () => {
    const f = storeDrift(deps(files), store, { kind: "packaged" });
    expect(f.status).toBe("error");
    expect(f.blocksUpdate).toBe(true);
  });

  test("does not elsewhere: the update's own restart cures it", () => {
    for (const install of [{ kind: "binary" } as const, { kind: "linked-clone", alsoLayout: false } as const]) {
      const f = storeDrift(deps(files), store, install);
      expect(f.status).toBe("error");
      expect(f.blocksUpdate).toBeUndefined();
    }
  });
});
