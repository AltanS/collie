import { describe, expect, test } from "bun:test";

import { herdTagFor } from "../sessions.ts";
import { crewHerdTagFor } from "./tags.ts";

// The notification slot with a host dimension. Two properties, and the second is the load-bearing
// one: local tags do not move, and no peer tag can ever equal a local one.

describe("crewHerdTagFor — this collie's own sessions", () => {
  test("is herdTagFor(), byte-for-byte — including the primary's bare tag", () => {
    expect(crewHerdTagFor(undefined, true, "default")).toBe("collie:herd");
    expect(crewHerdTagFor(undefined, true, "work")).toBe("collie:herd");
    expect(crewHerdTagFor(undefined, false, "work")).toBe("collie:herd:work");
    for (const [primary, name] of [
      [true, "default"],
      [true, "anything"],
      [false, "demo"],
      [false, "collie-demo"],
    ] as const) {
      expect(crewHerdTagFor(undefined, primary, name)).toBe(herdTagFor(primary, name));
    }
  });
});

describe("crewHerdTagFor — a peer's sessions", () => {
  test("qualifies the base tag by host, and the session after it", () => {
    expect(crewHerdTagFor("laptop", true, "default")).toBe("collie:herd@laptop");
    expect(crewHerdTagFor("laptop", false, "work")).toBe("collie:herd@laptop:work");
  });

  test("a peer's primary tag never depends on what that session is named", () => {
    expect(crewHerdTagFor("laptop", true, "anything")).toBe(crewHerdTagFor("laptop", true, "default"));
  });

  test("two hosts never share a slot", () => {
    expect(crewHerdTagFor("laptop", true, "default")).not.toBe(crewHerdTagFor("desktop", true, "default"));
  });
});

describe("crewHerdTagFor — the families cannot collide", () => {
  // The injectivity argument from tags.ts, as a test: a member id excludes `@` and `:`, so the
  // character after `collie:herd` discriminates. A session name may contain anything and still
  // cannot forge a peer tag, because it only ever appears after that discriminator.
  test("a local session named like a host does not forge that host's tag", () => {
    expect(crewHerdTagFor(undefined, false, "@laptop")).toBe("collie:herd:@laptop");
    expect(crewHerdTagFor(undefined, false, "@laptop")).not.toBe(crewHerdTagFor("laptop", true, "default"));
    expect(crewHerdTagFor(undefined, false, "@laptop:work")).not.toBe(crewHerdTagFor("laptop", false, "work"));
  });

  test("every tag in a mixed crew is distinct", () => {
    const tags = [
      crewHerdTagFor(undefined, true, "default"),
      crewHerdTagFor(undefined, false, "work"),
      crewHerdTagFor("laptop", true, "default"),
      crewHerdTagFor("laptop", false, "work"),
      crewHerdTagFor("desktop", true, "default"),
    ];
    expect(new Set(tags).size).toBe(tags.length);
  });
});
