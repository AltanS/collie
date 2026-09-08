import { describe, expect, test } from "bun:test";

import { deriveConfigRoot, discoverSessionSockets, herdrSessionsIn } from "./sessions.ts";

// Herdr's session layout, moved here from `bridge/sessions.ts` with the `listSessions` capability
// (M22/02): the shape `<root>/herdr.sock` + `<root>/sessions/<name>/herdr.sock` is this adapter's,
// so the tests for it live beside it. Both listers are injected, so nothing here touches a disk.

describe("deriveConfigRoot", () => {
  test("a default-session socket's config root is its own directory", () => {
    expect(deriveConfigRoot("/home/u/.config/herdr/herdr.sock")).toBe("/home/u/.config/herdr");
  });

  test("a named-session socket's config root is the prefix before /sessions/", () => {
    expect(deriveConfigRoot("/home/u/.config/herdr/sessions/demo/herdr.sock")).toBe(
      "/home/u/.config/herdr",
    );
  });
});

describe("discoverSessionSockets", () => {
  const root = "/cfg/herdr";

  test("finds the default socket plus each sessions/<name>/herdr.sock that exists", () => {
    const present = new Set([
      `${root}/herdr.sock`,
      `${root}/sessions/alpha/herdr.sock`,
      // 'zeta' dir exists but its socket does not (session cleanly stopped → socket removed).
    ]);
    const found = discoverSessionSockets(
      root,
      (dir) => (dir === `${root}/sessions` ? ["alpha", "zeta"] : []),
      (p) => present.has(p),
    );
    expect(found).toEqual([
      { name: "default", socketPath: `${root}/herdr.sock` },
      { name: "alpha", socketPath: `${root}/sessions/alpha/herdr.sock` },
    ]);
  });

  test("omits the default when its socket is absent (default session not running)", () => {
    const present = new Set([`${root}/sessions/only/herdr.sock`]);
    const found = discoverSessionSockets(
      root,
      () => ["only"],
      (p) => present.has(p),
    );
    expect(found).toEqual([{ name: "only", socketPath: `${root}/sessions/only/herdr.sock` }]);
  });

  test("returns nothing when no sockets exist", () => {
    expect(discoverSessionSockets(root, () => [], () => false)).toEqual([]);
  });
});

describe("herdrSessionsIn", () => {
  const root = "/cfg/herdr";

  test("a socket path IS the endpoint the port asks for", () => {
    const present = new Set([`${root}/herdr.sock`, `${root}/sessions/work/herdr.sock`]);
    expect(herdrSessionsIn(root, () => ["work"], (p) => present.has(p))).toEqual([
      { name: "default", endpoint: `${root}/herdr.sock` },
      { name: "work", endpoint: `${root}/sessions/work/herdr.sock` },
    ]);
  });

  test("an empty answer is an empty LIST, the refusal is the adapter's, never this function's", () => {
    expect(herdrSessionsIn(root, () => [], () => false)).toEqual([]);
  });
});
