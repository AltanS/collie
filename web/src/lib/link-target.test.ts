import { describe, expect, it } from "vitest";

import { linkTargetBeside, linkTargetParts, targetText } from "./link-target";

const beside = (label: string, href: string) => {
  const parts = linkTargetBeside(label, href);
  return parts === null ? null : targetText(parts);
};
const line = (href: string) => {
  const parts = linkTargetParts(href);
  return parts === null ? null : targetText(parts);
};

describe("linkTargetBeside: when the label is the address", () => {
  it.each([
    ["the same text", "https://ci.example/run/1", "https://ci.example/run/1"],
    ["a trailing slash more on the target", "https://ci.example", "https://ci.example/"],
    ["a trailing slash more on the label", "https://ci.example/", "https://ci.example"],
    ["no scheme in the label", "ci.example/run/1", "https://ci.example/run/1"],
    ["spaces around the label", "  https://ci.example/run/1 ", "https://ci.example/run/1"],
  ])("%s shows nothing beside it", (_name, label, href) => {
    expect(beside(label, href)).toBeNull();
  });

  it("shows nothing for a target that is not a web address", () => {
    expect(beside("click", "javascript:alert(1)")).toBeNull();
    expect(beside("mail me", "mailto:a@b.example")).toBeNull();
  });
});

describe("linkTargetBeside: when the label is not the address", () => {
  it("shows host and path without the scheme", () => {
    expect(beside("the CI run", "https://ci.example/run/123")).toBe("ci.example/run/123");
  });

  it("a label that looks like another address shows the real target", () => {
    expect(beside("https://good.com", "https://evil.example")).toBe("evil.example");
    expect(beside("good.com/login", "https://evil.example/login")).toBe("evil.example/login");
  });

  it("the other scheme in the label is a mismatch", () => {
    expect(beside("http://ci.example/a", "https://ci.example/a")).toBe("ci.example/a");
  });
});

describe("linkTargetParts", () => {
  it("keeps a short query and fragment", () => {
    expect(line("https://ci.example/run?id=4#log")).toBe("ci.example/run?id=4#log");
  });

  it("drops the query and fragment when the line would be long", () => {
    const href = `https://ci.example/runs/4821?token=${"a".repeat(60)}#top`;
    expect(line(href)).toBe("ci.example/runs/4821?…");
  });

  it("marks a dropped fragment with #…", () => {
    expect(line(`https://ci.example/runs/${"4821/".repeat(8)}#${"x".repeat(20)}`)).toMatch(/#…$/u);
  });

  it("marks a dropped query after a cut path too, and the line stays within the limit", () => {
    const shown = line(`https://docs.example.com/${"section/".repeat(12)}final-page?x=1`)!;
    expect(shown).toMatch(/…[^…]*final-page\?…$/u);
    expect(shown.length).toBeLessThanOrEqual(48);
  });

  it("gives the host and the rest apart, so the host is one piece", () => {
    expect(linkTargetParts("https://ci.example/run/123?a=1")).toEqual({ host: "ci.example", rest: "/run/123?a=1" });
    expect(linkTargetBeside("x", "https://ci.example")).toEqual({ host: "ci.example", rest: "" });
  });

  it("cuts a long path in the middle and keeps the host whole", () => {
    const href = `https://docs.example.com/${"section/".repeat(12)}final-page`;
    const shown = line(href)!;
    expect(shown.startsWith("docs.example.com/")).toBe(true);
    expect(shown).toContain("…");
    expect(shown.endsWith("final-page")).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(48);
  });

  it("never cuts a long host", () => {
    const host = `${"a".repeat(55)}.example.com`;
    const shown = line(`https://${host}/one/two/three/four/five/six/seven/eight/nine`)!;
    expect(shown.startsWith(`${host}/`)).toBe(true);
    expect(shown).toContain("…");
  });

  it("shows an international host in its ASCII form", () => {
    expect(line("https://аpple.com/id")).toBe("xn--pple-43d.com/id");
  });

  it("shows the real host and never the userinfo", () => {
    expect(line("https://good.com@evil.example/login")).toBe("evil.example/login");
    expect(line("https://good.com:secret@evil.example/")).toBe("evil.example");
  });

  it("keeps a port", () => {
    expect(line("http://bluefin:8788/x")).toBe("bluefin:8788/x");
  });

  it("is null for a target that is not a web address", () => {
    expect(line("file:///etc/passwd")).toBeNull();
    expect(line("nope")).toBeNull();
  });
});
