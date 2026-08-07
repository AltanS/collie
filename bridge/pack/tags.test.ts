import { describe, expect, test } from "bun:test";

import { herdTagFor } from "../sessions.ts";
import { packHerdTagFor } from "./tags.ts";

// The notification slot with a host dimension. Two properties, and the second is the load-bearing
// one: local tags do not move, and no peer tag can ever equal a local one.

describe("packHerdTagFor — this collie's own sessions", () => {
  test("is herdTagFor(), byte-for-byte — including the primary's bare tag", () => {
    expect(packHerdTagFor(undefined, true, "default")).toBe("collie:herd");
    expect(packHerdTagFor(undefined, true, "work")).toBe("collie:herd");
    expect(packHerdTagFor(undefined, false, "work")).toBe("collie:herd:work");
    for (const [primary, name] of [
      [true, "default"],
      [true, "anything"],
      [false, "demo"],
      [false, "collie-demo"],
    ] as const) {
      expect(packHerdTagFor(undefined, primary, name)).toBe(herdTagFor(primary, name));
    }
  });
});

describe("packHerdTagFor — a peer's sessions", () => {
  test("qualifies the base tag by host, and the session after it", () => {
    expect(packHerdTagFor("laptop", true, "default")).toBe("collie:herd@laptop");
    expect(packHerdTagFor("laptop", false, "work")).toBe("collie:herd@laptop:work");
  });

  test("a peer's primary tag never depends on what that session is named", () => {
    expect(packHerdTagFor("laptop", true, "anything")).toBe(packHerdTagFor("laptop", true, "default"));
  });

  test("two hosts never share a slot", () => {
    expect(packHerdTagFor("laptop", true, "default")).not.toBe(packHerdTagFor("desktop", true, "default"));
  });
});

describe("packHerdTagFor — the families cannot collide", () => {
  // The injectivity argument from tags.ts, as a test: a member id excludes `@` and `:`, so the
  // character after `collie:herd` discriminates. A session name may contain anything and still
  // cannot forge a peer tag, because it only ever appears after that discriminator.
  test("a local session named like a host does not forge that host's tag", () => {
    expect(packHerdTagFor(undefined, false, "@laptop")).toBe("collie:herd:@laptop");
    expect(packHerdTagFor(undefined, false, "@laptop")).not.toBe(packHerdTagFor("laptop", true, "default"));
    expect(packHerdTagFor(undefined, false, "@laptop:work")).not.toBe(packHerdTagFor("laptop", false, "work"));
  });

  test("every tag in a mixed pack is distinct", () => {
    const tags = [
      packHerdTagFor(undefined, true, "default"),
      packHerdTagFor(undefined, false, "work"),
      packHerdTagFor("laptop", true, "default"),
      packHerdTagFor("laptop", false, "work"),
      packHerdTagFor("desktop", true, "default"),
    ];
    expect(new Set(tags).size).toBe(tags.length);
  });
});
