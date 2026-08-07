import { homePath, panePath } from "./nav";

describe("panePath", () => {
  it("URL-encodes the colon in a pane id", () => {
    expect(panePath("wE:p2")).toBe("/pane/wE%3Ap2");
  });

  it("leaves a colon-free id alone", () => {
    expect(panePath("abc")).toBe("/pane/abc");
  });

  it("round-trips back to the original pane id via decodeURIComponent", () => {
    const id = "w1:p1";
    const encoded = panePath(id).replace("/pane/", "");
    expect(decodeURIComponent(encoded)).toBe(id);
  });

  it("omits both params on the lead's primary session (undefined/blank)", () => {
    expect(panePath("w1:p1", undefined)).toBe("/pane/w1%3Ap1");
    expect(panePath("w1:p1", {})).toBe("/pane/w1%3Ap1");
    expect(panePath("w1:p1", { host: "  ", session: "  " })).toBe("/pane/w1%3Ap1");
  });

  it("carries a named session as ?s= (encoded)", () => {
    expect(panePath("w1:p1", { session: "collie-demo" })).toBe("/pane/w1%3Ap1?s=collie-demo");
    expect(panePath("abc", { session: "a b" })).toBe("/pane/abc?s=a%20b");
  });

  it("carries a host as ?h=, always before ?s=", () => {
    expect(panePath("w1:p1", { host: "badger" })).toBe("/pane/w1%3Ap1?h=badger");
    expect(panePath("w1:p1", { host: "badger", session: "collie-demo" })).toBe(
      "/pane/w1%3Ap1?h=badger&s=collie-demo",
    );
  });
});

describe("homePath", () => {
  it("is '/' on the lead's primary session", () => {
    expect(homePath()).toBe("/");
    expect(homePath(undefined)).toBe("/");
    expect(homePath({})).toBe("/");
    expect(homePath({ session: "" })).toBe("/");
  });

  it("carries a named session as ?s=", () => {
    expect(homePath({ session: "collie-demo" })).toBe("/?s=collie-demo");
  });

  it("carries a host as ?h=, before ?s=", () => {
    expect(homePath({ host: "badger" })).toBe("/?h=badger");
    expect(homePath({ host: "badger", session: "collie-demo" })).toBe("/?h=badger&s=collie-demo");
  });
});
