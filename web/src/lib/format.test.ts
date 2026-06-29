import { initials, shortCwd } from "./format";

describe("shortCwd", () => {
  it("collapses /home/<user> to ~", () => {
    expect(shortCwd("/home/altan/projects/collie")).toBe("~/projects/collie");
  });

  it("collapses /Users/<user> (macOS) to ~", () => {
    expect(shortCwd("/Users/altan/code/app")).toBe("~/code/app");
  });

  it("collapses /var/home/<user> (Fedora Atomic / bluefin) to ~", () => {
    expect(shortCwd("/var/home/altan/anchorgenius")).toBe("~/anchorgenius");
  });

  it("collapses the home dir itself to ~", () => {
    expect(shortCwd("/var/home/altan")).toBe("~");
  });

  it("leaves paths outside home untouched", () => {
    expect(shortCwd("/etc/nginx/nginx.conf")).toBe("/etc/nginx/nginx.conf");
  });

  it("does not truncate short paths", () => {
    const out = shortCwd("/home/altan/x");
    expect(out).toBe("~/x");
    expect(out).not.toContain("…");
  });

  it("truncates a long tail with a leading ellipsis, respecting max", () => {
    const out = shortCwd("/var/home/altan/" + "x".repeat(40)); // default max = 32
    expect(out.startsWith("…")).toBe(true);
    expect(out).toHaveLength(32);
    expect(out.endsWith("x")).toBe(true);
    // The home "~" got truncated away — we keep the most-specific tail.
    expect(out).not.toContain("~");
  });

  it("honours a custom max", () => {
    const out = shortCwd("/home/altan/a/very/long/nested/path", 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.startsWith("…")).toBe(true);
  });
});

describe("initials", () => {
  it("takes the first two letters, uppercased", () => {
    expect(initials("claude")).toBe("CL");
    expect(initials("codex")).toBe("CO");
  });

  it("ignores non-alphanumerics", () => {
    expect(initials("a-b-c")).toBe("AB");
    expect(initials("@gpt!")).toBe("GP");
  });

  it("falls back to AI when there is nothing usable", () => {
    expect(initials("")).toBe("AI");
    expect(initials("!!!")).toBe("AI");
  });

  it("handles a single-character name", () => {
    expect(initials("x")).toBe("X");
  });
});
