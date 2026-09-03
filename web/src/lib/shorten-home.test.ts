import { describe, expect, test } from "vitest";

import { shortenHome } from "./shorten-home";

describe("shortenHome", () => {
  test("a descendant of home collapses to a leading ~", () => {
    expect(shortenHome("/home/op/dev/collie", "/home/op")).toBe("~/dev/collie");
  });

  test("home itself collapses to a bare ~", () => {
    expect(shortenHome("/home/op", "/home/op")).toBe("~");
  });

  test("a path outside home is returned unchanged", () => {
    expect(shortenHome("/srv/data", "/home/op")).toBe("/srv/data");
  });

  test("a string-prefix match that is not a directory boundary is NOT shortened", () => {
    // /home/operator is not under /home/op, even though the string starts with it.
    expect(shortenHome("/home/operator/dev", "/home/op")).toBe("/home/operator/dev");
  });

  test("a trailing slash on home is tolerated", () => {
    expect(shortenHome("/home/op/dev", "/home/op/")).toBe("~/dev");
  });

  test("an empty home leaves the path unchanged", () => {
    expect(shortenHome("/home/op/dev", "")).toBe("/home/op/dev");
  });
});
