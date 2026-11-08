import { describe, expect, it } from "vitest";

import { readRegistryStatus } from "./registry-status";

// F11: the phone checks the host's status before it draws from it, as it checks every entry.
describe("readRegistryStatus", () => {
  const good = {
    fetchedAt: "2026-11-08T10:00:00.000Z",
    ageMs: 1200,
    generated: "2026-11-08T04:00:00.000Z",
    themes: [{ repo: "a/b" }],
    dropped: 2,
    fetching: false,
    error: "too-big",
  };

  it("keeps a well-formed status as it is", () => {
    expect(readRegistryStatus(good)).toEqual(good);
  });

  it("is undefined for a body that is not an object", () => {
    for (const body of [null, [], "x", 3]) expect(readRegistryStatus(body)).toBeUndefined();
  });

  it("gives a field of the wrong type its empty value", () => {
    expect(readRegistryStatus({ fetchedAt: 5, ageMs: -1, generated: {}, themes: "nope", dropped: 1.5, fetching: "yes" })).toEqual({
      fetchedAt: null,
      ageMs: null,
      generated: null,
      themes: [],
      dropped: 0,
      fetching: false,
    });
  });

  it("drops an error word it does not know, and an overlong address", () => {
    const status = readRegistryStatus({ ...good, error: "__proto__", address: "x".repeat(201) });
    expect(status).not.toHaveProperty("error");
    expect(status).not.toHaveProperty("address");
  });
});
