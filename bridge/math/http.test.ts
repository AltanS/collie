import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { crewRouteFor } from "../crew/forward.ts";
import { serveStatic } from "../server.ts";
import { mathGet, mathRemove, mathServeRoot, mathStart } from "./http.ts";
import type { MathPackStart, MathPackStatus, MathPackStore } from "./store.ts";

/** A store that answers what a case sets, and counts the starts. */
function fakeStore(state: { status: MathPackStatus; start?: MathPackStart; root?: string | null }) {
  let starts = 0;
  const store: MathPackStore = {
    status: async () => state.status,
    start: async () => {
      starts++;
      return state.start ?? { outcome: "downloading", status: { state: "downloading", received: 0, total: null } };
    },
    remove: async () => ({ state: "absent" }),
    serveRoot: () => state.root ?? null,
    settled: async () => undefined,
  };
  return { store, starts: () => starts };
}

describe("the math routes", () => {
  test("GET answers the status and starts nothing", async () => {
    const { store, starts } = fakeStore({ status: { state: "absent" } });
    const res = await mathGet(store);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ state: "absent" });
    expect(starts()).toBe(0);
  });

  test("POST is 202 while it downloads, 200 when ready, 409 when there is nothing to offer", async () => {
    const downloading = await mathStart(fakeStore({ status: { state: "absent" } }).store);
    expect(downloading.response.status).toBe(202);
    expect(downloading.attempt).toEqual({ status: 202, outcome: "downloading" });
    const ready: MathPackStatus = { state: "ready", version: "1.29.0", source: "store", bytes: 4 };
    expect((await mathStart(fakeStore({ status: ready, start: { outcome: "ready", status: ready } }).store)).response.status).toBe(200);
    const dev: MathPackStatus = { state: "unavailable", reason: "dev-build" };
    const refused = await mathStart(fakeStore({ status: dev, start: { outcome: "unavailable", status: dev } }).store);
    expect(refused.response.status).toBe(409);
    expect(await refused.response.json()).toEqual(dev);
  });

  test("DELETE answers the status after the remove, and its audit words carry no path", async () => {
    const removed = await mathRemove(fakeStore({ status: { state: "absent" } }).store);
    expect(removed.response.status).toBe(200);
    expect(removed.attempt).toEqual({ status: 200, outcome: "removed" });
  });
});

describe("/math/* is served from the store, else the build, else 404", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "collie-math-serve-"));
    mkdirSync(join(root, "math", "katex"), { recursive: true });
    writeFileSync(join(root, "math", "katex", "katex-abc.js"), "export {};\n");
    writeFileSync(join(root, "pack.json"), "{}");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("an engine file comes from the root the store names, immutable", async () => {
    const { store } = fakeStore({ status: { state: "absent" }, root });
    const served = mathServeRoot(store, "/math/katex/katex-abc.js");
    expect(served).toBe(root);
    const res = await serveStatic("/math/katex/katex-abc.js", null, served!);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toBe("export {};\n");
  });

  test("a file the pack lacks is a 404, never the app shell", async () => {
    const res = await serveStatic("/math/katex/missing-abc.js", null, root);
    expect(res.status).toBe(404);
  });

  test("no root, or a path with no extension, is a 404 before any file is looked at", () => {
    expect(mathServeRoot(fakeStore({ status: { state: "absent" } }).store, "/math/katex/katex-abc.js")).toBeNull();
    expect(mathServeRoot(fakeStore({ status: { state: "absent" }, root }).store, "/math/katex")).toBeNull();
    expect(mathServeRoot(fakeStore({ status: { state: "absent" }, root }).store, "/assets/x.js")).toBeNull();
  });
});

// The handlers live inside Bun.serve, so the gate levels and the crew wiring are asserted on the source,
// the way the Whistle routes are (bridge/server.test.ts).
describe("the server wires the math routes like the Whistle ones", () => {
  const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
  const block = (start: string): string => {
    const at = src.indexOf(start);
    expect(at).toBeGreaterThan(0);
    return src.slice(at, src.indexOf("\n      }\n", at));
  };

  test("the read needs the pairing token, the writes take the write gate, and both writes are audited", () => {
    const handler = block('if (pathname === "/api/math") {');
    expect(handler).toContain('const denied = guard(req, cfg, "read", pairingGate);');
    expect(handler).toContain('const denied = guard(req, cfg, "write", pairingGate);');
    expect(handler.indexOf('if (req.method === "GET")')).toBeLessThan(handler.indexOf('"write"'));
    expect(handler).toContain('"math.download"');
    expect(handler).toContain('"math.remove"');
  });

  test("it is not forwarded to a crew member, and reads no ?host=", () => {
    expect(crewRouteFor("/api/math")).toBeNull();
    const handler = block('if (pathname === "/api/math") {');
    expect(handler).not.toContain("target(");
    expect(handler).not.toMatch(/crewLead|searchParams/);
  });

  test("/math/* is answered before the static fallback, from the store's root", () => {
    const handler = block('if (pathname.startsWith("/math/")) {');
    expect(handler).toContain("mathServeRoot(mathPack, pathname)");
    expect(src.indexOf('if (pathname.startsWith("/math/")) {')).toBeLessThan(src.indexOf("// ── Static PWA (with SPA fallback)"));
  });
});
