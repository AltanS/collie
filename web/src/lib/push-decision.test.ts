import { describe, expect, test } from "vitest";

import { decidePush, tagFor } from "@/lib/push-decision";

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
});

describe("tagFor", () => {
  test("per-pane vs generic slot", () => {
    expect(tagFor("p1")).toBe("collie:p1");
    expect(tagFor(undefined)).toBe("collie");
  });
});
