import { describe, expect, test } from "vitest";

import { decidePush, hostSlot, notificationPath, tagFor } from "@/lib/push-decision";
import { scopeSearch } from "@/lib/scope";

describe("decidePush", () => {
  test("a clear retracts the slot regardless of client visibility", () => {
    const expected = { kind: "clear", tag: "collie:herd" };
    expect(decidePush({ type: "clear", tag: "collie:herd" }, false)).toEqual(expected);
    expect(decidePush({ type: "clear", tag: "collie:herd" }, true)).toEqual(expected);
  });

  test("suppresses a show when a Collie tab is visible", () => {
    expect(decidePush({ title: "claude needs you", tag: "collie:herd" }, true)).toEqual({
      kind: "suppress",
    });
  });

  test("shows with the bridge-provided tag, renotify, and deep-link paneId", () => {
    expect(
      decidePush(
        {
          title: "2 agents need you",
          body: "claude, codex",
          tag: "collie:herd",
          renotify: true,
          data: { paneId: "p1" },
        },
        false,
      ),
    ).toEqual({
      kind: "show",
      title: "2 agents need you",
      body: "claude, codex",
      tag: "collie:herd",
      paneId: "p1",
      renotify: true,
    });
  });

  test("falls back to a per-pane tag, default title, empty body, and renotify off", () => {
    expect(decidePush({ data: { paneId: "test" } }, false)).toEqual({
      kind: "show",
      title: "Collie",
      body: "",
      tag: "collie:test",
      paneId: "test",
      renotify: false,
    });
  });

  test("a push with no paneId and no tag shares the generic 'collie' slot", () => {
    expect(decidePush({ title: "hi" }, false)).toMatchObject({
      kind: "show",
      tag: "collie",
      paneId: undefined,
    });
  });

  test("carries a settings target through so the tap can route there", () => {
    expect(
      decidePush(
        {
          title: "Collie 0.12.0 available",
          body: "collie-ctl.sh update",
          data: { target: "settings" },
        },
        false,
      ),
    ).toMatchObject({
      kind: "show",
      title: "Collie 0.12.0 available",
      target: "settings",
      paneId: undefined,
    });
  });

  test("carries a peer's host through to the show decision, for the deep-link", () => {
    expect(
      decidePush(
        {
          title: "claude needs you",
          tag: "collie:herd@box2",
          data: { paneId: "w1:p1", host: "box2", session: "demo" },
        },
        false,
      ),
    ).toMatchObject({ kind: "show", tag: "collie:herd@box2", paneId: "w1:p1", host: "box2", session: "demo" });
  });

  test("a lead push carries no host — the pre-pack decision, unchanged", () => {
    const decision = decidePush({ title: "claude needs you", data: { paneId: "w1:p1" } }, false);
    expect((decision as { host?: string }).host).toBeUndefined();
  });

  // The only new way to strand a notification forever: a retraction computing a different slot than
  // the render did leaves it on the lock screen with nothing left that can ever close it.
  test("a clear resolves the same host-qualified slot its render produced", () => {
    const data = { paneId: "w1:p1", host: "box2" };
    const shown = decidePush({ title: "claude needs you", data }, false);
    const cleared = decidePush({ type: "clear", data }, true);
    expect(cleared).toEqual({ kind: "clear", tag: (shown as { tag: string }).tag });
    expect(cleared).toEqual({ kind: "clear", tag: "collie@box2:w1:p1" });
    // …and the bridge-supplied tag still wins over the fallback, in both directions.
    expect(decidePush({ type: "clear", tag: "collie:herd@box2", data }, false)).toEqual({
      kind: "clear",
      tag: "collie:herd@box2",
    });
  });

  test("an agent push carries no target (defaults to the pane deep-link path)", () => {
    const decision = decidePush({ title: "claude needs you", data: { paneId: "p1" } }, false);
    expect(decision).toMatchObject({ kind: "show", paneId: "p1" });
    expect((decision as { target?: string }).target).toBeUndefined();
  });
});

describe("tagFor", () => {
  test("per-pane vs generic slot", () => {
    expect(tagFor("p1")).toBe("collie:p1");
    expect(tagFor(undefined)).toBe("collie");
  });

  // Two machines' identical pane ids must not coalesce into one slot, where a peer's alert would
  // silently replace the lead's.
  test("a peer's fallback slot is host-qualified; the lead's is untouched", () => {
    expect(tagFor("p1", "box2")).toBe("collie@box2:p1");
    expect(tagFor(undefined, "box2")).toBe("collie@box2");
    expect(tagFor("p1", undefined)).toBe("collie:p1");
    expect(tagFor("p1", "box2")).not.toBe(tagFor("p1", "box3"));
  });
});

// The frontend half of bridge/pack/tags.ts. The bridge writes the tag on a render and this file
// re-derives it on a fallback and on a retraction, so the two derivations must agree by
// construction, not by two string templates that happen to match today.
describe("hostSlot", () => {
  test("reproduces the bridge's pack herd slots exactly", () => {
    expect(hostSlot("collie:herd")).toBe("collie:herd"); // the lead's own — must never move
    expect(hostSlot("collie:herd", "laptop")).toBe("collie:herd@laptop");
    expect(`${hostSlot("collie:herd", "laptop")}:demo`).toBe("collie:herd@laptop:demo");
  });

  // The injectivity argument from bridge/pack/tags.ts, as a test: a member id can hold neither `@`
  // nor `:`, so the character after the base discriminates a peer's slot from a local session's.
  test("a local session cleverly named like a host cannot collide with that host's slot", () => {
    expect(`${hostSlot("collie:herd")}:@laptop`).not.toBe(hostSlot("collie:herd", "laptop"));
  });
});

describe("notificationPath — where a tap lands", () => {
  test("a peer's pane deep-links to that machine, in the canonical param order", () => {
    expect(notificationPath({ paneId: "w1:p1", host: "box2", session: "demo" })).toBe(
      "/pane/w1%3Ap1?h=box2&s=demo",
    );
    expect(notificationPath({ paneId: "w1:p1", host: "box2" })).toBe("/pane/w1%3Ap1?h=box2");
  });

  // The whole backward-compatibility story in one assertion: nothing about a lead-only pack changed.
  test("the lead emits today's bytes — no host param anywhere", () => {
    expect(notificationPath({ paneId: "w1:p1" })).toBe("/pane/w1%3Ap1");
    expect(notificationPath({ paneId: "w1:p1", session: "demo" })).toBe("/pane/w1%3Ap1?s=demo");
    expect(notificationPath({})).toBe("/");
    expect(notificationPath({ paneId: "test" })).toBe("/"); // the push-test payload
  });

  test("an update notification routes to settings, unscoped", () => {
    expect(notificationPath({ target: "settings", host: "box2" })).toBe("/settings");
  });

  // sw.ts compares the URL it builds against an open client's URL (`client.url !== url`) and
  // navigates when they differ. A differently-ordered but semantically identical query would make
  // every tap on an already-open pane re-navigate it, so the SW must not have its own builder — this
  // pins that the query half IS scopeSearch's output.
  test("the query is lib/scope's, byte for byte — no second builder in the SW", () => {
    for (const scope of [
      {},
      { session: "demo" },
      { host: "box2" },
      { host: "box2", session: "demo" },
      { host: "a b", session: "c&d" },
    ]) {
      expect(notificationPath({ paneId: "w1:p1", ...scope })).toBe(
        `/pane/w1%3Ap1${scopeSearch(scope)}`,
      );
    }
  });
});
